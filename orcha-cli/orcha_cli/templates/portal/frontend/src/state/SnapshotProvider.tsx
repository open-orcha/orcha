/**
 * The live container snapshot as React context: initial fetch + 3s poll +
 * the D6 sub-second event stream (EventSource with a since_ts cursor and
 * burst coalescing — port of data.js start/startEventStream). Also the
 * acting-human persistence (app.js actingHuman/setActingHuman) and the
 * attention aggregation (attnItems / autLevel, #367 autonomy-gated cards).
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
import { ensureCidInLocation, installCidLinkInterceptor, registerScope, resolveCidScope } from "../lib/scope";
import { extensions, type Identity } from "../extensions";
import type { Agent, OrchaRequest, Snapshot, Task } from "../types";

export interface SnapshotCtx {
  snap: Snapshot | null;
  cid: string | null;
  multi: boolean; // multi-container stack (lib/scope) — drives ?cid= propagation
  identity: Identity | null; // extensions.identity result (open default: null)
  error: string | null;
  refresh: () => Promise<void>;
  bump: number; // increments every applied refresh (for effects keyed to polls)
}

const Ctx = createContext<SnapshotCtx>({
  snap: null,
  cid: null,
  multi: false,
  identity: null,
  error: null,
  refresh: async () => {},
  bump: 0,
});

export function SnapshotProvider({ children, pollMs = 3000 }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [cid, setCid] = useState<string | null>(null);
  const [multi, setMulti] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [cidResolved, setCidResolved] = useState(false); // first resolve attempt done
  const cidRef = useRef<string | null>(null);
  const multiRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      if (!cidRef.current) {
        const scope = await resolveCidScope();
        cidRef.current = scope.cid;
        multiRef.current = scope.multi;
        setCid(scope.cid);
        setMulti(scope.multi);
        registerScope(scope);
        setCidResolved(true);
        // multi-container: pin the resolved scope into the URL immediately
        ensureCidInLocation(scope);
      }
      if (!cidRef.current) throw new Error("no container found");
      const s = await fetchSnapshot(cidRef.current);
      setSnap(s);
      setError(null);
      setBump((b) => b + 1);
    } catch (e) {
      setCidResolved(true);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // FEATURE 3: one document-level capture-phase click interceptor upgrades
  // same-origin anchors with ?cid= on multi-container stacks (no-op otherwise).
  useEffect(
    () => installCidLinkInterceptor(() => ({ cid: cidRef.current, multi: multiRef.current })),
    [],
  );

  // FEATURE 1: identity seam — when a downstream registers extensions.identity
  // (its /api/me), fetch it once per resolved cid (re-fetch on cid change).
  // Failures resolve to null and NEVER block the snapshot. The result is
  // published both on the context and into the module-level acting slot so
  // legacy actingHuman(snap) callers transparently inherit it.
  const identityReq = useRef(0);
  useEffect(() => {
    const provider = extensions.identity;
    if (!provider || !cidResolved) return;
    const req = ++identityReq.current;
    const apply = (id: Identity | null) => {
      if (identityReq.current !== req) return; // stale (cid changed underneath)
      setIdentity(id);
      _setActingIdentity(id);
    };
    provider(cid).then(
      (id) => apply(id ?? null),
      () => apply(null),
    );
  }, [cid, cidResolved]);

  useEffect(() => {
    let alive = true;
    void refresh();
    const iv = setInterval(() => { if (alive) void refresh(); }, pollMs);

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
        try { es?.close(); } catch { /* already closed */ }
        reconnectT = setTimeout(connect, 3000);
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

  return <Ctx.Provider value={{ snap, cid, multi, identity, error, refresh, bump }}>{children}</Ctx.Provider>;
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
export function actingIdentityHuman(snap: Snapshot | null, identity: Identity | null): Agent | null {
  if (identity) {
    if (identity.agent_id != null) {
      const own = agentById(snap, identity.agent_id);
      if (own && own.kind === "human") return own;
    }
    return null; // a trusted non-member must NEVER act as another human
  }
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
export function setActingHuman(snap: Snapshot | null, id: string): void {
  try { localStorage.setItem(actingKey(snap), String(id)); } catch { /* private mode */ }
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
  const plans = lvl === "plan" ? tasks.filter(pendingPlan) : [];
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
export function attnCardCounts(snap: Snapshot | null, a: AttnItems): { verify: number; esc: number; total: number } {
  const verify = snap?.task_open_total ?? a.verifs.length;
  const esc = snap?.request_open_total ?? a.escs.length;
  return { verify, esc, total: a.plans.length + verify + esc };
}
