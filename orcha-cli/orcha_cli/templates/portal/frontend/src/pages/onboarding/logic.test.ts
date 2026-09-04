/**
 * Onboarding pure-logic tests, ported from the pytest node harnesses that used
 * to eval static/onboarding.js (tests/test_onboarding.py + tests/test_iss293_roster_builder.py).
 * Covers: the step machine (railKeyFor/resumeStep), the #140 ghost reconcile,
 * the #339 non-sticky demo flag, and the #293 propose lane (SPEC-292 SSE
 * parsing, roster normalization, roster→commit walk mapping).
 */
import { describe, expect, it } from "vitest";
import {
  CONCIERGE_TEMPLATE,
  normalizeRoster,
  parseSSE,
  railKeyFor,
  reconcileDemoFlag,
  reconcileGhost,
  resumeStep,
  rosterToWalk,
  walkAgentToDraft,
  type OnbState,
} from "./logic";

describe("step machine (railKeyFor / resumeStep)", () => {
  it("maps steps to their rail groups", () => {
    expect(railKeyFor("welcome")).toBe("welcome");
    expect(railKeyFor("fork")).toBe("fork");
    expect(railKeyFor("create-agent")).toBe("build");
    expect(railKeyFor("agent-created")).toBe("build");
    // #293: the propose steps live under the "build" rail group
    expect(railKeyFor("propose-goal")).toBe("build");
    expect(railKeyFor("propose-stream")).toBe("build");
    expect(railKeyFor("propose-roster")).toBe("build");
  });

  it("resumes past welcome when an operator exists (never double-register)", () => {
    expect(resumeStep("welcome", true)).toBe("fork");
    expect(resumeStep("create-agent", false)).toBe("welcome"); // no operator -> back to welcome
    expect(resumeStep("fork", true)).toBe("fork"); // normal continuation
  });

  it("a live propose stream can't survive a reload -> resume re-asks the goal", () => {
    expect(resumeStep("propose-stream", true)).toBe("propose-goal");
    expect(resumeStep("propose-roster", true)).toBe("propose-roster"); // persisted editable roster stays put
  });

  it("the concierge template points at /orcha-suggest-agent", () => {
    expect(CONCIERGE_TEMPLATE).toContain("/orcha-suggest-agent");
    expect(CONCIERGE_TEMPLATE).toContain("self-certify");
  });
});

describe("#140 ghost reconcile (persisted flow vs live snapshot)", () => {
  it("drops a dead alias + falls back to fork when the agent is gone from server truth", () => {
    const r = reconcileGhost({ step: "agent-created", lastAgentAlias: "Requester" }, []);
    expect(r.lastAgentAlias).toBeNull();
    expect(r.step).toBe("fork");
  });
  it("leaves a still-live agent untouched (no false reset)", () => {
    const r = reconcileGhost({ step: "agent-created", lastAgentAlias: "Requester" }, ["Requester"]);
    expect(r.lastAgentAlias).toBe("Requester");
    expect(r.step).toBe("agent-created");
  });
  it("no persisted agent -> nothing to reconcile", () => {
    expect(reconcileGhost({ step: "fork", lastAgentAlias: null }, []).step).toBe("fork");
  });
});

describe("#339 demo flag is never sticky across boots", () => {
  it("a plain boot after a ?demo=1 visit clears the flag, keeping unrelated propose state", () => {
    const S = {
      step: "welcome", tasks: [], lastAgentAlias: null, _agentDraft: null,
      _propose: { goal: "ship a thing", dialogue: [{ role: "assistant", content: "scope?" }] },
    } as OnbState;
    // 1) dev visits /onboarding?demo=1 -> flag set (and would persist to localStorage)
    reconcileDemoFlag(S, true);
    expect(S._propose?.demo).toBe(true);
    // 2) later anyone loads plain /onboarding -> flag must be CLEARED so
    // startPropose's demo gate is falsy again (real /api/onboarding/propose path)
    reconcileDemoFlag(S, false);
    expect(!!(S._propose && S._propose.demo)).toBe(false);
    expect(S._propose?.goal).toBe("ship a thing"); // unrelated propose state preserved
    expect(S._propose?.dialogue).toHaveLength(1);
  });
});

describe("#293 parseSSE (SPEC-292 frames)", () => {
  it("splits on blank lines, ignores heartbeats, skips malformed, holds partials", () => {
    // one heartbeat + one good frame + a malformed frame + a partial (no blank line yet)
    const buf =
      ": heartbeat 123\n\n" +
      'data: {"event":"thinking","delta":"hi"}\n\n' +
      "data: {not json}\n\n" +
      'data: {"event":"roster"';
    const p1 = parseSSE(buf);
    expect(p1.frames.map((f) => f.event)).toEqual(["thinking"]); // heartbeat ignored + malformed skipped
    expect(p1.rest).toContain('"event":"roster"'); // partial frame buffered, not lost
    const p2 = parseSSE(p1.rest + ',"agents":[]}\n\n');
    expect(p2.frames.map((f) => f.event)).toEqual(["roster"]); // completes once the blank line arrives
    expect(p2.rest).toBe("");
  });
});

describe("#293 normalizeRoster (SPEC-292 §3 binding constraints)", () => {
  it("drops empties, defaults models, fixes dangling refs, caps kickoffs", () => {
    const payload = {
      rationale: "why",
      agents: [
        { name: "Atlas", role: "Concierge", charter: "c1", model_hint: "m-x" },
        { name: "", role: "drop me", charter: "" }, // empty name -> dropped
        { name: "Forge", role: "Builder", charter: "c2", model_hint: null },
      ],
      tasks: [
        { title: "T1", definition_of_done: "d1", assignee: "Atlas", depends_on: ["T2"], is_kickoff: true }, // forward dep T2 dropped
        { title: "T2", definition_of_done: "d2", assignee: "Ghost", depends_on: ["T1"], is_kickoff: true }, // dangling assignee -> null; dep T1 kept
        { title: "T3", definition_of_done: "d3", assignee: "Atlas", depends_on: [], is_kickoff: true }, // 2nd Atlas kickoff -> cleared
        { title: "", definition_of_done: "x" }, // empty title -> dropped
      ],
    };
    const r = normalizeRoster(payload, "DEFAULT");
    expect(r.agents.map((a) => a.name)).toEqual(["Atlas", "Forge"]);
    expect(r.agents.find((a) => a.name === "Atlas")?.model).toBe("m-x"); // model_hint carried
    expect(r.agents.find((a) => a.name === "Forge")?.model).toBe("DEFAULT"); // null hint -> default
    const t1 = r.tasks.find((t) => t.title === "T1")!;
    const t2 = r.tasks.find((t) => t.title === "T2")!;
    const t3 = r.tasks.find((t) => t.title === "T3")!;
    expect(t1.depends_on).toEqual([]); // forward dep dropped
    expect(t1.is_kickoff).toBe(true); // first Atlas kickoff kept
    expect(t2.assignee).toBeNull(); // dangling assignee -> unassigned
    expect(t2.depends_on).toEqual(["T1"]); // earlier dep kept
    expect(t2.is_kickoff).toBe(false); // kickoff on now-unassigned cleared
    expect(t3.is_kickoff).toBe(false); // 2nd Atlas kickoff cleared
    expect(r.tasks.map((t) => t.title)).toEqual(["T1", "T2", "T3"]); // empty-title task dropped
  });
});

describe("#293 rosterToWalk / walkAgentToDraft (commit reuses existing POSTs)", () => {
  it("splits kickoffs into initial_task drafts and queues the rest standalone", () => {
    const roster = {
      rationale: "r",
      agents: [
        { name: "Atlas", role: "C", charter: "c", model: "m" },
        { name: "Forge", role: "B", charter: "c2", model: "m" },
      ],
      tasks: [
        { title: "Plan", definition_of_done: "dp", assignee: "Atlas", depends_on: [], protocol: null, is_kickoff: true },
        { title: "Build", definition_of_done: "db", assignee: "Forge", depends_on: [], protocol: null, is_kickoff: true },
        { title: "Audit", definition_of_done: "da", assignee: "Atlas", depends_on: [], protocol: null, is_kickoff: false }, // non-kickoff -> standalone
        { title: "Doc", definition_of_done: "dd", assignee: null, depends_on: [], protocol: null, is_kickoff: false }, // unassigned -> standalone
      ],
    };
    const w = rosterToWalk(roster);
    expect(w.idx).toBe(0);
    expect(w.agents.map((a) => (a.kickoff ? a.kickoff.title : null))).toEqual(["Plan", "Build"]); // kickoff matched per assignee
    expect(w.standalone.map((t) => t.title).sort()).toEqual(["Audit", "Doc"]); // both non-kickoffs queued standalone

    const d0 = walkAgentToDraft(w.agents[0], "DEF");
    expect(d0._firstMode).toBe("describe"); // kickoff -> describe mode
    expect(d0._desc).toBe("dp");
    expect(d0._taskTitle).toBe("Plan"); // proposed title preserved (submitAgent honors it)
    expect(d0.alias).toBe("Atlas");
    expect(d0.model).toBe("m");
  });
});
