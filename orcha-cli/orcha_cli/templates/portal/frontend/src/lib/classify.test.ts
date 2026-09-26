/**
 * classifyLine taxonomy — Vitest port of the node-harness cases that lived in
 * tests/test_b1_run_feed.py (the vanilla app.js was eval'd in node there; the
 * TS source is exercised directly here).
 */
import { describe, expect, it } from "vitest";
import { classifyLine, type LogEvent } from "./classify";

const first = (line: string): LogEvent => classifyLine(line)[0] || ({ type: "", label: "", text: "" } as LogEvent);
const toolLine = (cmd: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } });

describe("classifyLine — orcha self-actions (review P3)", () => {
  it("tags container-scoped writes and /api/decisions as 'decision'; a read-only poll stays 'tool'", () => {
    expect(first(toolLine("curl -X POST http://x:8000/api/containers/abc/requests -d @x")).type).toBe("decision");
    expect(first(toolLine("curl -X POST http://x:8000/api/containers/abc/tasks -d @x")).type).toBe("decision");
    expect(first(toolLine("curl -X POST http://x:8000/api/decisions -d @x")).type).toBe("decision");
    expect(first(toolLine("curl http://x:8000/api/agents/a1/wait?since_ts=0")).type).toBe("tool");
  });
});

describe("classifyLine — Codex JSONL taxonomy (ISS-85)", () => {
  it("maps completed assistant messages to narration", () => {
    const msg = first(
      JSON.stringify({
        type: "item.completed",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "working from codex" }] },
      }),
    );
    expect(msg.type).toBe("narrate");
    expect(msg.label).toBe("narration");
    expect(msg.text).toBe("working from codex");
  });

  it("maps output_text deltas to narration", () => {
    const delta = first(JSON.stringify({ type: "response.output_text.delta", delta: "still working" }));
    expect(delta.type).toBe("narrate");
    expect(delta.label).toBe("narration");
    expect(delta.text).toBe("still working");
  });

  it("maps function calls to 'tool' with the arguments as detail", () => {
    const call = first(
      JSON.stringify({ type: "item.started", item: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' } }),
    );
    expect(call.type).toBe("tool");
    expect(call.label).toBe("tool");
    expect(call.text).toBe("shell");
    expect(call.detail).toContain("ls");
  });

  it("maps function_call_output to 'tool result'", () => {
    const result = first(JSON.stringify({ type: "item.completed", item: { type: "function_call_output", output: "ok" } }));
    expect(result.type).toBe("result");
    expect(result.label).toBe("tool result");
    expect(result.detail).toBe("ok");
  });

  it("maps reasoning summaries (and summary deltas) to 'think'", () => {
    const reasoning = first(
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", summary: [{ type: "summary_text", text: "checked repo state" }] },
      }),
    );
    expect(reasoning.type).toBe("think");
    expect(reasoning.label).toBe("reasoning");
    expect(reasoning.text).toBe("checked repo state");

    const delta = first(JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "summarized plan" }));
    expect(delta.type).toBe("think");
    expect(delta.label).toBe("reasoning");
    expect(delta.text).toBe("summarized plan");
  });

  it("represents hidden reasoning as unavailable — never rendered from provider-private fields", () => {
    // ISS-85 honesty boundary.
    const rows = classifyLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", encrypted_content: "secret", content: "do not expose this as a summary" },
      }),
    );
    const reasoning = rows[0];
    expect(reasoning.type).toBe("think");
    expect(reasoning.label).toBe("reasoning");
    expect(reasoning.text).toBe("reasoning summary unavailable");
    expect(reasoning.detail).toContain("provider did not expose raw reasoning");
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain("secret");
    expect(dumped).not.toContain("do not expose");
  });

  it("tags a codex orcha API call as a self-action ('decision')", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "function_call", name: "shell", arguments: "curl -X POST http://x:8000/api/agents/a1/wake-ack -d @x" },
    });
    expect(first(line).type).toBe("decision");
  });
});
