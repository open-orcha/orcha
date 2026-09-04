/**
 * #337 conversation-attachment behavioral tests, ported from the pytest node
 * harnesses that used to eval static/conversation.js
 * (tests/test_iss337_conversation_attachments_ui.py): the real upload→send path
 * against stubbed fetch — conv-scoped upload URL, get-or-create-first ordering,
 * the attachment ref riding the turn POST — and the Gate P1 stale-upload /
 * remount race (an upload started for agent A must never leak into agent B's
 * conversation or turn).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";

interface Call {
  url: string;
  method: string;
  body?: BodyInit | null;
}
let calls: Call[] = [];

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    { id: "a1", alias: "Frame", kind: "ai", role: "Builder", status: "idle" },
    // a3/a4 are used by the race test — Conversation keeps a module-level
    // per-agent cache, so each test needs cache-cold agent ids.
    { id: "a3", alias: "Quill", kind: "ai", role: "Scribe", status: "idle" },
    { id: "a4", alias: "Page", kind: "ai", role: "Writer", status: "idle" },
  ],
  tasks: [],
  requests: [],
};
const AGENT_A = RAW_SNAPSHOT.agents[1] as unknown as Agent;
const AGENT_C = RAW_SNAPSHOT.agents[2] as unknown as Agent;
const AGENT_D = RAW_SNAPSHOT.agents[3] as unknown as Agent;

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

// holdA: when set, agent A's get-or-create POST is HELD OPEN until release() —
// the deterministic Gate P1 race (no timing dependence).
function stubFetch(opts?: { holdA?: boolean }) {
  calls = [];
  let releaseA: (() => void) | null = null;
  const aPending = new Promise<void>((res) => { releaseA = res; });
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, method: init?.method || "GET", body: init?.body });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
    if (url.includes("/conversation?limit=")) return jsonRes({ conversation: null, turns: [] }); // load(): none yet
    if (/\/api\/agents\/a1\/conversations$/.test(url)) return jsonRes({ conversation: { id: "cA" } });
    if (/\/api\/agents\/a3\/conversations$/.test(url)) {
      // agent C's get-or-create — HELD OPEN when the race is armed
      if (opts?.holdA) return aPending.then(() => jsonRes({ conversation: { id: "cA" } }));
      return jsonRes({ conversation: { id: "cA" } });
    }
    if (/\/api\/agents\/a4\/conversations$/.test(url)) return jsonRes({ conversation: { id: "cB" } });
    if (/\/attachments$/.test(url))
      return jsonRes({ id: "abc_shot.png", name: "shot.png", size: 1234, kind: "image", url: "/api/conversations/cA/attachments/abc_shot.png" });
    if (url.includes("/turns")) return jsonRes({ turns: [] }); // turns POST / poll
    return jsonRes({});
  }) as unknown as typeof fetch;
  return { release: () => releaseA && releaseA() };
}

function mount(agent: Agent) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        {/* keyed per agent, mirroring AgentsPage's key={agent.id} remount */}
        <Conversation key={agent.id} agent={agent} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const turnPosts = () => calls.filter((c) => /\/turns$/.test(c.url) && c.method === "POST");

describe("#337 conversation attachments (vanilla conversation.js parity)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("upload then send drives the conv-scoped path: get-or-create first, ref on the turn POST", async () => {
    stubFetch();
    const { container } = mount(AGENT_A);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/agents/a1/conversation?limit="))).toBe(true));

    // 1) pick a file -> the input's change handler stages + uploads it
    const input = container.querySelector("#convAttachInput") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["png-bytes"], "shot.png", { type: "image/png" })] } });

    await waitFor(() => {
      const up = calls.find((c) => /\/api\/conversations\/cA\/attachments$/.test(c.url) && c.method === "POST");
      expect(up).toBeTruthy(); // upload hits the CONVERSATION-scoped route
    });
    // ...after get-or-creating the conversation (ordering, not just presence)
    const ensureIdx = calls.findIndex((c) => /\/api\/agents\/a1\/conversations$/.test(c.url) && c.method === "POST");
    const upIdx = calls.findIndex((c) => /\/api\/conversations\/cA\/attachments$/.test(c.url));
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeLessThan(upIdx);
    // multipart: the file rode a FormData body
    expect(calls[upIdx].body).toBeInstanceOf(FormData);

    // staged chip lands in the tray as done
    await waitFor(() => expect(container.querySelector("#convTray")?.textContent).toContain("shot.png"));

    // 2) type + send -> the turn POST carries the uploaded {id,name} ref
    fireEvent.change(container.querySelector("#convInput") as HTMLTextAreaElement, { target: { value: "look at this" } });
    fireEvent.click(container.querySelector("#convSend") as HTMLButtonElement);

    await waitFor(() => expect(turnPosts()).toHaveLength(1));
    const turn = turnPosts()[0];
    expect(turn.url).toBe("/api/conversations/cA/turns");
    const body = JSON.parse(String(turn.body));
    expect(body.role).toBe("human");
    expect(body.author_agent_id).toBe("h1");
    expect(body.content).toBe("look at this");
    expect(body.attachments).toEqual([{ id: "abc_shot.png", name: "shot.png" }]);
    // the tray clears once sent
    await waitFor(() => expect(container.querySelector("#convTray")?.textContent).not.toContain("shot.png"));
  });

  it("Gate P1: a stale upload/remount race never leaks agent A's conversation or attachment into B", async () => {
    const { release } = stubFetch({ holdA: true });
    // mount agent C, then pick a file -> uploadConvFiles fires C's get-or-create (which HANGS)
    const first = mount(AGENT_C);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/agents/a3/conversation?limit="))).toBe(true));
    const inputA = first.container.querySelector("#convAttachInput") as HTMLInputElement;
    fireEvent.change(inputA, { target: { files: [new File(["png-bytes"], "shot.png", { type: "image/png" })] } });
    await waitFor(() => expect(calls.some((c) => /\/api\/agents\/a3\/conversations$/.test(c.url) && c.method === "POST")).toBe(true));

    // switch to agent D BEFORE C's get-or-create resolves (keyed remount)
    first.unmount();
    const second = mount(AGENT_D);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/agents/a4/conversation?limit="))).toBe(true));

    // now A's stale conversation-create (and upload) resolve — must not apply to B
    release();
    await new Promise((r) => setTimeout(r, 30));

    // send from B
    fireEvent.change(second.container.querySelector("#convInput") as HTMLTextAreaElement, { target: { value: "message to B" } });
    fireEvent.click(second.container.querySelector("#convSend") as HTMLButtonElement);

    await waitFor(() => expect(turnPosts().length).toBeGreaterThan(0));
    const posts = turnPosts();
    // B's turn goes to B's OWN conversation — the stale A create never crossed over
    expect(posts[posts.length - 1].url).toBe("/api/conversations/cB/turns");
    expect(posts.some((c) => c.url.includes("/api/conversations/cA/turns"))).toBe(false);
    // A's attachment never staged into B's tray, so it can't ride B's turn
    const body = JSON.parse(String(posts[posts.length - 1].body));
    expect(body.content).toBe("message to B");
    expect(body.attachments).toBeUndefined();
    expect(String(posts[posts.length - 1].body)).not.toContain("abc_shot.png");
    expect(second.container.querySelector("#convTray")?.textContent || "").not.toContain("shot.png");
  });
});
