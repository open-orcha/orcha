/**
 * The live container snapshot as React context: initial fetch + 3s poll +
 * the D6 sub-second event stream (EventSource with a since_ts cursor and
 * burst coalescing — port of data.js start/startEventStream). Also the
 * acting-human persistence (app.js actingHuman/setActingHuman) and the
 * legacy attention helpers (attnItems / autLevel, #367 autonomy-gated cards).
 * V2: the canonical "Needs you" definition is state/attention.ts
 * (selectAttention/useAttention); attnItems stays exported for back-compat.
 * The provider also exposes connection freshness (lastOkAt / connection /
 * stale) so the shell never shows stale data as live (GAP-03).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchSnapshot } from "../api/client";
import { applyContainerIcons } from "../cloud/projects/projectIcons";
import { refreshProjectsIfWatched } from "./projects";
import { ensureCidInLocation, installCidLinkInterceptor, registerScope, resolveCidScope } from "../lib/scope";
import { extensions, type Identity } from "../extensions";
import type { Agent, OrchaRequest, Snapshot, Task } from "../types";
import { selectAttention } from "./attention";
import { registerTestReset } from "../lib/testResets";

/** V2 (arch §5): how fresh the snapshot on screen is. "live" = event stream
 *  open and the last refresh succeeded; "polling" = stream down but the 3 s
 *  poll succeeds; "reconnecting" = the latest refresh failed but the last good
 *  data is recent; "offline" = no successful refresh for > STALE_MS (or never). */
export type Connection = "live" | "polling" | "reconnecting" | "offline";
export const STALE_MS = 10_000;
/** A snapshot GET that has not answered after this long is aborted (QA: hung
 *  backends must not pile up one request per poll tick). */
export const SNAPSHOT_TIMEOUT_MS = 15_000;
/** An identity provider that has not settled after this long is treated as
 *  UNVERIFIED: the project shows read-only (never fail-open to a guessed
 *  human) and the ask is retried with backoff (IDENTITY_RETRY_MS). */
export const IDENTITY_TIMEOUT_MS = 10_000;
export const IDENTITY_RETRY_MS = [15_000, 30_000, 60_000];
/** The FIRST snapshot is held back until identity settles (or this grace
 *  passes), so the first paint never shows "–" counts and disabled actions
 *  that flip a moment later (and tests never race /api/me). */
export const IDENTITY_GRACE_MS = 1_500;
/** PS-16: a settled identity is re-checked this often (and on window focus,
 *  and right after a write is refused for a role/membership reason), so a live
 *  demotion/promotion flips the open UI within one poll instead of on reload. */
export const IDENTITY_RECHECK_MS = 15_000;
/** Window event a refused write dispatches (api/client.ts) to ask for an
 *  immediate identity re-check. */
export const IDENTITY_STALE_EVENT = "orcha:identity-stale";

/** Stable comparison key for an identity (the fields that gate affordances). */
function identityKey(id: Identity | null, trusted: boolean): string {
  if (!id) return (trusted ? "T" : "F") + "|-";
  const g = Array.isArray(id.grants) ? [...id.grants].sort().join(",") : "";
  return [trusted ? "T" : "F", id.agent_id ?? "", id.member_role ?? "", g].join("|");
}
/** Parity r2 (e2e-scope-live): once the backend has ANSWERED the snapshot
 *  with a 4xx (403 not a member / 404 unknown project), re-asking every 3 s
 *  cannot change the answer. The background poll and the event-stream
 *  reconnect back off to this interval; an explicit refresh() (Retry, a
 *  mutation) still runs immediately, so an invite accepted later recovers. */
export const ANSWERED_BACKOFF_MS = 30_000;

export interface SnapshotCtx {
  snap: Snapshot | null;
  cid: string | null;
  multi: boolean; // multi-container stack (lib/scope) — drives ?cid= propagation
  identity: Identity | null; // extensions.identity result (open default: null)
  /** true while an identity provider exists and has not answered for this cid
   *  — nobody may act (and no attention is counted) until it settles. */
  identityPending: boolean;
  /** /api/me said the sign-in is verified (trusted proxy lane). With a null
   *  identity this is the honest viewer (non-member) state. */
  identityTrusted: boolean;
  /** the identity provider timed out (or errored without a verdict): the
   *  viewer is shown read-only while it retries. Never set in open builds. */
  identityUnverified: boolean;
  /** ask the identity provider again now (the "Retry" affordance). */
  retryIdentity: () => void;
  error: string | null;
  /** What the last snapshot failure MEANS (null while the last refresh
   *  succeeded): a 401/403/400/404 is an ANSWER from a reachable backend, never
   *  "offline" (brief §3: missing ≠ disconnected ≠ unknown). */
  errorKind: SnapshotErrorKind;
  /** the HTTP status of the last snapshot failure (null = none / no HTTP answer) */
  errorStatus: number | null;
  /** the server's detail for that failure, as plain text (e.g. "not a member of this project") */
  errorDetail: string | null;
  refresh: () => Promise<void>;
  bump: number; // increments every applied refresh (for effects keyed to polls)
  lastOkAt: number | null; // epoch ms of the last successful snapshot refresh
  connection: Connection;
  stale: boolean; // no successful refresh for > STALE_MS while data is on screen
  /** SH-130: epoch ms the CURRENT failure streak started (null while the last
   *  refresh succeeded). A project list fetched before this proves nothing
   *  about whether Orcha is reachable now. */
  errorSince?: number | null;
  /** SH-130: epoch ms of the last success that ENDED a failure streak — side
   *  panels (notifications) re-load on it instead of waiting for their timer. */
  recoveredAt?: number | null;
}

/**
 * What a snapshot failure MEANS (pure, tested). Takes the provider's error
 * string ("/api/containers/<cid> → 403", the legacy message shape) and/or the
 * HTTP status the fetch error carried:
 *   forbidden — 401/403: Orcha answered; you just aren't a member
 *   not_found — 400/404/422: unknown / removed / malformed project id
 *   server    — 5xx (or another status): Orcha answered, the project didn't load
 *   network   — no HTTP answer at all (the real "can't reach Orcha")
 */
export type SnapshotErrorKind = "forbidden" | "not_found" | "server" | "network" | null;
export function snapshotErrorKind(error: string | null | undefined, status?: number | null): SnapshotErrorKind {
  if (!error && status == null) return null;
  let st = typeof status === "number" && status > 0 ? status : null;
  if (st == null) {
    const m = /\u2192\s*(\d{3})\b/.exec(error || "");
    if (m) st = Number(m[1]);
  }
  if (st == null) return "network";
  if (st === 401 || st === 403) return "forbidden";
  if (st === 400 || st === 404 || st === 422) return "not_found";
  // SH-130: 502 / 504 are a gateway (dev proxy, Caddy) saying the Orcha backend
  // itself didn't answer — that is "can't reach Orcha", not "this project is down".
  if (st === 502 || st === 504) return "network";
  return "server";
}
/** A failure kind that proves the backend is reachable (it answered 4xx). */
export function isAnsweredKind(k: SnapshotErrorKind): boolean {
  return k === "forbidden" || k === "not_found";
}

/** Pure connection classifier (unit-tested) — never reports "live" on failure. */
export function classifyConnection(
  o: { error: string | null; lastOkAt: number | null; streamOpen: boolean; now: number },
): { connection: Connection; stale: boolean } {
  const stale = o.lastOkAt != null && o.now - o.lastOkAt > STALE_MS;
  if (o.lastOkAt == null) return { connection: o.error ? "offline" : "polling", stale: false };
  if (o.error) return { connection: stale ? "offline" : "reconnecting", stale };
  if (stale) return { connection: "reconnecting", stale };
  return { connection: o.streamOpen ? "live" : "polling", stale };
}

const Ctx = createContext<SnapshotCtx>({
  snap: null,
  cid: null,
  multi: false,
  identity: null,
  identityPending: false,
  identityTrusted: false,
  identityUnverified: false,
  retryIdentity: () => {},
  error: null,
  errorKind: null,
  errorStatus: null,
  errorDetail: null,
  refresh: async () => {},
  bump: 0,
  lastOkAt: null,
  connection: "polling",
  stale: false,
  errorSince: null,
  recoveredAt: null,
});

export function SnapshotProvider({ children, pollMs = 3000 }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [cid, setCid] = useState<string | null>(null);
  const [multi, setMulti] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  // Pending from the very first render when a provider is registered, so no
  // frame ever shows a fallback human as the actor (QA: no impersonation).
  const [identityPending, setIdentityPending] = useState<boolean>(() => {
    const p = !!extensions.identity;
    _setActingAuth({ pending: p, trusted: false });
    return p;
  });
  const [identityTrusted, setIdentityTrusted] = useState(false);
  const [identityUnverified, setIdentityUnverified] = useState(false);
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [errorSince, setErrorSince] = useState<number | null>(null);
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null);
  const failingRef = useRef(false); // the latest applied refresh failed
  const [streamOpen, setStreamOpen] = useState(false);
  const [staleNow, setStaleNow] = useState(false); // flips only when freshness crosses STALE_MS
  const [cidResolved, setCidResolved] = useState(false); // first resolve attempt done
  const cidRef = useRef<string | null>(null);
  const multiRef = useRef(false);
  // QA: responses can land out of order (3 s poll, SSE-coalesced refresh and
  // every post-mutation `await refresh()` race). Only the NEWEST request that
  // settles is applied; an older response (success or failure) that lands
  // after a newer one is dropped.
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  // true while the latest applied refresh was an answered 4xx (see ANSWERED_BACKOFF_MS)
  const answeredRef = useRef(false);

  // FEATURE 1: identity seam — when a downstream registers extensions.identity
  // (its /api/me), ask it once per resolved cid (re-ask on cid change / retry).
  // The ask starts the moment the cid resolves (in parallel with the first
  // snapshot GET), and that FIRST snapshot is published only once identity
  // settles or IDENTITY_GRACE_MS passes — so the first paint never shows "–"
  // counts and disabled actions that flip a tick later. The result is
  // published both on the context and into the module-level acting slot so
  // legacy actingHuman(snap) callers transparently inherit it.
  // Definite failures fail open (self-host); a TIMEOUT is no verdict →
  // UNVERIFIED (read-only, never a guessed actor) + retry with backoff.
  const identityReq = useRef(0);
  const identityFails = useRef(0); // consecutive no-verdict attempts (backoff index)
  const unverifiedRef = useRef(false);
  const identityTimers = useRef<{ guard: ReturnType<typeof setTimeout> | null; retry: ReturnType<typeof setTimeout> | null }>({ guard: null, retry: null });
  const identityRun = useRef<{ key: string; done: Promise<void> } | null>(null);
  const attemptRef = useRef(0);
  const aliveRef = useRef(true);
  const retryIdentity = useCallback(() => setIdentityAttempt((n) => n + 1), []);
  const clearIdentityTimers = () => {
    const t = identityTimers.current;
    if (t.guard) clearTimeout(t.guard);
    if (t.retry) clearTimeout(t.retry);
    identityTimers.current = { guard: null, retry: null };
  };
  const runIdentity = useCallback((forCid: string | null, attempt: number): Promise<void> => {
    const provider = extensions.identity;
    if (!provider) return Promise.resolve();
    const key = String(forCid) + "#" + attempt;
    if (identityRun.current?.key === key) return identityRun.current.done;
    clearIdentityTimers();
    const req = ++identityReq.current;
    // A retry while UNVERIFIED stays read-only (no flicker back to "resolving").
    if (!unverifiedRef.current) {
      setIdentityPending(true);
      _setActingAuth({ pending: true, trusted: false });
    }
    let settled = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((res) => { resolveDone = res; });
    const live = () => aliveRef.current && identityReq.current === req;
    const apply = (id: Identity | null, trusted: boolean) => {
      if (settled) return;
      settled = true;
      resolveDone();
      if (!live()) return; // stale (cid changed underneath / unmounted)
      clearIdentityTimers();
      identityFails.current = 0;
      unverifiedRef.current = false;
      setIdentity(id);
      setIdentityTrusted(trusted);
      setIdentityPending(false);
      setIdentityUnverified(false);
      _setActingIdentity(id);
      _setActingAuth({ pending: false, trusted });
    };
    const unverified = () => {
      if (settled) return;
      settled = true;
      resolveDone();
      if (!live()) return;
      clearIdentityTimers();
      unverifiedRef.current = true;
      setIdentity(null);
      setIdentityTrusted(false);
      setIdentityPending(false);
      setIdentityUnverified(true);
      _setActingIdentity(null);
      _setActingAuth({ pending: false, trusted: false, unverified: true });
      const wait = IDENTITY_RETRY_MS[Math.min(identityFails.current, IDENTITY_RETRY_MS.length - 1)];
      identityFails.current++;
      identityTimers.current.retry = setTimeout(() => { if (live()) setIdentityAttempt((n) => n + 1); }, wait);
    };
    identityTimers.current.guard = setTimeout(unverified, IDENTITY_TIMEOUT_MS);
    let p: Promise<Identity | null>;
    try { p = Promise.resolve(provider(forCid)); } catch (e) { p = Promise.reject(e); }
    p.then(
      (id) => {
        let trusted = false;
        try { trusted = !!extensions.identityTrusted?.(forCid); } catch { trusted = false; }
        apply(id ?? null, trusted);
      },
      (e) => (isNoVerdict(e) ? unverified() : apply(null, false)),
    );
    identityRun.current = { key, done };
    return done;
  }, []);
  // re-ask on cid change (after the first resolve) and on every retry
  useEffect(() => {
    attemptRef.current = identityAttempt;
    if (!cidResolved) return;
    void runIdentity(cid, identityAttempt);
  }, [cid, cidResolved, identityAttempt, runIdentity]);
  // PS-16: quiet re-check of a SETTLED identity. The normal ask is cached for
  // the page's lifetime; this probe bypasses that cache and only when the
  // answer CHANGED does it invalidate and re-run the normal ask. No verdict
  // (network/timeout/non-2xx) keeps what is on screen — a blip never
  // downgrades anyone, and an untrusted answer never replaces a trusted one.
  const idStateRef = useRef({ key: identityKey(null, false), pending: true, trusted: false, unverified: false });
  idStateRef.current = { key: identityKey(identity, identityTrusted), pending: identityPending, trusted: identityTrusted, unverified: identityUnverified };
  useEffect(() => {
    const probe = extensions.identityProbe;
    if (!probe || !cidResolved || !cid) return;
    let alive = true;
    let inFlight = false;
    let lastAt = 0;
    const check = (force: boolean) => {
      const st = idStateRef.current;
      if (!alive || inFlight || st.pending || st.unverified) return;
      if (!st.trusted) return; // self-host / trust off: roles are not live-gated
      if (!force && Date.now() - lastAt < 5_000) return;
      inFlight = true;
      lastAt = Date.now();
      probe(cid).then((me) => {
        inFlight = false;
        if (!alive || !me || !me.trusted) return;
        if (identityKey(me.identity, me.trusted) === idStateRef.current.key) return;
        try { extensions.identityInvalidate?.(); } catch { /* best effort */ }
        setIdentityAttempt((n) => n + 1);
      }, () => { inFlight = false; });
    };
    const iv = setInterval(() => check(true), IDENTITY_RECHECK_MS);
    const onFocus = () => check(false);
    const onStale = () => check(true);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener(IDENTITY_STALE_EVENT, onStale);
    }
    return () => {
      alive = false;
      clearInterval(iv);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener(IDENTITY_STALE_EVENT, onStale);
      }
    };
  }, [cid, cidResolved]);
  // never leak the module-level authority slot / timers past this provider's lifetime
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearIdentityTimers();
      _setActingAuth({ pending: false, trusted: false });
    };
  }, []);
  const firstSnapRef = useRef(true);

  const refresh = useCallback(async () => {
    const my = ++seqRef.current;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), SNAPSHOT_TIMEOUT_MS) : null;
    try {
      if (!cidRef.current) {
        const scope = await resolveCidScope();
        cidRef.current = scope.cid;
        multiRef.current = scope.multi;
        setCid(scope.cid);
        setMulti(scope.multi);
        registerScope(scope);
        setCidResolved(true);
        // start identity NOW, in parallel with the first snapshot GET
        if (scope.cid) void runIdentity(scope.cid, attemptRef.current);
        // multi-container: pin the resolved scope into the URL immediately
        ensureCidInLocation(scope);
      }
      if (!cidRef.current) throw new Error("no container found");
      const s = await fetchSnapshot(cidRef.current, ctl?.signal);
      if (firstSnapRef.current) {
        // first paint waits (bounded) for identity to settle — see IDENTITY_GRACE_MS
        const idDone = identityRun.current?.done;
        if (idDone) {
          let t: ReturnType<typeof setTimeout> | null = null;
          await Promise.race([idDone, new Promise<void>((res) => { t = setTimeout(res, IDENTITY_GRACE_MS); })]);
          if (t) clearTimeout(t);
        }
        firstSnapRef.current = false;
      }
      if (my < appliedRef.current) return; // a newer refresh already landed
      appliedRef.current = my;
      answeredRef.current = false;
      applyContainerIcons([s.container]);
      // structural sharing: an idle poll re-uses every unchanged row (and whole unchanged
      // lists), so memoized consumers comparing by identity skip their render
      setSnap((prev) => shareSnapshot(prev, s));
      setError(null);
      setErrorStatus(null);
      setErrorDetail(null);
      setLastOkAt(Date.now());
      setBump((b) => b + 1);
      if (failingRef.current) {
        // SH-130: an outage just ended — the sidebar list / its error note and the
        // notification feed re-load NOW, not on their next 60 s tick.
        failingRef.current = false;
        setErrorSince(null);
        setRecoveredAt(Date.now());
        refreshProjectsIfWatched();
      }
    } catch (e) {
      setCidResolved(true);
      if (my < appliedRef.current) return; // stale failure never hides newer data
      appliedRef.current = my;
      const aborted = e instanceof Error && e.name === "AbortError";
      setError(aborted ? "request timed out" : e instanceof Error ? e.message : String(e));
      const ee = e as { status?: unknown; detail?: unknown } | null;
      const st = !aborted && ee && typeof ee.status === "number" ? ee.status : null;
      answeredRef.current = !aborted && isAnsweredKind(snapshotErrorKind(e instanceof Error ? e.message : String(e), st));
      setErrorStatus(st);
      setErrorDetail(!aborted && ee && typeof ee.detail === "string" && ee.detail ? ee.detail : null);
      if (!failingRef.current) {
        failingRef.current = true;
        setErrorSince(Date.now());
        // SH-130: is it only this project, or Orcha itself? The cached project list
        // can be up to a minute old — ask again now (its answer decides the copy).
        const k = aborted ? "network" : snapshotErrorKind(e instanceof Error ? e.message : String(e), st);
        if (k === "server" || k === "network") refreshProjectsIfWatched();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, [runIdentity]);

  // FEATURE 3: one document-level capture-phase click interceptor upgrades
  // same-origin anchors with ?cid= on multi-container stacks (no-op otherwise).
  useEffect(
    () => installCidLinkInterceptor(() => ({ cid: cidRef.current, multi: multiRef.current })),
    [],
  );

  useEffect(() => {
    let alive = true;
    // One poll request at a time: a hung GET skips ticks instead of piling up
    // (it is aborted after SNAPSHOT_TIMEOUT_MS).
    let polling = false;
    let lastPollAt = 0;
    const poll = () => {
      if (!alive || polling) return;
      // answered 4xx: the backend is up and said no — back off (manual refresh still works)
      if (answeredRef.current && Date.now() - lastPollAt < ANSWERED_BACKOFF_MS) return;
      polling = true;
      lastPollAt = Date.now();
      void refresh().finally(() => { polling = false; });
    };
    poll();
    const iv = setInterval(poll, pollMs);

    // D6 live-push: react ONLY to NEW events (since_ts cursor, never replay
    // history), coalesce bursts, self-managed reconnect so the cursor advances.
    let es: EventSource | null = null;
    let cursor: number | null = null;
    let pending = false;
    let reconnectT: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!alive) return;
      if (!cidRef.current) { reconnectT = setTimeout(connect, 1000); return; }
      if (cursor == null) cursor = Date.now() / 1000;
      try {
        es = new EventSource("/api/containers/" + encodeURIComponent(cidRef.current) + "/events?since_ts=" + cursor);
      } catch {
        return;
      }
      es.onopen = () => { if (alive) setStreamOpen(true); };
      es.onmessage = (ev) => {
        try {
          const ts = (JSON.parse(ev.data) as { ts?: number }).ts;
          if (ts != null) cursor = ts;
        } catch { /* non-JSON keepalive */ }
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (alive) void refresh(); }, 150);
      };
      es.onerror = () => {
        if (alive) setStreamOpen(false);
        try { es?.close(); } catch { /* already closed */ }
        reconnectT = setTimeout(connect, answeredRef.current ? ANSWERED_BACKOFF_MS : 3000);
      };
    };
    connect();

    return () => {
      alive = false;
      clearInterval(iv);
      if (reconnectT) clearTimeout(reconnectT);
      try { es?.close(); } catch { /* already closed */ }
    };
  }, [refresh, pollMs]);

  // Staleness clock: re-evaluate freshness every 2 s so "stale"/"offline"
  // appear even when no refresh settles (e.g. requests hang). setState only
  // when the boolean flips, so a healthy app never re-renders on this timer.
  const lastOkRef = useRef<number | null>(null);
  lastOkRef.current = lastOkAt;
  useEffect(() => {
    const t = setInterval(() => {
      const l = lastOkRef.current;
      setStaleNow(l != null && Date.now() - l > STALE_MS);
    }, 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setStaleNow(false); }, [lastOkAt]);
  const { connection, stale } = classifyConnection({
    error, lastOkAt, streamOpen,
    now: staleNow && lastOkAt != null ? lastOkAt + STALE_MS + 1 : (lastOkAt ?? 0),
  });

  const errorKind = snapshotErrorKind(error, errorStatus);
  return (
    <Ctx.Provider value={{
      snap, cid, multi, identity, identityPending, identityTrusted, identityUnverified, retryIdentity,
      error, errorKind, errorStatus, errorDetail, refresh, bump, lastOkAt, connection, stale,
      errorSince, recoveredAt,
    }}>
      {children}
    </Ctx.Provider>
  );
}

/** A provider rejection that carries no verdict (cloud/identity.ts
 *  IdentityTimeoutError, or any AbortError/TimeoutError). */
function isNoVerdict(e: unknown): boolean {
  const n = e && typeof e === "object" ? (e as { name?: unknown }).name : null;
  return n === "IdentityTimeoutError" || n === "TimeoutError" || n === "AbortError";
}

/** Deep equality for JSON-shaped snapshot data (plain objects, arrays, primitives). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** `next` with every row that is content-equal to a row of `prev` (matched by id, else by
 *  position) replaced by that previous object; the previous ARRAY itself when nothing changed
 *  (same rows, same order). Changed / new rows keep their fresh identity. */
export function shareList<T>(prev: readonly T[] | null | undefined, next: T[]): T[] {
  if (!prev || !prev.length || !next || !next.length) return next;
  const keyOf = (x: T, i: number) => {
    const id = x && typeof x === "object" ? (x as { id?: unknown }).id : undefined;
    return id != null ? "i:" + String(id) : "#" + i;
  };
  const byKey = new Map<string, T>();
  prev.forEach((x, i) => byKey.set(keyOf(x, i), x));
  let same = prev.length === next.length;
  const out = next.map((x, i) => {
    const p = byKey.get(keyOf(x, i));
    if (p !== undefined && jsonEqual(p, x)) {
      if (prev[i] !== p) same = false;
      return p;
    }
    same = false;
    return x;
  });
  return same ? (prev as T[]) : out;
}

/** Structural sharing across snapshot polls: the snapshot object is always fresh (a new
 *  poll landed), but `agents` / `tasks` / `requests` / `byAlias` / `container` keep the
 *  previous identity when their content is unchanged, and unchanged rows inside a changed
 *  list keep theirs — so an idle poll does not re-render identity-memoized consumers. */
export function shareSnapshot(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev) return next;
  const agents = shareList(prev.agents, next.agents);
  const byAlias = agents === prev.agents ? prev.byAlias : Array.isArray(agents) ? Object.fromEntries(agents.map((a) => [a.alias, a])) : next.byAlias;
  return {
    ...next,
    agents,
    byAlias,
    tasks: shareList(prev.tasks, next.tasks),
    requests: shareList(prev.requests, next.requests),
    container: jsonEqual(prev.container, next.container) ? prev.container : next.container,
  };
}

export function useSnapshot(): SnapshotCtx {
  return useContext(Ctx);
}

/* ---- derived helpers (ports of the app.js accessors) -------------------- */

export function agentByAlias(snap: Snapshot | null, alias: string | null | undefined): Agent | null {
  if (!snap || !alias) return null;
  return snap.agents.find((a) => a.alias === alias) || null;
}
export function agentById(snap: Snapshot | null, id: unknown): Agent | null {
  if (!snap || id == null) return null;
  return snap.agents.find((a) => String(a.id) === String(id)) || null;
}
export function taskById(snap: Snapshot | null, id: unknown): Task | null {
  if (!snap || id == null) return null;
  return snap.tasks.find((t) => String(t.id) === String(id)) || null;
}
export function humans(snap: Snapshot | null): Agent[] {
  return (snap?.agents ?? []).filter((a) => a.kind === "human");
}

// a request is "to the human" if its target resolves to a human agent, or has
// no explicit target (the API routes those to the picked human).
export function isToHuman(snap: Snapshot | null, r: OrchaRequest): boolean {
  if (r.target_id !== undefined) {
    if (!r.target_id) return true;
    const t = agentById(snap, r.target_id);
    return !!t && t.kind === "human";
  }
  if (r.to === "human") return true;
  const a = agentByAlias(snap, r.to);
  return !!(a && a.kind === "human");
}

/* ---- acting-as (persisted; NOT hardcoded) --------------------------------
 * Identity seam mechanics: when a downstream registers `extensions.identity`,
 * SnapshotProvider publishes each fetched Identity into a module-level slot
 * via `_setActingIdentity`. The long-standing `actingHuman(snap)` consults
 * that slot (through `actingIdentityHuman`), so every existing caller —
 * pages, autonomy switch, notification center — transparently inherits the
 * identity-aware actor without signature changes. Open builds never register
 * a provider, the slot stays null, and behavior is exactly the legacy
 * localStorage-pick / first-human resolution.
 */
let moduleIdentity: Identity | null = null;
/** Provider/test hook: publish (or clear) the viewer identity consulted by actingHuman. */
export function _setActingIdentity(id: Identity | null): void {
  moduleIdentity = id;
}
export interface ActingAuth {
  pending: boolean;
  trusted: boolean;
  /** identity could not be confirmed (timed out) — read-only until it is */
  unverified?: boolean;
}
let moduleAuth: ActingAuth = { pending: false, trusted: false };
/** Provider/test hook: publish whether identity is still resolving and whether
 *  the sign-in is trusted (verified proxy lane). */
export function _setActingAuth(a: ActingAuth): void {
  moduleAuth = { pending: !!a.pending, trusted: !!a.trusted, unverified: !!a.unverified };
}

registerTestReset(() => { moduleIdentity = null; moduleAuth = { pending: false, trusted: false }; });

function actingKey(snap: Snapshot | null): string {
  return "orcha:actingHuman:" + (snap?.container?.id || "_");
}

/**
 * Identity-aware acting-human resolution (port of cloud app-data.js:100-164):
 *  - identity present + agent_id resolves to a kind='human' agent in the
 *    snapshot → THAT is the acting human (the localStorage pick is ignored);
 *  - identity present but agent_id null/unresolvable (trusted non-member,
 *    e.g. a viewer) → NULL. Never falls through to another human.
 *  - no identity (open default) → legacy: persisted per-container pick, else
 *    the first kind='human' agent.
 */
export function actingIdentityHuman(
  snap: Snapshot | null,
  identity: Identity | null,
  auth: ActingAuth = moduleAuth,
): Agent | null {
  if (auth.pending) return null; // identity still resolving: nobody acts yet
  if (auth.unverified) return null; // identity unconfirmed (timeout): nobody acts
  if (identity) {
    if (identity.member_role === "viewer") return null; // viewer role is read-only (backend refuses writes)
    if (identity.agent_id != null) {
      const own = agentById(snap, identity.agent_id);
      if (own && own.kind === "human") return own;
    }
    return null; // a trusted non-member must NEVER act as another human
  }
  if (auth.trusted) return null; // trusted sign-in without membership: view-only
  const hs = humans(snap);
  if (!hs.length) return null;
  let saved: string | null = null;
  try { saved = localStorage.getItem(actingKey(snap)); } catch { /* private mode */ }
  if (saved) {
    const m = hs.find((h) => String(h.id) === String(saved));
    if (m) return m;
  }
  return hs[0];
}

export function actingHuman(snap: Snapshot | null): Agent | null {
  return actingIdentityHuman(snap, moduleIdentity);
}

/** The signed-in person's OWN human row (for reading their own notifications),
 *  regardless of role. Null while pending / for non-members. Never an actor. */
export function identitySelfHuman(snap: Snapshot | null, identity: Identity | null, auth: ActingAuth = moduleAuth): Agent | null {
  if (auth.pending || auth.unverified) return null;
  if (identity) {
    const own = identity.agent_id != null ? agentById(snap, identity.agent_id) : null;
    return own && own.kind === "human" ? own : null;
  }
  return actingIdentityHuman(snap, null, auth);
}

export interface ActingAuthority {
  /** the human the UI may act as — null when nobody may act */
  human: Agent | null;
  /** signed in but may not act (viewer role, or trusted non-member) */
  readOnly: boolean;
  /** identity still resolving */
  pending: boolean;
  /** why actions are unavailable (null when `human` is set) */
  reason: string | null;
  /** identity could not be confirmed (timed out; retrying) — readOnly too */
  unverified?: boolean;
}

export const UNVERIFIED_REASON = "Couldn't confirm who you are — view-only until Embodent responds (retrying)";
export const OFFLINE_REASON = "Offline — reconnect to make changes";
export const NOT_MEMBER_REASON = "You are not a member of this project (view-only)";
export const NOT_FOUND_REASON = "Project not found";

/** Pure authority resolution (unit-tested): who may act and, if nobody, why. */
export function actingAuthority(snap: Snapshot | null, identity: Identity | null, auth: ActingAuth = moduleAuth): ActingAuthority {
  if (auth.pending) return { human: null, readOnly: false, pending: true, reason: "Resolving your identity…" };
  if (auth.unverified) return { human: null, readOnly: true, pending: false, unverified: true, reason: UNVERIFIED_REASON };
  const readOnly = (!!identity && identity.member_role === "viewer") || (!identity && auth.trusted);
  if (readOnly) {
    return {
      human: null, readOnly: true, pending: false,
      reason: identity ? "Your role is viewer (read-only)" : NOT_MEMBER_REASON,
    };
  }
  const human = actingIdentityHuman(snap, identity, auth);
  return { human, readOnly: false, pending: false, reason: human ? null : "Pick an acting human first — actions never impersonate a human" };
}

/**
 * Authority once the snapshot's health is known (pure, tested). A snapshot the
 * backend REFUSED (401/403) or doesn't know (400/404) is not an outage: nobody
 * may act, and the reason names the real cause (e2e-permissions-25, SH-123) —
 * never "Offline — reconnect", which no reconnect can fix. Only a real outage
 * (no HTTP answer / 5xx, stale past STALE_MS) reads as offline.
 */
export function authorityForConnection(a: ActingAuthority, connection: Connection, errorKind: SnapshotErrorKind): ActingAuthority {
  if (a.pending) return a;
  if (errorKind === "forbidden") return { ...a, human: null, readOnly: true, reason: NOT_MEMBER_REASON };
  if (errorKind === "not_found") return { ...a, human: null, readOnly: true, reason: NOT_FOUND_REASON };
  // Offline: every mutation would fail against an unreachable backend, so the
  // whole UI goes read-only (Accept / Reject / New task … disable themselves).
  if (connection === "offline") return { ...a, human: null, readOnly: true, reason: OFFLINE_REASON };
  return a;
}

/** Context-aware authority hook for shell/pages. */
export function useActingAuthority(): ActingAuthority {
  const { snap, identity, identityPending, identityTrusted, identityUnverified, connection, errorKind } = useSnapshot();
  const a = actingAuthority(snap, identity, { pending: identityPending, trusted: identityTrusted, unverified: identityUnverified });
  return authorityForConnection(a, connection, errorKind);
}
export function setActingHuman(snap: Snapshot | null, id: string): void {
  try { localStorage.setItem(actingKey(snap), String(id)); } catch { /* private mode */ }
  // the project list's per-viewer "Needs you" counts depend on the pick
  refreshProjectsIfWatched();
}

/* ---- autonomy + attention (#367) ----------------------------------------- */
export function autLevel(snap: Snapshot | null): string {
  return snap?.container?.autonomy_level || "plan";
}

export function planMessageOf(t: Task): { body: string; from: string | null; at?: string; is_human: boolean } | null {
  if (t.plan_message) {
    return { body: t.plan_message.body, from: t.plan_message.author_alias || null, at: t.plan_message.at, is_human: false };
  }
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? { body: m[0].body, from: m[0].from, at: m[0].at, is_human: false } : null;
}
export function pendingPlan(t: Task): boolean {
  return t.status === "in_progress" && !t.plan_decision && !!planMessageOf(t);
}

/** An agent's EFFECTIVE autonomy (portal_backend/autonomy.py, the one rule):
 *  the server-computed value when present, else enforced → container level,
 *  else the agent's override, else the container level. */
export function agentAutonomy(snap: Snapshot | null, a: Agent | null | undefined): string {
  const lvl = autLevel(snap);
  if (!a) return lvl;
  if (a.effective_autonomy) return a.effective_autonomy;
  if (snap?.container?.autonomy_enforced) return lvl;
  return a.autonomy_override || lvl;
}

/** Is this task's plan actually gated on a human? pendingPlan (in_progress,
 *  undecided, an agent plan message) AND the plan author's — else the
 *  assignee's — effective autonomy is "plan". An agent running at pr/full
 *  (per-agent override) posts progress notes, not plans awaiting approval, so
 *  those tasks no longer over-flag as "plan waiting" (screen review). */
export function planAwaitsHuman(snap: Snapshot | null, t: Task): boolean {
  if (!pendingPlan(t)) return false;
  const pm = planMessageOf(t);
  const who = agentByAlias(snap, pm?.from) || agentByAlias(snap, t.assignee);
  return agentAutonomy(snap, who) === "plan";
}

export interface AttnItems {
  plans: Task[];
  verifs: Task[];
  escs: OrchaRequest[];
  count: number;
}
export function attnItems(snap: Snapshot | null): AttnItems {
  const lvl = autLevel(snap);
  const tasks = snap?.tasks ?? [];
  const reqs = snap?.requests ?? [];
  const plans = tasks.filter((t) => planAwaitsHuman(snap, t));
  const verifs = lvl === "full" ? [] : tasks.filter((t) => t.status === "needs_verification");
  const escs = reqs.filter((r) => r.status === "open" && isToHuman(snap, r));
  return { plans, verifs, escs, count: plans.length + verifs.length + escs.length };
}

/* ---- authoritative sidebar counts (GH count-mismatch fix) -----------------
 * Cloud backends put authoritative open totals on the snapshot
 * (task_open_total / request_open_total) because their snapshot lists may be
 * scoped/truncated. When non-null those win; open backends omit them (mapped
 * to null) and the counts fall back to today's list-computed values.
 */
export function navCounts(snap: Snapshot | null): { tasks: number; requests: number } {
  return {
    tasks: snap?.task_open_total ?? (snap?.tasks ?? []).filter((t) => t.status === "needs_verification").length,
    requests: snap?.request_open_total ?? (snap?.requests ?? []).filter((r) => r.status === "open").length,
  };
}
/**
 * Back-compat card numbers, now derived from the ONE attention definition
 * (state/attention.ts selectAttention, arch §3) — GAP-01: this used to report
 * task_open_total / request_open_total (ALL open work) as "to verify" /
 * "escalations". The `a` argument is kept for signature compatibility only.
 */
export function attnCardCounts(snap: Snapshot | null, _a?: AttnItems): { verify: number; esc: number; total: number } {
  void _a;
  const at = selectAttention(snap, actingHuman(snap)?.id ?? null);
  const mine = at.items.filter((i) => !i.assignedToOther);
  return {
    verify: mine.filter((i) => i.kind === "verify").length,
    esc: mine.filter((i) => i.kind === "request").length,
    total: at.count ?? 0,
  };
}
