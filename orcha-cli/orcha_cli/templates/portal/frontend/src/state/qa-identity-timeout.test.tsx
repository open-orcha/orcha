/**
 * Round-1 fix loop (live-state-identity):
 *  - a hung identity provider never leaves the UI "Resolving your identity…"
 *    forever and never fails OPEN to a guessed human: after
 *    IDENTITY_TIMEOUT_MS it is UNVERIFIED (read-only, count unknown) and retried;
 *  - the first snapshot waits for identity to settle (no "–" flash / disabled
 *    actions that flip a tick later — the source of the test races), bounded
 *    by IDENTITY_GRACE_MS;
 *  - optimistic decisions are shared app-wide (every count agrees at once);
 *  - plan attention honours the plan author's effective autonomy.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensions, type Identity } from "../extensions";
import { mapSnapshot } from "../api/client";
import {
  IDENTITY_GRACE_MS,
  IDENTITY_RETRY_MS,
  IDENTITY_TIMEOUT_MS,
  SnapshotProvider,
  UNVERIFIED_REASON,
  actingAuthority,
  actingHuman,
  useActingAuthority,
  useSnapshot,
} from "./SnapshotProvider";
import { applyDecided, markAttentionDecided, selectAttention, useAttention } from "./attention";

const raw = {
  container: { id: "c1", name: "P", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "owner", kind: "human", status: "idle" }],
  tasks: [
    { id: "t1", title: "Verify A", status: "needs_verification", assignees: [] },
    { id: "t2", title: "Verify B", status: "needs_verification", assignees: [] },
  ],
  requests: [],
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const stub = () => {
  global.fetch = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(ok(String(input) === "/api/containers" ? [{ id: "c1", status: "active" }] : raw)),
  ) as unknown as typeof fetch;
};

let saved: typeof extensions.identity;
let savedTrusted: typeof extensions.identityTrusted;
beforeEach(() => { localStorage.clear(); saved = extensions.identity; savedTrusted = extensions.identityTrusted; });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  extensions.identity = saved;
  extensions.identityTrusted = savedTrusted;
});

function Probe({ out }: { out: string[] }) {
  const { snap, identityUnverified } = useSnapshot();
  const a = useActingAuthority();
  const at = useAttention();
  out.push(`${snap ? "snap" : "null"}|${a.human?.alias ?? "none"}|${a.readOnly}|${a.pending}|${identityUnverified}|${at.count}`);
  return null;
}

describe("identity provider that never answers", () => {
  it("becomes UNVERIFIED (read-only, unknown count, no actor) after IDENTITY_TIMEOUT_MS, then retries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let asks = 0;
    extensions.identity = () => { asks++; return new Promise<Identity | null>(() => {}); };
    extensions.identityTrusted = () => false;
    stub();
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(asks).toBe(1);
    expect(out[out.length - 1]).toBe("null|none|false|true|false|null"); // gate holds the first paint
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_GRACE_MS); });
    expect(out[out.length - 1]).toBe("snap|none|false|true|false|null"); // grace: data shows, still resolving
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_TIMEOUT_MS); });
    expect(out[out.length - 1]).toBe("snap|none|true|false|true|null"); // unverified: read-only, never fail-open
    expect(out.some((l) => l.includes("|owner|"))).toBe(false); // never acted as the local human
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_RETRY_MS[0] + 10); });
    expect(asks).toBe(2); // retried with backoff
    expect(out[out.length - 1]).toBe("snap|none|true|false|true|null"); // still read-only while retrying
  });

  it("a later answer restores authority", async () => {
    let answer: ((id: Identity | null) => void) | null = null;
    let asks = 0;
    extensions.identity = () => {
      asks++;
      if (asks === 1) return Promise.reject(Object.assign(new Error("t"), { name: "IdentityTimeoutError" }));
      return new Promise<Identity | null>((res) => { answer = res; });
    };
    extensions.identityTrusted = () => false;
    stub();
    const out: string[] = [];
    let retry: (() => void) | null = null;
    function R() { retry = useSnapshot().retryIdentity; return null; }
    render(<SnapshotProvider pollMs={60_000}><R /><Probe out={out} /></SnapshotProvider>);
    await waitFor(() => expect(out[out.length - 1]).toBe("snap|none|true|false|true|null"));
    act(() => retry!()); // the manual "Retry" affordance
    await waitFor(() => expect(asks).toBe(2));
    await act(async () => { answer!(null); });
    await waitFor(() => expect(out[out.length - 1]).toBe("snap|owner|false|false|false|2"));
  });

  it("a definite provider failure still fails open (self-host parity)", async () => {
    extensions.identity = () => Promise.reject(new Error("boom"));
    extensions.identityTrusted = () => false;
    stub();
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await waitFor(() => expect(out[out.length - 1]).toBe("snap|owner|false|false|false|2"));
  });
});

describe("first paint waits for identity", () => {
  it("the snapshot is never published with an unresolved identity when /api/me answers promptly", async () => {
    extensions.identity = () => new Promise((res) => setTimeout(() => res(null), 30));
    extensions.identityTrusted = () => false;
    stub();
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await waitFor(() => expect(out[out.length - 1]).toBe("snap|owner|false|false|false|2"));
    expect(out.filter((l) => l.startsWith("snap|")).every((l) => l === "snap|owner|false|false|false|2")).toBe(true);
  });
});

describe("actingAuthority — unverified", () => {
  it("is read-only with a reason and no actor; legacy actingHuman agrees", () => {
    const snap = mapSnapshot(raw);
    const a = actingAuthority(snap, null, { pending: false, trusted: false, unverified: true });
    expect(a).toMatchObject({ human: null, readOnly: true, pending: false, unverified: true, reason: UNVERIFIED_REASON });
    expect(actingHuman(snap)).not.toBeNull(); // module slot untouched here (open default)
  });
});

describe("optimistic decisions are shared by every attention surface", () => {
  it("a marked item leaves every useAttention consumer at once and returns on undo", async () => {
    extensions.identity = undefined;
    stub();
    const a: string[] = [];
    const b: string[] = [];
    function A() { a.push(String(useAttention().count)); return null; }
    function B() { b.push(useAttention().items.map((i) => i.key).join(",")); return null; }
    render(<SnapshotProvider pollMs={60_000}><A /><B /></SnapshotProvider>);
    await waitFor(() => expect(a[a.length - 1]).toBe("2"));
    let undo: () => void = () => {};
    act(() => { undo = markAttentionDecided("verify:t1"); });
    expect(a[a.length - 1]).toBe("1");
    expect(b[b.length - 1]).toBe("verify:t2");
    act(() => undo());
    expect(a[a.length - 1]).toBe("2");
  });

  it("marks are pruned once the snapshot confirms, and expire after the TTL", () => {
    const base = selectAttention(mapSnapshot(raw), "h1");
    markAttentionDecided("verify:t1");
    expect(applyDecided(base).count).toBe(1);
    // snapshot confirms: t1 no longer awaits verification → mark pruned
    const after = selectAttention(mapSnapshot({ ...raw, tasks: [raw.tasks[1]] }), "h1");
    expect(applyDecided(after).count).toBe(1);
    // a re-raised t1 shows again (the mark is gone)
    expect(applyDecided(base).count).toBe(2);
    markAttentionDecided("verify:t2");
    expect(applyDecided(base, Date.now() + 61_000).count).toBe(2); // TTL safety net
  });
});

describe("plan attention honours effective autonomy", () => {
  const planMsg = { message_id: "m1", author_id: "a1", author_alias: "Atlas", is_human: false, body: "PLAN", created_at: "2026-09-01T10:00:00Z" };
  const s = (level: string, agent: Record<string, unknown>) => mapSnapshot({
    container: { id: "c1", autonomy_level: level },
    agents: [{ id: "h1", alias: "k", kind: "human", status: "idle" }, { id: "a1", alias: "Atlas", kind: "ai", status: "working", ...agent }],
    tasks: [{ id: "tp", title: "T", status: "in_progress", assignees: ["Atlas"], messages: [planMsg] }],
    requests: [],
  });
  const plans = (x: ReturnType<typeof s>) => selectAttention(x, "h1").items.filter((i) => i.kind === "plan").length;
  it("container plan, agent effective pr → a progress note, not a plan waiting", () => {
    expect(plans(s("plan", { effective_autonomy: "pr" }))).toBe(0);
    expect(plans(s("plan", { autonomy_override: "full" }))).toBe(0);
  });
  it("container pr, agent effective plan → the plan waits on a human", () => {
    expect(plans(s("pr", { effective_autonomy: "plan" }))).toBe(1);
  });
  it("enforced container level wins over an override", () => {
    const x = s("plan", { autonomy_override: "full" });
    x.container!.autonomy_enforced = true;
    expect(plans(x)).toBe(1);
    expect(plans(s("plan", {}))).toBe(1); // inherit
  });
});
