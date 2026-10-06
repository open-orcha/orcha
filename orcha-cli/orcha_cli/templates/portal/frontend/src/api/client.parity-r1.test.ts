/**
 * Parity round 1 (api/client.ts):
 *  - EX-09 / MEM-006: a failed call carries `status` and the server's detail as
 *    PLAIN text (FastAPI 422 arrays → their messages, never "[object Object]"),
 *    so toasts never need the URL / container id in `message`;
 *  - REQ-013/071/100: an escalated request is mapped from the additive backend
 *    flag too, not only the legacy status='escalated'.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorDetailText, getJSON, mapSnapshot, sendJSON, type ApiError } from "./client";

afterEach(() => vi.unstubAllGlobals());

const res = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe("errorDetailText (pure)", () => {
  it("string, FastAPI 422 array, object {message} and empty inputs", () => {
    expect(errorDetailText("not a member")).toBe("not a member");
    expect(errorDetailText([{ type: "string_pattern_mismatch", loc: ["body", "github_login"], msg: "String should match pattern" }]))
      .toBe("github login: String should match pattern");
    expect(errorDetailText([{ msg: "field required" }, { msg: "too long", loc: ["body", "alias"] }])).toBe("field required; alias: too long");
    expect(errorDetailText({ premium: true, message: "Upgrade to add more members", upgrade_url: "/billing" })).toBe("Upgrade to add more members");
    expect(errorDetailText(null)).toBe("");
    expect(errorDetailText([{}])).toBe("");
  });
});

describe("sendJSON / getJSON errors", () => {
  it("sendJSON: status + plain detail attached; the legacy message shape is kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { detail: "this action requires the owner role or the 'manage_autonomy' permission" })));
    const e = (await sendJSON("POST", "/api/containers/abc/wakes", { enabled: false }).catch((x) => x)) as ApiError;
    expect(e.status).toBe(403);
    expect(e.detail).toBe("this action requires the owner role or the 'manage_autonomy' permission");
    expect(e.message).toBe("/api/containers/abc/wakes → 403: this action requires the owner role or the 'manage_autonomy' permission");
  });
  it("sendJSON: a 422 array detail is readable text, never [object Object]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(422, { detail: [{ loc: ["body", "level"], msg: "Input should be 'plan', 'pr' or 'full'" }] })));
    const e = (await sendJSON("POST", "/api/containers/abc/autonomy", {}).catch((x) => x)) as ApiError;
    expect(e.detail).toBe("level: Input should be 'plan', 'pr' or 'full'");
    expect(e.message).not.toMatch(/object Object|\[\{/);
  });
  it("sendJSON: non-JSON error body → status only, no detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }) as unknown as Response));
    const e = (await sendJSON("DELETE", "/api/x").catch((x) => x)) as ApiError;
    expect(e.status).toBe(502);
    expect(e.detail).toBeUndefined();
    expect(e.message).toBe("/api/x → 502");
  });
  it("getJSON: status + detail attached, message unchanged ('<url> → 403')", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { detail: "not a member of this project" })));
    const e = (await getJSON("/api/containers/c1").catch((x) => x)) as ApiError;
    expect(e.status).toBe(403);
    expect(e.detail).toBe("not a member of this project");
    expect(e.message).toBe("/api/containers/c1 → 403");
  });
});

describe("mapSnapshot: escalated requests", () => {
  const base = { container: { id: "c1" }, agents: [{ id: "h1", alias: "o", kind: "human", status: "idle" }], tasks: [] };
  it("legacy status, additive `escalated` flag and `escalated_at` all map to escalated", () => {
    const s = mapSnapshot({
      ...base,
      requests: [
        { id: "r1", status: "escalated", requester_id: "h1", target_id: "h1" },
        { id: "r2", status: "open", escalated: true, requester_id: "h1", target_id: "h1" },
        { id: "r3", status: "open", escalated_at: "2026-09-28T10:00:00Z", requester_id: "h1", target_id: "h1" },
        { id: "r4", status: "open", requester_id: "h1", target_id: "h1" },
        { id: "r5", status: "open", escalated: false, requester_id: "h1", target_id: "h1" },
      ],
    });
    expect(s.requests.map((r) => r.escalated)).toEqual([true, true, true, false, false]);
    expect(s.requests[1].status).toBe("open"); // status passes through unchanged
  });
});
