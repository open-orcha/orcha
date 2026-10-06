import { describe, expect, it } from "vitest";
import { answerNoun, askPhrase, mdPlain, projectEvents } from "./events";
import { runtimeLabel } from "./runModel";
import type { OrchaRequest, Task } from "../../types";

describe("mdPlain — feed previews never show raw markdown (D4)", () => {
  it("drops heading, list, quote, code and link syntax but keeps the words", () => {
    expect(mdPlain("## Plan")).toBe("Plan");
    expect(mdPlain("1. Add a `billing_webhooks_v2` table")).toBe("Add a billing_webhooks_v2 table");
    expect(mdPlain("- [x] done\n* item\n> quoted")).toBe("done\nitem\nquoted");
    expect(mdPlain("see [the docs](https://x.y/z) and ![img](a.png)")).toBe("see the docs and img");
    expect(mdPlain("**bold** and *it* and __u__ and ~~gone~~")).toBe("bold and it and u and gone");
    expect(mdPlain("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
  });
  it("keeps prose that only looks like markdown", () => {
    expect(mdPlain("snake_case_name and a * b * c")).toBe("snake_case_name and a * b * c");
    expect(mdPlain("PR #42 is 3 - 2")).toBe("PR #42 is 3 - 2");
  });
  it("projectEvents previews go through it", () => {
    const t = { id: "t1", title: "T", status: "todo", message_summary: { count: 1, last: { body: "## Plan\n1. Ship `it`", created_at: "2026-09-28T09:00:00Z", is_human: false, author_alias: "forge" } } } as unknown as Task;
    expect(projectEvents([t], [])[0].text).toBe("Plan Ship it");
  });
});

describe("request wording", () => {
  it("asks in plain words", () => {
    expect(askPhrase("info")).toBe("for info");
    expect(askPhrase("question")).toBe("a question");
    expect(askPhrase("plan approval")).toBe("to approve a plan");
    expect(askPhrase("task")).toBe("to take on a task");
    expect(askPhrase("review")).toBe("for a review");
    expect(askPhrase("escalation")).toBe("for an escalation");
  });
  it("answers name the request", () => {
    expect(answerNoun("info")).toBe("info request");
    expect(answerNoun("question")).toBe("question");
    expect(answerNoun("task")).toBe("task request");
  });
});

describe("runtimeLabel", () => {
  it("capitalises the runtime and drops the 'lane' jargon", () => {
    expect(runtimeLabel("claude", "conversation")).toBe("Claude · conversation");
    expect(runtimeLabel("codex", null)).toBe("Codex");
    expect(runtimeLabel(null, "conversation lane")).toBe("conversation");
  });
});

describe("escalated requests credit the right party (parity r2)", () => {
  const base = { id: "r1", type: "info", from: "atlas", payload: "q?", response: "a.", created_at: "2026-09-28T08:00:00Z", status: "open", task_link: null } as const;
  it("an answer given before escalation is the original agent's, and the ask targets that agent", () => {
    const r = { ...base, to: "hussein", escalated: true, escalated_from: "backend-dev", escalated_at: "2026-09-28T10:00:00Z", responded_at: "2026-09-28T09:00:00Z" } as unknown as OrchaRequest;
    const evs = projectEvents([], [r]);
    const ask = evs.find((e) => e.kind === "request")!;
    const ans = evs.find((e) => e.kind === "answer")!;
    expect(ask.other).toBe("backend-dev");
    expect(ask.subject).toBe("Info → backend-dev");
    expect(ans.who).toBe("backend-dev");
  });
  it("an answer after escalation is the human's", () => {
    const r = { ...base, to: "hussein", escalated: true, escalated_from: "backend-dev", escalated_at: "2026-09-28T09:00:00Z", responded_at: "2026-09-28T10:00:00Z" } as unknown as OrchaRequest;
    expect(projectEvents([], [r]).find((e) => e.kind === "answer")!.who).toBe("hussein");
  });
  it("a non-escalated request is unchanged", () => {
    const r = { ...base, to: "scout", escalated: false, responded_at: "2026-09-28T09:00:00Z" } as unknown as OrchaRequest;
    const evs = projectEvents([], [r]);
    expect(evs.find((e) => e.kind === "answer")!.who).toBe("scout");
    expect(evs.find((e) => e.kind === "request")!.other).toBe("scout");
  });
});
