/**
 * Parity round 1 — integration of the fixers' cross-file requests:
 *  - SnapshotPending names a 403 / 404 (not "the backend did not answer" + Retry);
 *  - Shell re-exports the ONE snapshotErrorKind (state/SnapshotProvider);
 *  - provider-key / GitHub-PAT failures read as words, never a bare "(403)";
 *  - the pairing dialog takes focus itself (every entry point);
 *  - escalation origin (`escalated_from_alias`, `escalated_at`) is mapped.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SnapshotProvider, snapshotErrorKind as providerKind } from "./state/SnapshotProvider";
import { snapshotErrorKind as shellKind } from "./shell/Shell";
import { SnapshotPending } from "./components/SnapshotPending";
import { pkErrText } from "./cloud/settings/ProviderKeysSection";
import { gaErrText } from "./cloud/settings/GitHubAccessSection";
import { PairingModal } from "./cloud/projects/PairingModal";
import { mapSnapshot } from "./api/client";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function pendingWith(status: number) {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: "c1" }] } as Response);
    return Promise.resolve({ ok: false, status, json: async () => ({ detail: "nope" }) } as Response);
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter initialEntries={["/tasks?cid=c1"]}>
      <SnapshotProvider pollMs={60_000}><SnapshotPending label="Loading tasks" what="tasks" /></SnapshotProvider>
    </MemoryRouter>,
  );
}

describe("SnapshotPending: an answer is not an outage", () => {
  it("403 → not a member, no Retry", async () => {
    pendingWith(403);
    expect(await screen.findByText("You're not a member of this project")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/did not answer/)).toBeNull();
  });
  it("404 → project not found, no Retry", async () => {
    pendingWith(404);
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("one snapshot error classifier", () => {
  it("Shell's export is the provider's function", () => {
    expect(shellKind).toBe(providerKind);
    expect(shellKind("/api/containers/x → 403")).toBe("forbidden");
  });
});

describe("settings key failures read as words", () => {
  it("server detail wins; else the status meaning; never '(403)'", () => {
    expect(pkErrText({ ok: false, status: 403, body: { detail: "this action requires the owner role or the manage_keys permission" } }))
      .toBe("this action requires the owner role or the manage_keys permission");
    expect(pkErrText({ ok: false, status: 403, body: null })).toBe("you don't have permission to change this");
    expect(gaErrText({ status: 422, body: { detail: [{ loc: ["body", "token"], msg: "too short" }] } })).toBe("token: too short");
    expect(gaErrText({ status: 0, body: null })).toBe("couldn't reach Embodent");
    expect(gaErrText({ status: 403, body: null })).not.toMatch(/\(403\)/);
  });
});

describe("PairingModal takes focus itself", () => {
  it("focus lands on Close when it opens", async () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    render(<PairingModal cid="c1" identity={null} onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement?.id).toBe("pairClose"));
  });
});

describe("mapSnapshot: escalation origin", () => {
  it("maps escalated_at and the original target alias", () => {
    const s = mapSnapshot({
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "hubot", kind: "human", status: "idle" }, { id: "a1", alias: "scout", kind: "ai", status: "idle" }],
      tasks: [],
      requests: [
        { id: "r1", status: "open", escalated: true, escalated_at: "2026-09-28T10:00:00Z", escalated_from_alias: "scout", requester_id: "a1", target_id: "h1" },
        { id: "r2", status: "open", escalated: true, escalated_from_id: "a1", requester_id: "a1", target_id: "h1" },
        { id: "r3", status: "open", requester_id: "a1", target_id: "h1" },
      ],
    });
    expect(s.requests[0].escalated_at).toBe("2026-09-28T10:00:00Z");
    expect(s.requests[0].escalated_from).toBe("scout");
    expect(s.requests[1].escalated_from).toBe("scout");
    expect(s.requests[2].escalated_from).toBeNull();
  });
});
