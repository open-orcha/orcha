/**
 * Composer send-path regression tests (port of the vanilla
 * conversation-composer.js sequencing):
 *   - dup-send guard: send() funnels through ONE guarded path — a second
 *     click/Enter while the POST is in flight is a no-op (exactly one POST);
 *   - the lost-attachment race: the tray is cleared OPTIMISTICALLY at send,
 *     but the staged refs live on pendingLocal — the POST body still carries
 *     them, a failure returns them to the tray (with the composer text), and
 *     Retry re-submits EXACTLY the failed content + refs.
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
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString() },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    // module-level per-agent conv cache (ISS-68) — cache-cold ids per test
    { id: "d1", alias: "Dup", kind: "ai", role: "Builder", status: "idle" },
    { id: "d2", alias: "Race", kind: "ai", role: "Builder", status: "idle" },
    { id: "d3", alias: "Key", kind: "ai", role: "Builder", status: "idle" },
  ],
  tasks: [],
  requests: [],
};
const agentOf = (id: string) => RAW_SNAPSHOT.agents.find((a) => a.id === id) as unknown as Agent;

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

// turnPlan: a queue of behaviors for successive POST /turns calls —
// "hold" (resolve ok on release()), "fail" (500), "ok".
function stubFetch(turnPlan: ("hold" | "fail" | "ok")[] = []) {
  calls = [];
  let turnIdx = 0;
  let release: (() => void) | null = null;
  const held = new Promise<void>((res) => { release = res; });
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, method: init?.method || "GET", body: init?.body });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
    if (url.includes("/conversation?limit=")) return jsonRes({ conversation: null, turns: [] });
    if (/\/api\/agents\/[^/]+\/conversations$/.test(url)) return jsonRes({ conversation: { id: "cX" } });
    if (/\/attachments$/.test(url))
      return jsonRes({ id: "abc_shot.png", name: "shot.png", size: 1234, kind: "image", url: "/api/conversations/cX/attachments/abc_shot.png" });
    if (/\/turns$/.test(url) && init?.method === "POST") {
      const mode = turnPlan[turnIdx++] || "ok";
      const seq = turnIdx;
      if (mode === "fail") return { ok: false, status: 500, json: async () => ({}) } as Response;
      if (mode === "hold") return held.then(() => jsonRes({ turn: { id: "t" + seq, seq, role: "human", content: "x" } }));
      return jsonRes({ turn: { id: "t" + seq, seq, role: "human", content: "x" } });
    }
    if (url.includes("/turns")) return jsonRes({ turns: [] }); // poll
    return jsonRes({});
  }) as unknown as typeof fetch;
  return { release: () => release && release() };
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

const turnPosts = () => calls.filter((c) => /\/turns$/.test(c.url) && c.method === "POST");
const ta = (c: HTMLElement) => c.querySelector("#convInput") as HTMLTextAreaElement;
const sendBtn = (c: HTMLElement) => c.querySelector("#convSend") as HTMLButtonElement;

describe("composer send sequencing (vanilla conversation-composer.js parity)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("dup-send guard: two rapid activations POST exactly one turn (the second is a no-op)", async () => {
    const { release } = stubFetch(["hold"]);
    const { container } = mount(agentOf("d1"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/agents/d1/conversation?limit="))).toBe(true));

    fireEvent.change(ta(container), { target: { value: "once please" } });
    // double-click race: both activations land before the POST resolves
    fireEvent.click(sendBtn(container));
    fireEvent.click(sendBtn(container));
    // held-key repeat: Enter while still in flight is a no-op too
    fireEvent.keyDown(ta(container), { key: "Enter" });

    // the optimistic pending bubble is up and the button is down with a spinner
    await waitFor(() => expect(container.querySelector(".turn.pending")).toBeTruthy());
    expect(container.querySelector(".turn.pending")!.textContent).toContain("sending…");
    expect(sendBtn(container).disabled).toBe(true);

    release();
    await waitFor(() => expect(container.querySelector(".turn.pending")).toBeNull());
    expect(turnPosts()).toHaveLength(1);
    const body = JSON.parse(String(turnPosts()[0].body));
    expect(body.content).toBe("once please");
  });

  it("the lost-attachment race: refs ride the POST despite the optimistic tray clear; failure restores them; Retry re-sends them", async () => {
    stubFetch(["fail", "ok"]);
    const { container } = mount(agentOf("d2"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/agents/d2/conversation?limit="))).toBe(true));

    // stage + upload an attachment
    const input = container.querySelector("#convAttachInput") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["png-bytes"], "shot.png", { type: "image/png" })] } });
    await waitFor(() => expect(container.querySelector("#convTray")?.textContent).toContain("shot.png"));

    fireEvent.change(ta(container), { target: { value: "look at this" } });
    fireEvent.click(sendBtn(container));

    // failure: the POST carried the staged ref (cleared-tray race closed) …
    await waitFor(() => expect(turnPosts()).toHaveLength(1));
    expect(JSON.parse(String(turnPosts()[0].body)).attachments).toEqual([{ id: "abc_shot.png", name: "shot.png" }]);
    // … the pending bubble flips to failed with an explicit Retry
    await waitFor(() => expect(container.querySelector(".turn.pending.failed")).toBeTruthy());
    expect(container.querySelector(".conv-sendfail")!.textContent).toContain("Send failed (500)");
    // nothing lost: the staged refs are back in the tray and the composer got the text back
    expect(container.querySelector("#convTray")?.textContent).toContain("shot.png");
    expect(ta(container).value).toBe("look at this");

    // Retry re-submits EXACTLY the failed content + refs through the same path
    fireEvent.click(container.querySelector("[data-retrysend]") as HTMLButtonElement);
    await waitFor(() => expect(turnPosts()).toHaveLength(2));
    const retry = JSON.parse(String(turnPosts()[1].body));
    expect(retry.content).toBe("look at this");
    expect(retry.attachments).toEqual([{ id: "abc_shot.png", name: "shot.png" }]);
    // success settles: bubble gone, tray + composer stay clear (no doubled text)
    await waitFor(() => expect(container.querySelector(".turn.pending")).toBeNull());
    expect(container.querySelector("#convTray")?.textContent || "").not.toContain("shot.png");
    expect(ta(container).value).toBe("");
  });

  it("success reconciles the returned turn once (no duplicate paint) and clears draft + tray", async () => {
    stubFetch(["ok"]);
    const { container } = mount(agentOf("d3"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/agents/d3/conversation?limit="))).toBe(true));

    fireEvent.change(ta(container), { target: { value: "hello" } });
    fireEvent.click(sendBtn(container));
    await waitFor(() => expect(turnPosts()).toHaveLength(1));
    await waitFor(() => expect(container.querySelector(".turn.pending")).toBeNull());
    // the durable turn the POST returned painted exactly once
    expect(container.querySelectorAll(".turn.human").length).toBe(1);
    expect(ta(container).value).toBe("");
    expect(sessionStorage.getItem("orcha:convdraft:d3")).toBeNull(); // ISS-64 draft dropped
  });
});
