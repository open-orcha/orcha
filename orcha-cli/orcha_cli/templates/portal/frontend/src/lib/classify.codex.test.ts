/**
 * Codex `codex exec --json` events render like Claude stream-json: a command is a "Bash"
 * tool row + a "tool result" row (output, "Exit code N" on failure), agent messages are
 * narration, reasoning summaries are thinking, file changes are apply_patch rows — and no
 * row ever carries raw JSON. Samples cover both event generations (item.* and msg envelope).
 */
import { describe, expect, it } from "vitest";
import { classifyLine, codexCommand, type LogEvent } from "./classify";
import { logRowView } from "../pages/activity/logRow";
import { activityText } from "../pages/agents/runlog";

const rows = (...events: unknown[]): LogEvent[] => events.flatMap((e) => classifyLine(JSON.stringify(e)));
const noRawJson = (evs: LogEvent[]) => {
  for (const e of evs) {
    const v = logRowView(e);
    expect(v.raw).toBeNull();
    expect(v.text).not.toMatch(/^\s*[{[]/);
    expect(v.text).not.toMatch(/"type"\s*:/);
  }
};

// newer Codex (item.* lifecycle) — shapes as emitted by codex exec --json
const THREAD = { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" };
const TURN = { type: "turn.started" };
const REASON = { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Scanning the cart module**\n\nLooking for where qty is added." } };
const CMD_START = { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test -- cart'", aggregated_output: "", exit_code: null, status: "in_progress" } };
const CMD_DONE = { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test -- cart'", aggregated_output: "PASS src/cart.test.js\n  ✓ clamps qty (3 ms)\nTests: 4 passed, 4 total\n", exit_code: 0, status: "completed" } };
const CMD_FAIL = { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "bash -lc 'npm run test:pricing'", aggregated_output: "FAIL src/pricing.test.js\n  ✕ sale price rounds (4 ms)\n", exit_code: 1, status: "failed" } };
const PATCH = { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "/workspace/shop/src/cart.js", kind: "update" }, { path: "/workspace/shop/src/limits.js", kind: "add" }], status: "completed" } };
const MSG = { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "addItem now clamps a line at MAX_QTY_PER_LINE (10)." } };
const DONE = { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } };

// older Codex (id + msg envelope)
const OLD = [
  { id: "0", msg: { type: "task_started", model_context_window: 272000 } },
  { id: "0", msg: { type: "agent_reasoning", text: "**Inspecting the failing test**" } },
  { id: "0", msg: { type: "exec_command_begin", call_id: "call_9", command: ["bash", "-lc", "cargo test"], cwd: "/workspace/api", parsed_cmd: [] } },
  { id: "0", msg: { type: "exec_command_output_delta", call_id: "call_9", stream: "stdout", chunk: "cnVubmluZyA1IHRlc3Rz" } },
  { id: "0", msg: { type: "exec_command_end", call_id: "call_9", stdout: "running 5 tests\ntest result: ok. 5 passed; 0 failed\n", stderr: "", aggregated_output: "running 5 tests\ntest result: ok. 5 passed; 0 failed\n", exit_code: 0, duration: { secs: 2, nanos: 0 }, formatted_output: "" } },
  { id: "0", msg: { type: "patch_apply_begin", call_id: "call_10", auto_approved: true, changes: { "/workspace/api/src/lib.rs": { update: { unified_diff: "@@ -1 +1 @@\n-old\n+new\n", move_path: null } } } } },
  { id: "0", msg: { type: "patch_apply_end", call_id: "call_10", stdout: "Success. Updated the following files:\nM src/lib.rs\n", stderr: "", success: true } },
  { id: "0", msg: { type: "token_count", info: { total_token_usage: { input_tokens: 10 } } } },
  { id: "0", msg: { type: "agent_message", message: "Fixed the off-by-one; cargo test passes." } },
  { id: "0", msg: { type: "task_complete", last_agent_message: "Fixed the off-by-one; cargo test passes." } },
];

describe("Codex exec --json (newer item.* shape)", () => {
  it("a command is a Bash tool row (unwrapped script) then its output as a tool result", () => {
    const evs = rows(CMD_START, CMD_DONE);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ type: "tool", label: "tool", text: "Bash" });
    expect(JSON.parse(evs[0].detail!)).toEqual({ command: "npm test -- cart" });
    expect(logRowView(evs[0]).text).toBe("Bash · npm test -- cart");
    expect(activityText(evs[0])).toBe("Running npm test -- cart");
    expect(evs[1]).toMatchObject({ type: "result", label: "tool result" });
    expect(evs[1].detail).toContain("Tests: 4 passed, 4 total");
    expect(logRowView(evs[1]).text).toBe("PASS src/cart.test.js");
    expect(logRowView(evs[1]).body).toContain("clamps qty");
  });

  it("a failing command carries its exit code the way Claude's Bash result does", () => {
    const [r] = rows(CMD_FAIL);
    expect(r.type).toBe("result");
    expect(r.detail!.startsWith("Exit code 1\nFAIL src/pricing.test.js")).toBe(true);
    expect(logRowView(r).text).toBe("Exit code 1");
  });

  it("an empty successful command still says it ran", () => {
    const [r] = rows({ type: "item.completed", item: { id: "i", type: "command_execution", command: ["bash", "-lc", "mkdir -p out"], aggregated_output: "", exit_code: 0, status: "completed" } });
    expect(r.detail).toBe("(no output · exit 0)");
  });

  it("item.updated for a running command is not its own row", () => {
    expect(rows({ type: "item.updated", item: { id: "item_1", type: "command_execution", status: "in_progress" } })).toEqual([]);
  });

  it("agent messages narrate, reasoning summaries think, file changes are apply_patch rows", () => {
    const [think] = rows(REASON);
    expect(think).toMatchObject({ type: "think", label: "reasoning" });
    expect(think.text).toContain("Scanning the cart module");

    const [said] = rows(MSG);
    expect(said).toEqual({ type: "narrate", label: "narration", text: "addItem now clamps a line at MAX_QTY_PER_LINE (10)." });

    const patch = rows(PATCH);
    expect(patch.map((e) => e.text)).toEqual(["apply_patch", "apply_patch"]);
    expect(JSON.parse(patch[0].detail!)).toEqual({ path: "/workspace/shop/src/cart.js", change: "updated" });
    expect(JSON.parse(patch[1].detail!)).toEqual({ path: "/workspace/shop/src/limits.js", change: "added" });
    expect(logRowView(patch[0]).text).toBe("apply_patch · /workspace/shop/src/cart.js");
    expect(activityText(patch[0])).toBe("Editing cart.js");
  });

  it("a whole run has wake / narration / tool / result / done rows and never raw JSON or blank rows", () => {
    const evs = rows(THREAD, TURN, REASON, CMD_START, CMD_DONE, PATCH, MSG, DONE);
    expect(evs.map((e) => e.type)).toEqual(["boot", "think", "tool", "result", "tool", "tool", "narrate", "done"]);
    expect(evs.every((e) => e.text.trim())).toBe(true);
    noRawJson(evs);
  });

  it("turn.failed / error items are error rows in plain words", () => {
    const [f] = rows({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
    expect(f).toMatchObject({ type: "error", text: "stream disconnected before completion" });
    const [e] = rows({ type: "item.completed", item: { id: "x", type: "error", message: "command timed out after 600s" } });
    expect(e).toMatchObject({ type: "error", text: "command timed out after 600s" });
  });

  it("mcp tool calls and web searches read as tools", () => {
    const [call] = rows({ type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "github", tool: "get_issue", arguments: { number: 12 }, status: "in_progress" } });
    expect(call).toMatchObject({ type: "tool", text: "github.get_issue" });
    const [done] = rows({ type: "item.completed", item: { id: "m", type: "mcp_tool_call", server: "github", tool: "get_issue", result: { content: [{ type: "text", text: "Issue #12: qty overflow" }] }, status: "completed" } });
    expect(done).toMatchObject({ type: "result", detail: "Issue #12: qty overflow" });
    const [ws] = rows({ type: "item.completed", item: { id: "w", type: "web_search", query: "vitest fake timers" } });
    expect(ws.text).toBe("WebSearch");
    expect(logRowView(ws).text).toBe("WebSearch · vitest fake timers");
  });

  it("a command that calls the Embodent API is a self-action, as for Claude", () => {
    const [r] = rows({ type: "item.started", item: { id: "c", type: "command_execution", command: "bash -lc 'curl -X POST http://x:8000/api/tasks/t1/done'", status: "in_progress" } });
    expect(r.type).toBe("decision");
    expect(r.label).toBe("orcha-action");
  });
});

describe("Codex exec --json (older msg envelope)", () => {
  it("renders commands with output, reasoning, patches and messages; drops deltas and token counts", () => {
    const evs = rows(...OLD);
    expect(evs.map((e) => [e.type, e.text.split("\n")[0]])).toEqual([
      ["think", "**Inspecting the failing test**"],
      ["tool", "Bash"],
      ["result", "tool result"],
      ["tool", "apply_patch"],
      ["result", "tool result"],
      ["narrate", "Fixed the off-by-one; cargo test passes."],
      ["done", "Fixed the off-by-one; cargo test passes."],
    ]);
    expect(JSON.parse(evs[1].detail!)).toEqual({ command: "cargo test" });
    expect(evs[2].detail).toContain("test result: ok. 5 passed");
    expect(JSON.parse(evs[3].detail!)).toMatchObject({ path: "/workspace/api/src/lib.rs", change: "updated" });
    expect(logRowView(evs[3]).fields).toContainEqual(["Diff", "@@ -1 +1 @@\n-old\n+new\n"]);
    expect(evs.map((e) => e.detail || "").join()).not.toContain("cnVubmluZyA1IHRlc3Rz"); // base64 delta chunk
    noRawJson(evs);
  });

  it("a failed exec_command_end keeps the exit code and stderr", () => {
    const [r] = rows({ id: "0", msg: { type: "exec_command_end", call_id: "c", stdout: "", stderr: "error[E0425]: cannot find value `x`\n", exit_code: 101 } });
    expect(r.detail).toBe("Exit code 101\nerror[E0425]: cannot find value `x`\n");
  });
});

describe("codexCommand", () => {
  it("unwraps shell -lc wrappers, keeps plain argv", () => {
    expect(codexCommand(["bash", "-lc", "pytest -q"])).toBe("pytest -q");
    expect(codexCommand(["/bin/zsh", "-lc", "ls"])).toBe("ls");
    expect(codexCommand("bash -lc 'git diff --stat main...HEAD'")).toBe("git diff --stat main...HEAD");
    expect(codexCommand(`/bin/zsh -lc "rg -n foo src"`)).toBe("rg -n foo src");
    expect(codexCommand(["xcodebuild", "test", "-scheme", "My App"])).toBe("xcodebuild test -scheme 'My App'");
  });
});
