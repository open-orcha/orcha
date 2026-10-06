/**
 * <AgentConfigHistory> — the history list, diff view, restore confirm and gating.
 * The snapshot/authority layer is stubbed so each case sets exactly who is acting.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import type { Identity } from "../../../extensions";
import type { Agent } from "../../../types";

const auth: { human: { id: string; alias: string; kind: string } | null; identity: Identity | null; reason: string | null } = {
  human: { id: "h1", alias: "Boss", kind: "human" },
  identity: null,
  reason: null,
};

vi.mock("../../../state/SnapshotProvider", async (orig) => {
  const m = await orig<typeof import("../../../state/SnapshotProvider")>();
  return {
    ...m,
    useSnapshot: () => ({ snap: { agents: [] }, identity: auth.identity }),
    useActingAuthority: () => ({ human: auth.human, readOnly: !auth.human, pending: false, reason: auth.reason }),
    actingHuman: () => auth.human,
  };
});

import { AgentConfigHistory } from "./AgentConfigHistory";

const AGENT = {
  id: "a1", alias: "forge", kind: "ai", role: "Builder", model: "claude-sonnet-5", status: "idle",
  reasoning_effort: null, auto_wake_interval_secs: null, autonomy_override: null, prompt_preview: "Be terse.\nShip.",
} as unknown as Agent;

const REVS = [
  {
    revision_no: 4, kind: "restore", source: "profile", restored_from: 2, reason: "regressed",
    actor: { agent_id: "h1", alias: "Boss", kind: "human" }, redacted_fields: [], created_at: new Date().toISOString(),
    changes: [{ field: "system_prompt", before: "Be verbose.\nShip.", after: "Be terse.\nShip." }],
  },
  {
    revision_no: 3, kind: "change", source: "model", restored_from: null, reason: null,
    actor: null, redacted_fields: [], created_at: new Date().toISOString(),
    changes: [{ field: "model", before: "claude-opus-5", after: "claude-sonnet-5" }],
  },
  {
    revision_no: 2, kind: "change", source: "profile", restored_from: null, reason: null,
    actor: { agent_id: "h1", alias: "Boss", kind: "human" }, redacted_fields: [], created_at: new Date().toISOString(),
    changes: [{ field: "system_prompt", before: "Be terse.\nShip.", after: "Be verbose.\nShip." }],
  },
  {
    revision_no: 1, kind: "initial", source: "backfill", restored_from: null, reason: null,
    actor: null, redacted_fields: [], created_at: new Date().toISOString(), changes: [],
  },
];

function detail(n: number, over: Record<string, unknown> = {}) {
  const r = REVS.find((x) => x.revision_no === n)!;
  return {
    ...r,
    snapshot: { alias: "forge", role: "Builder", system_prompt: "Be terse.\nShip.", model: "claude-opus-5", provider: "claude",
      reasoning_effort: null, auto_wake_interval_secs: null, autonomy_override: null },
    restore_preview: [{ field: "model", current: "claude-sonnet-5", target: "claude-opus-5", grant: "manage_agents" }],
    restore_blocked: [],
    ...over,
  };
}

let calls: { url: string; init?: RequestInit }[] = [];
let detailOver: Record<number, Record<string, unknown>> = {};

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  calls = [];
  detailOver = {};
  auth.human = { id: "h1", alias: "Boss", kind: "human" };
  auth.identity = null;
  auth.reason = null;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const m = /config-revisions\/(\d+)(\/restore)?$/.exec(url);
    if (m && m[2]) return json({ agent_id: "a1", restored_from: Number(m[1]), applied: ["model"], revisions: [] });
    if (m) return json(detail(Number(m[1]), detailOver[Number(m[1])]));
    return json({ agent_id: "a1", latest_revision_no: 4, total: 4, revisions: REVS, next_before: null });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<ToastProvider><AgentConfigHistory agent={AGENT} /></ToastProvider>);

describe("AgentConfigHistory", () => {
  it("E02: a failed history read says why and offers Retry, which re-reads", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      calls.push({ url });
      if (fail) return json({ detail: "database unavailable" }, 503);
      return json({ agent_id: "a1", latest_revision_no: 4, total: 4, revisions: REVS, next_before: null });
    }));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load history — database unavailable");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "History" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists revisions as activity rows with truthful actors", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent(/Boss restored prompt from #2/);
    expect(rows[0]).toHaveTextContent("Current");
    expect(rows[1]).toHaveTextContent(/Unattributed changed model/);
    expect(rows[3]).toHaveTextContent(/Initial configuration captured/);
    expect(screen.getByText("4")).toHaveClass("ach-count");
  });

  it("expands a prompt revision into a line text diff and a model revision into old → new", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    fireEvent.click(within(list).getAllByRole("button")[2]);
    const pre = await screen.findByLabelText("Prompt text diff");
    const lines = pre.querySelectorAll(".ach-dl");
    expect(Array.from(lines).map((l) => l.getAttribute("data-kind"))).toEqual(["del", "add", "same"]);
    expect(pre).toHaveTextContent("Be verbose.");
    expect(screen.getByLabelText("1 lines added, 1 removed")).toBeInTheDocument();
    fireEvent.click(within(list).getAllByRole("button")[1]);
    expect(await screen.findByText("Opus 5")).toHaveClass("ach-old");
    expect(screen.getByText("Sonnet 5")).toHaveClass("ach-new");
  });

  it("restore: confirm lists the exact preview, then POSTs as the acting human with the reason", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    fireEvent.click(within(list).getAllByRole("button")[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    const dlg = await screen.findByRole("dialog", { name: "Restore revision #3?" });
    expect(within(dlg).getByLabelText("What will change")).toHaveTextContent(/Model\s*Sonnet 5\s*Opus 5/);
    fireEvent.change(within(dlg).getByPlaceholderText("Why roll back?"), { target: { value: "sonnet too weak" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/config-revisions/3/restore"))).toBe(true));
    const post = calls.find((c) => c.url.endsWith("/restore"))!;
    expect(post.init?.method).toBe("POST");
    expect(JSON.parse(String(post.init?.body))).toEqual({ actor_agent_id: "h1", reason: "sonnet too weak" });
    expect(await screen.findByText("Restored from #3")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancel closes the confirm without restoring", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    fireEvent.click(within(list).getAllByRole("button")[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/restore"))).toBe(false);
  });

  it("viewers read the history but cannot restore", async () => {
    auth.identity = { agent_id: "v1", member_role: "viewer" };
    auth.human = null;
    auth.reason = "Viewers have read-only access";
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    fireEvent.click(within(list).getAllByRole("button")[1]);
    const btn = await screen.findByRole("button", { name: "Restore this version" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription("Viewers have read-only access");
  });

  it("a restore touching autonomy needs manage_autonomy (a manage_agents-only member is refused)", async () => {
    auth.identity = { agent_id: "h1", member_role: "member", grants: ["manage_agents"] };
    detailOver[3] = { restore_preview: [{ field: "autonomy_override", current: null, target: "full", grant: "manage_autonomy" }] };
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    fireEvent.click(within(list).getAllByRole("button")[1]);
    const btn = await screen.findByRole("button", { name: "Restore this version" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/manage_autonomy/);
  });

  it("says when the live config already matches, and when a restore is blocked", async () => {
    detailOver[4] = { restore_preview: [] };
    detailOver[2] = { restore_preview: [], restore_blocked: [{ field: "system_prompt", reason: "contained a secret that was never stored, so it cannot be restored" }] };
    mount();
    const list = await screen.findByRole("list", { name: "History" });
    fireEvent.click(within(list).getAllByRole("button")[0]);
    expect(await screen.findByText(/current configuration matches this version/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    fireEvent.click(within(list).getAllByRole("button")[2]);
    expect(await screen.findByText(/Can't restore: Prompt contained a secret/)).toBeInTheDocument();
  });

  it("filter pills query the server (field / kind)", async () => {
    mount();
    await screen.findByRole("list", { name: "History" });
    fireEvent.click(screen.getByRole("radio", { name: /Prompt/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("field=system_prompt"))).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: /Restores/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("kind=restore"))).toBe(true));
  });
});
