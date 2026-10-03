/**
 * V2 QA regressions in shared state:
 *  - SnapshotProvider applies only the NEWEST refresh (an older response that
 *    lands late never overwrites newer data);
 *  - identity pending → nobody acts, attention unknown (no impersonation);
 *  - viewer role / trusted non-member → read-only, Needs you count 0.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapSnapshot } from "../api/client";
import { extensions, type Identity } from "../extensions";
import {
  SnapshotProvider,
  _setActingAuth,
  _setActingIdentity,
  actingAuthority,
  actingHuman,
  useActingAuthority,
  useSnapshot,
} from "./SnapshotProvider";
import { selectAttention } from "./attention";

const raw = (name: string) => ({
  container: { id: "c1", name, status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "owner", kind: "human", status: "idle" },
    { id: "h2", alias: "viewer", kind: "human", status: "idle" },
  ],
  tasks: [{ id: "t1", title: "Verify", status: "needs_verification", assignees: [] }],
  requests: [{ id: "r1", type: "info", status: "open", requester_id: "a1", target_id: null, payload: "q" }],
});
const snap = mapSnapshot(raw("x"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
});
beforeEach(() => localStorage.clear());

describe("actingAuthority (pure)", () => {
  it("pending identity: nobody acts, reason says so", () => {
    const a = actingAuthority(snap, null, { pending: true, trusted: false });
    expect(a.human).toBeNull();
    expect(a.pending).toBe(true);
    expect(a.reason).toMatch(/Resolving/);
  });
  it("viewer role: read-only, no actor even though their human exists", () => {
    const a = actingAuthority(snap, { agent_id: "h2", member_role: "viewer" }, { pending: false, trusted: true });
    expect(a).toMatchObject({ human: null, readOnly: true, reason: "Your role is viewer (read-only)" });
  });
  it("trusted non-member (identity null): read-only, never the first human", () => {
    const a = actingAuthority(snap, null, { pending: false, trusted: true });
    expect(a.human).toBeNull();
    expect(a.readOnly).toBe(true);
  });
  it("self-host (untrusted, no identity): legacy first-human pick", () => {
    expect(actingAuthority(snap, null, { pending: false, trusted: false }).human?.id).toBe("h1");
  });
  it("member: acts as their own human", () => {
    expect(actingAuthority(snap, { agent_id: "h2", member_role: "member" }, { pending: false, trusted: true }).human?.id).toBe("h2");
  });
  it("module-level actingHuman honours the published auth slot", () => {
    _setActingAuth({ pending: true, trusted: false });
    expect(actingHuman(snap)).toBeNull();
    _setActingAuth({ pending: false, trusted: true });
    expect(actingHuman(snap)).toBeNull(); // trusted, no identity → view-only
    _setActingAuth({ pending: false, trusted: false });
    expect(actingHuman(snap)?.id).toBe("h1");
  });
});

describe("selectAttention authority options", () => {
  it("read-only viewers get count 0 and every item marked as not theirs", () => {
    const a = selectAttention(snap, null, { readOnly: true });
    expect(a.count).toBe(0);
    expect(a.readOnly).toBe(true);
    expect(a.items.length).toBe(2);
    expect(a.items.every((i) => i.assignedToOther)).toBe(true);
  });
  it("pending identity: count is unknown (null), never a guess", () => {
    expect(selectAttention(snap, null, { pending: true }).count).toBeNull();
  });
  it("unchanged default for a deciding human", () => {
    expect(selectAttention(snap, "h1").count).toBe(2);
  });
});

/* ---- provider-level ------------------------------------------------------ */
function Probe({ out }: { out: string[] }) {
  const { snap: s } = useSnapshot();
  const a = useActingAuthority();
  out.push(`${s?.container?.name ?? "null"}|${a.human?.alias ?? (a.pending ? "pending" : "none")}`);
  return null;
}

describe("SnapshotProvider", () => {
  it("an older snapshot response that resolves after a newer one is dropped", async () => {
    const resolvers: Array<(name: string) => void> = [];
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") {
        return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response);
      }
      return new Promise<Response>((res) => {
        resolvers.push((name) => res({ ok: true, status: 200, json: async () => raw(name) } as Response));
      });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    let refresh: (() => Promise<void>) | null = null;
    function Grab() { refresh = useSnapshot().refresh; return null; }
    render(<SnapshotProvider pollMs={60_000}><Grab /><Probe out={out} /></SnapshotProvider>);
    await waitFor(() => expect(resolvers.length).toBe(1)); // initial poll (OLD) in flight
    let p2: Promise<void> | null = null;
    act(() => { p2 = refresh!(); }); // a newer refresh (e.g. after a mutation)
    await waitFor(() => expect(resolvers.length).toBe(2));
    await act(async () => { resolvers[1]("NEW"); await p2; });
    await waitFor(() => expect(out[out.length - 1]).toMatch(/^NEW\|/));
    await act(async () => { resolvers[0]("OLD"); await new Promise((r) => setTimeout(r, 10)); });
    expect(out[out.length - 1]).toMatch(/^NEW\|/);
    expect(out.some((l) => l.startsWith("OLD|"))).toBe(false);
  });

  it("while the identity provider has not answered, nobody is shown acting", async () => {
    let answer: ((id: Identity | null) => void) | null = null;
    extensions.identity = () => new Promise<Identity | null>((res) => { answer = res; });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/containers" ? [{ id: "c1", status: "active" }] : raw("P");
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await waitFor(() => expect(out[out.length - 1]).toBe("P|pending"));
    expect(out.some((l) => l.endsWith("|owner"))).toBe(false); // never the first human while pending
    await waitFor(() => expect(answer).not.toBeNull());
    await act(async () => { answer!({ agent_id: "h2", member_role: "member" }); });
    await waitFor(() => expect(out[out.length - 1]).toBe("P|viewer")); // alias of h2 in this fixture
  });
});
