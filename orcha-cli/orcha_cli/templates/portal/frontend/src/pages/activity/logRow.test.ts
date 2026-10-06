import { describe, expect, it } from "vitest";
import { logRowView } from "./logRow";

describe("logRowView", () => {
  it("summarises a tool call from its input and exposes key/values, not JSON", () => {
    const v = logRowView({ type: "tool", label: "tool", text: "Bash", detail: JSON.stringify({ command: "pytest -q", description: "Run tests" }) });
    expect(v.kind).toBe("Tool");
    expect(v.text).toBe("Bash · Run tests");
    expect(v.fields).toEqual([["Command", "pytest -q"], ["Description", "Run tests"]]);
    expect(v.raw).toBeNull();
  });

  it("replaces the duplicated 'tool result' text with the first meaningful output line", () => {
    const v = logRowView({ type: "result", label: "tool result", text: "tool result", detail: "=== test session starts ===\n3 passed in 4.2s" });
    expect(v.kind).toBe("Result");
    expect(v.text).toBe("3 passed in 4.2s");
    expect(v.body).toContain("3 passed");
  });

  it("unwraps the JSON-stringified run-complete text and tones it by the run outcome", () => {
    const ok = logRowView({ type: "done", label: "run-complete", text: JSON.stringify("All tests pass.") }, { bucket: "finished" });
    expect(ok.text).toBe("All tests pass.");
    expect(ok.tone).toBe("muted"); // colour is for errors only
    expect(ok.kind).toBe("Done");
    const killed = logRowView({ type: "done", label: "run-complete", text: JSON.stringify("error_during_execution") }, { bucket: "failed" });
    expect(killed.tone).toBe("danger");
    expect(killed.text).toBe("error during execution");
    expect(logRowView({ type: "done", label: "run-complete", text: '"x"' }, { bucket: "failed", stoppedByHuman: true }).tone).toBe("muted");
  });

  it("shows thinking as its first line and keeps unknown structured detail as a raw payload", () => {
    const t = logRowView({ type: "think", label: "thinking", text: "(thinking)", detail: "Consider the lock.\nMore." });
    expect(t.text).toBe("Consider the lock.");
    const h = logRowView({ type: "think", label: "hook", text: "hook pre", detail: JSON.stringify({ a: [1, 2] }) });
    expect(h.kind).toBe("Hook");
    expect(h.raw).toContain('"a"');
  });

  it("labels the process-exit row 'Exit' (never two consecutive 'Done' rows)", () => {
    const res = logRowView({ type: "done", label: "run-complete", text: JSON.stringify("Implemented the claim.") }, { bucket: "finished" });
    const exit = logRowView({ type: "done", label: "run-complete", text: "exited · exit 0" }, { bucket: "finished" });
    expect(res.kind).toBe("Done");
    expect(exit.kind).toBe("Exit");
    expect(exit.text).toBe("exited · exit 0");
    expect(logRowView({ type: "done", label: "run-complete", text: "stream_timeout" }).text).toBe("stream timeout");
    expect(logRowView({ type: "done", label: "run-complete", text: "killed · exit -9" }, { bucket: "failed" }).tone).toBe("danger");
  });

  it("mutes every label except errors (colour noise)", () => {
    for (const type of ["boot", "narrate", "think", "tool", "result", "subagent", "decision"]) {
      expect(logRowView({ type, label: type, text: "x" }).tone).toBe("muted");
    }
    expect(logRowView({ type: "error", label: "error", text: "boom" }).tone).toBe("danger");
  });
});
