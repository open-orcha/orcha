/**
 * GH #301 — a chat whose worker cannot start because of the project's Git setup:
 *   - the waiting message gets a lasting "can't start yet" notice carrying the
 *     backend's reason (never "answered on the next wake", never thinking dots);
 *   - when the backend says a project-local setup can fix it, ONE deliberate
 *     "Set up Git for this project" button posts the request as the acting human
 *     and the notice then says the setup was requested (no second button);
 *   - a blocker setup cannot fix (the parent repository tracks the folder) shows the
 *     reason with no button; a failed setup shows why and offers the button again;
 *   - a rejected request keeps the button and toasts the server's reason;
 *   - no block from the backend → the normal indicator, no notice.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation, SETUP_LABEL } from "./Conversation";

// one cache-cold agent id per scenario (Conversation keeps a per-agent module cache)
const AGENT_IDS = ["sb1", "sb2", "sb3", "sb4", "sb5", "sb6"];
const AI = (id: string) => ({ id, alias: "atlas-" + id, kind: "ai", role: "Builder", status: "idle" });
const RAW_AGENTS = [{ id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" }].concat(AGENT_IDS.map(AI));
const agentOf = (id: string) => RAW_AGENTS.find((a) => a.id === id) as unknown as Agent;

const REASON =
  "The project folder /x/Sample is not its own Git repository, and Git found an empty Git repository with no commits in a parent folder (/x).";
const humanTurn = [{ seq: 1, role: "human", content: "hi", author_agent_id: "h1" }];
const blocked = (extra: Record<string, unknown> = {}) => ({ reason: REASON, blocker: "ancestor_repo", at: 1, setup_available: true, setup: null, ...extra });

const PAYLOADS: Record<string, unknown> = {
  sb1: { conversation: { id: "cv-sb1", status: "active" }, turns: humanTurn, startup_blocked: blocked() },
  sb2: { conversation: { id: "cv-sb2", status: "active" }, turns: humanTurn, startup_blocked: blocked() },
  sb3: { conversation: { id: "cv-sb3", status: "active" }, turns: humanTurn, startup_blocked: blocked({ setup_available: false }) },
  sb4: {
    conversation: { id: "cv-sb4", status: "active" },
    turns: humanTurn,
    startup_blocked: blocked({ setup: { state: "failed", detail: "Orcha could not create a Git repository in /x/Sample.", at: 2 } }),
  },
  sb5: { conversation: { id: "cv-sb5", status: "active" }, turns: humanTurn, startup_blocked: null },
  sb6: { conversation: { id: "cv-sb6", status: "active" }, turns: humanTurn, startup_blocked: blocked() },
};

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;

let posts: { url: string; body: any }[] = [];

function stubFetch(setupStatus = 202) {
  posts = [];
  const container = { id: "c1", name: "Sample", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString() };
  const snapshot = { container, agents: RAW_AGENTS, tasks: [], requests: [] };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init && init.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/conversation/repository-setup")) {
        return setupStatus < 400
          ? jsonRes({ setup: { state: "requested", at: 3 }, created: true }, setupStatus)
          : jsonRes({ detail: "this chat is not blocked by a repository setup Orcha can do" }, setupStatus);
      }
      return jsonRes({});
    }
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    const m = url.match(/\/api\/agents\/([^/]+)\/conversation\?limit=/);
    if (m) return jsonRes(PAYLOADS[m[1]] ?? { conversation: null, turns: [] });
    const c = url.match(/\/api\/conversations\/cv-([^/?]+)$/);
    if (c) {
      const p = PAYLOADS[c[1]] as any;
      return jsonRes({ conversation: p.conversation, startup_blocked: p.startup_blocked });
    }
    if (url.includes("/turns")) return jsonRes({ turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount(agent: Agent) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Conversation key={agent.id} agent={agent} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const setupButton = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === SETUP_LABEL) || null;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GH #301 — startup blocked by the project's Git setup", () => {
  it("shows a lasting notice with the reason and the setup action — not 'next wake', not thinking dots", async () => {
    stubFetch();
    const { container } = mount(agentOf("sb1"));
    await waitFor(() => expect(container.querySelector(".conv-blocked")).toBeTruthy());
    expect(container.querySelector(".conv-blocked")!.textContent).toContain(REASON);
    expect(container.textContent).toContain("can’t start yet");
    expect(container.textContent).not.toContain("next wake");
    expect(container.querySelector(".conv-thinking")).toBeNull();
    expect(setupButton(container)).toBeTruthy();
    expect(container.querySelector(".conv-blocked-note")!.textContent).toContain("any parent repository stay as they are");
    // the waiting turn itself only says "saved"; the notice carries the why
    expect(container.querySelector(".turn.human .dlv")!.textContent).toBe("saved");
  });

  it("the button posts ONE setup request as the acting human, then says it was requested", async () => {
    stubFetch();
    const { container } = mount(agentOf("sb2"));
    await waitFor(() => expect(setupButton(container)).toBeTruthy());
    fireEvent.click(setupButton(container)!);
    await waitFor(() => expect(container.textContent).toContain("Setup requested"));
    const setupPosts = posts.filter((p) => p.url.endsWith("/conversation/repository-setup"));
    expect(setupPosts).toHaveLength(1);
    expect(setupPosts[0].url).toBe("/api/agents/sb2/conversation/repository-setup");
    expect(setupPosts[0].body).toEqual({ actor_agent_id: "h1" });
    expect(setupButton(container)).toBeNull(); // no second request while one is waiting
    expect(container.querySelector(".conv-blocked")!.textContent).toContain(REASON); // still truthful until a worker starts
  });

  it("a blocker setup cannot fix shows the reason with no button", async () => {
    stubFetch();
    const { container } = mount(agentOf("sb3"));
    await waitFor(() => expect(container.querySelector(".conv-blocked")).toBeTruthy());
    expect(setupButton(container)).toBeNull();
  });

  it("a failed setup says why and offers the action again", async () => {
    stubFetch();
    const { container } = mount(agentOf("sb4"));
    await waitFor(() => expect(container.querySelector(".conv-blocked-failed")).toBeTruthy());
    expect(container.querySelector(".conv-blocked-failed")!.textContent).toContain("Orcha could not create a Git repository in /x/Sample.");
    expect(setupButton(container)).toBeTruthy();
  });

  it("no block from the backend → no notice, the normal indicator", async () => {
    stubFetch();
    const { container } = mount(agentOf("sb5"));
    await waitFor(() => expect(container.querySelector(".turn.human")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".conv-thinking, .conv-queued")).toBeTruthy());
    expect(container.querySelector(".conv-blocked")).toBeNull();
    expect(setupButton(container)).toBeNull();
  });

  it("a rejected request keeps the button and shows the server's reason", async () => {
    stubFetch(409);
    const { container } = mount(agentOf("sb6"));
    await waitFor(() => expect(setupButton(container)).toBeTruthy());
    fireEvent.click(setupButton(container)!);
    await waitFor(() => expect(document.body.textContent).toContain("not blocked by a repository setup Orcha can do"));
    expect(setupButton(container)).toBeTruthy();
    expect(container.textContent).not.toContain("Setup requested");
  });
});
