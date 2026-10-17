/** The agent-limit cap: parsing the decide 409 and the one sentence every caller shows. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCapNotice, agentCapMessage, agentCapOf, agentLimitFacts } from "./agentCap";

const capErr = (detail: string, status = 409) =>
  Object.assign(new Error("/api/agent-suggestions/r1/decide → " + status + ": " + detail), { status, detail });

afterEach(cleanup);

describe("agentCapOf", () => {
  it("reads the server's cap 409 (in use + limit)", () => {
    const e = capErr("this project already has 3 suggested agents (the limit is 3). Reassign the work to an existing agent, or retire an agent created from a suggestion.");
    expect(agentCapOf(e)).toEqual({ inUse: 3, limit: 3 });
    expect(agentCapOf(capErr("this project already has 1 suggested agent (the limit is 1). …"))).toEqual({ inUse: 1, limit: 1 });
  });
  it("reads the older 'N-agent cap' wording, filling in-use from the snapshot", () => {
    const e = capErr("container is at the 3-agent cap. Reassign to an existing agent or raise containers.max_auto_agents.");
    expect(agentCapOf(e, { inUse: 5 })).toEqual({ limit: 3, inUse: 5 });
    expect(agentCapOf(e)).toEqual({ limit: 3, inUse: 3 });
  });
  it("is null for anything that is not the cap", () => {
    expect(agentCapOf(capErr("alias 'dba' already exists in this container"))).toBeNull();
    expect(agentCapOf(capErr("this project already has 3 suggested agents (the limit is 3)", 403))).toBeNull();
    expect(agentCapOf(new Error("Failed to fetch"))).toBeNull();
    expect(agentCapOf(null)).toBeNull();
  });
  it("agentLimitFacts reads the snapshot container", () => {
    expect(agentLimitFacts({ container: { max_auto_agents: 12, auto_agents_in_use: 4 } })).toEqual({ limit: 12, inUse: 4 });
    expect(agentLimitFacts(null)).toEqual({ limit: undefined, inUse: undefined });
  });
});

describe("agentCapMessage / AgentCapNotice", () => {
  it("says the limit plainly, never a path or status", () => {
    const m = agentCapMessage({ limit: 3, inUse: 3 });
    expect(m).toBe("This project allows up to 3 suggested agents and already has 3. Raise the limit in Settings → Execution, or reassign this work to an existing agent.");
    expect(m).not.toMatch(/\/api|409/);
    expect(agentCapMessage({ limit: 1, inUse: 1 })).toContain("up to 1 suggested agent and");
  });
  it("links to Settings → Execution only for people who can raise it", () => {
    render(<MemoryRouter><AgentCapNotice cap={{ limit: 3, inUse: 3 }} canRaise /></MemoryRouter>);
    expect(screen.getByRole("alert").textContent).toContain("This project allows up to 3 suggested agents");
    expect(screen.getByRole("link", { name: /Open Settings → Execution/ }).getAttribute("href")).toBe("/settings#tab=execution");
    cleanup();
    render(<MemoryRouter><AgentCapNotice cap={{ limit: 3, inUse: 3 }} canRaise={false} /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: /Settings/ })).toBeNull();
  });
});
