/**
 * Parity round 1 (onboarding-state fixer):
 *  - e2e-permissions-14: a viewer / member without `manage_agents` never gets a
 *    create-agent form that ends in a 403 — ?new=1 renders a read-only state
 *    and the fork's agent actions are disabled with the reason;
 *  - home EXTRA: one "Propose my roster" click sends ONE propose POST, even
 *    under React.StrictMode's dev double-run of effects;
 *  - wave-4: the roster commit says how many agents you'll review; the fork's
 *    task count excludes the root task (matches the Projects table).
 */
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingAuth, _setActingIdentity } from "../../state/SnapshotProvider";
import { AGENT_GRANT_REASON, AGENT_VIEWER_REASON, KEY, agentCreateDenial, commitLabel, forkCounts } from "./logic";
import { OnboardingPage } from "./OnboardingPage";

let rawSnapshot: unknown;
let proposeCalls: number;
let agentPosts: number;

function jsonRes(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}
function sseBody(frames: string[]) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(f));
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => (i < chunks.length ? { done: false as const, value: chunks[i++] } : { done: true as const, value: undefined }),
        cancel: async () => {},
      };
    },
  };
}

const team = {
  container: { id: "c1", name: "orcha-web" },
  agents: [
    { id: "h1", alias: "hussein", kind: "human", status: "idle", member_role: "owner" },
    { id: "h2", alias: "tomas", kind: "human", status: "idle", member_role: "viewer" },
    { id: "h3", alias: "amina", kind: "human", status: "idle", member_role: "member" },
    { id: "a1", alias: "lead", kind: "ai", status: "idle" },
  ],
  tasks: [
    { id: "t0", title: "Objective", status: "in_progress", is_root: true },
    { id: "t1", title: "x", status: "ready" },
    { id: "t2", title: "y", status: "completed" },
  ],
  requests: [],
};

beforeEach(() => {
  localStorage.clear();
  proposeCalls = 0;
  agentPosts = 0;
  rawSnapshot = team;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/onboarding/propose") {
      proposeCalls += 1;
      return { ok: true, status: 200, body: sseBody(['data:{"event":"error","code":"invalid_goal","message":"too vague"}\n\n']) } as unknown as Response;
    }
    if (url === "/api/models") return jsonRes({ models: [{ id: "m1", name: "Model One" }], default: "m1" });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/agents" && init?.method === "POST") {
      agentPosts += 1;
      return jsonRes({ detail: "forbidden" }, false, 403);
    }
    if (url.startsWith("/api/containers/")) return jsonRes(rawSnapshot);
    return jsonRes({ detail: "not found" }, false, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete extensions.identity;
  delete extensions.identityTrusted;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
});

function signIn(id: Identity) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => true;
}

function renderAt(path: string, strict = false) {
  const tree = (
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <OnboardingPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe("agentCreateDenial (mirrors enforce_grant 'manage_agents')", () => {
  it("owner and granted members may add agents; viewers and ungranted members may not", () => {
    expect(agentCreateDenial(null)).toBeNull(); // trust off / self-host: server decides
    expect(agentCreateDenial({ member_role: "owner", grants: [] })).toBeNull();
    expect(agentCreateDenial({ member_role: "member", grants: ["manage_agents"] })).toBeNull();
    expect(agentCreateDenial({ member_role: "member", grants: ["manage_keys"] })).toBe(AGENT_GRANT_REASON);
    expect(agentCreateDenial({ member_role: "member", grants: null })).toBe(AGENT_GRANT_REASON);
    expect(agentCreateDenial({ member_role: "viewer", grants: ["manage_agents"] })).toBe(AGENT_VIEWER_REASON);
  });
});

describe("e2e-permissions-14: no create-agent form that ends in a 403", () => {
  it("viewer on ?new=1 gets a read-only page, no form, no POST", async () => {
    signIn({ agent_id: "h2", alias: "tomas", member_role: "viewer", grants: [] });
    renderAt("/onboarding?new=1");
    expect(await screen.findByRole("heading", { name: "You can't add agents to this project" })).toBeInTheDocument();
    expect(screen.getByText(AGENT_VIEWER_REASON + ".")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New agent" })).toBeNull();
    expect(screen.queryByLabelText(/System prompt/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Back to Agents/ })).toHaveAttribute("href", "/agents");
    expect(agentPosts).toBe(0);
  });

  it("member without manage_agents: fork's agent actions are disabled with the reason; tasks stay open", async () => {
    signIn({ agent_id: "h3", alias: "amina", member_role: "member", grants: ["manage_keys", "assign_reviewers"] });
    localStorage.setItem(KEY, JSON.stringify({ step: "fork" }));
    renderAt("/onboarding");
    const propose = await screen.findByRole("button", { name: /Propose my roster/ });
    expect(propose).toBeDisabled();
    expect(propose).toHaveAttribute("title", AGENT_GRANT_REASON);
    expect(screen.getByRole("button", { name: /Create an agent/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add tasks/ })).toBeEnabled();
    expect(screen.getByRole("note")).toHaveTextContent(AGENT_GRANT_REASON);
  });

  it("a saved create-agent step for an ungranted member resumes read-only (Back to the fork)", async () => {
    signIn({ agent_id: "h3", alias: "amina", member_role: "member", grants: [] });
    localStorage.setItem(KEY, JSON.stringify({ step: "create-agent" }));
    renderAt("/onboarding");
    expect(await screen.findByRole("heading", { name: "You can't add agents to this project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(await screen.findByRole("heading", { name: "Add to your team" })).toBeInTheDocument();
  });

  it("owner still gets the full New agent form", async () => {
    signIn({ agent_id: "h1", alias: "hussein", member_role: "owner", grants: [] });
    renderAt("/onboarding?new=1");
    expect(await screen.findByRole("heading", { name: "New agent" })).toBeInTheDocument();
    expect(screen.queryByText("You can't add agents to this project")).toBeNull();
  });
});

describe("propose: one click → one POST (StrictMode double-run)", () => {
  it("sends exactly one propose request under StrictMode", async () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "propose-goal", _propose: { goal: "Build a docs site", dialogue: [] } }));
    renderAt("/onboarding", true);
    fireEvent.click(await screen.findByRole("button", { name: /Propose my roster/ }));
    expect(await screen.findByText("Couldn't propose a roster")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(proposeCalls).toBe(1);
  });
});

describe("wave-4 copy + counts", () => {
  it("commit label counts the agents to review", () => {
    expect(commitLabel(3)).toBe("Looks good — review 3 agents");
    expect(commitLabel(1)).toBe("Looks good — review 1 agent");
  });
  it("forkCounts excludes the root task (matches the Projects table)", () => {
    expect(forkCounts(team as never)).toEqual({ agents: 1, tasks: 2 });
  });
  it("the fork shows the root-excluded count", async () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "fork" }));
    renderAt("/onboarding");
    expect(await screen.findByText(/1 agent and 2 tasks/)).toBeInTheDocument();
  });
  it("the roster review's primary button names the agent count", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      step: "propose-roster",
      _roster: {
        rationale: "",
        agents: [
          { name: "atlas", role: "Lead", charter: "lead", model: "m1" },
          { name: "bolt", role: "Builder", charter: "build", model: "m1" },
        ],
        tasks: [],
      },
    }));
    renderAt("/onboarding");
    expect(await screen.findByRole("button", { name: "Looks good — review 2 agents" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/create the team/)).toBeNull());
  });
});
