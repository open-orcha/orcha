/**
 * PS-16: a live role change (owner demotes a member to viewer) flips the open
 * UI to read-only without a reload — via the periodic identity re-check, and
 * immediately when a write is refused for a role reason (403 → event).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensions, type Identity } from "../extensions";
import { sendJSON } from "../api/client";
import { IDENTITY_RECHECK_MS, SnapshotProvider, useActingAuthority } from "./SnapshotProvider";

const raw = {
  container: { id: "c1", name: "P", status: "active" },
  agents: [
    { id: "h1", alias: "owner", kind: "human", status: "idle", member_role: "owner" },
    { id: "h2", alias: "maya", kind: "human", status: "idle", member_role: "member" },
  ],
  tasks: [],
  requests: [],
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

let role = "member";
const me = (): Identity => ({ agent_id: "h2", alias: "maya", github_login: "maya", member_role: role, grants: [] });
let saved: Partial<typeof extensions>;
beforeEach(() => {
  role = "member";
  saved = { identity: extensions.identity, identityTrusted: extensions.identityTrusted, identityProbe: extensions.identityProbe, identityInvalidate: extensions.identityInvalidate };
  extensions.identity = () => Promise.resolve(me());
  extensions.identityTrusted = () => true;
  extensions.identityInvalidate = () => {};
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const u = String(input);
    if (u === "/api/containers") return Promise.resolve(ok([{ id: "c1", status: "active" }]));
    if (u.startsWith("/api/tasks/")) {
      return Promise.resolve({ ok: false, status: 403, json: async () => ({ detail: "your role on this project is viewer (read-only)" }) } as Response);
    }
    return Promise.resolve(ok(raw));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(extensions, saved);
});

function Probe({ out }: { out: string[] }) {
  const a = useActingAuthority();
  out.push(`${a.human?.alias ?? "none"}|${a.readOnly}|${a.pending}`);
  return null;
}

describe("PS-16 live identity re-check", () => {
  it("periodic re-check flips a demoted member to read-only", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let probes = 0;
    extensions.identityProbe = () => { probes++; return Promise.resolve({ identity: me(), trusted: true }); };
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(out[out.length - 1]).toBe("maya|false|false");
    // unchanged answer: nothing flips
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_RECHECK_MS + 10); });
    expect(probes).toBe(1);
    expect(out[out.length - 1]).toBe("maya|false|false");
    role = "viewer"; // owner demotes maya
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_RECHECK_MS + 10); });
    expect(out[out.length - 1]).toMatch(/\|true\|false$/); // read-only (a viewer is no actor)
  });

  it("a role-related 403 on a write re-checks immediately", async () => {
    extensions.identityProbe = () => Promise.resolve({ identity: me(), trusted: true });
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 1_700)); });
    expect(out[out.length - 1]).toBe("maya|false|false");
    role = "viewer";
    await act(async () => {
      await sendJSON("POST", "/api/tasks/t1/verify", {}).catch(() => null);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(out[out.length - 1]).toMatch(/\|true\|false$/); // read-only (a viewer is no actor)
  });

  it("no verdict / an untrusted answer never downgrades the identity on screen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let answer: { identity: Identity | null; trusted: boolean } | null = null;
    extensions.identityProbe = () => Promise.resolve(answer);
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_RECHECK_MS + 10); });
    expect(out[out.length - 1]).toBe("maya|false|false");
    answer = { identity: null, trusted: false }; // fail-open shape from a blip
    await act(async () => { await vi.advanceTimersByTimeAsync(IDENTITY_RECHECK_MS + 10); });
    expect(out[out.length - 1]).toBe("maya|false|false");
  });
});
