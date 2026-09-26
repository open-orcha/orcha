/**
 * Worker-run stream-json classification — a faithful port of the app.js
 * live-feed taxonomy (classifyLine / classifyCodex / selfAction and friends).
 * One raw stream-json line -> zero or more typed feed rows, mapped onto the
 * design system's type tokens (boot/narrate/think/tool/result/subagent/
 * decision/error/done). Pure functions, no DOM.
 */

export interface LogEvent {
  type: string; // boot | narrate | think | tool | result | subagent | decision | error | done
  label: string;
  text: string;
  detail?: string;
}

const trunc = (s: string, n: number): string => {
  const v = s || "";
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};

// true when a tool call is the agent acting on Orcha itself (skills / API verbs).
export function selfAction(_name: unknown, input: unknown): boolean {
  const s = (typeof input === "string" ? input : JSON.stringify(input || "")).toLowerCase();
  if (/orcha-[a-z]/.test(s)) return true;
  return /\/api\/(decisions|agent-suggestions\/[^ "/]+\/decide|containers\/[^ "/]+\/(requests|tasks)|tasks\/[^ "/]+\/(done|messages|next|verify|cancel|close|respond)|requests\/[^ "/]+\/[a-z-]+|agents\/[^ "/]+\/(next|digest|reachability|wake-ack|wake-claim))/.test(
    s,
  );
}

function jsonDetail(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function visibleText(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(visibleText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.output_text === "string") return v.output_text;
    if (typeof v.summary_text === "string") return v.summary_text;
    if (typeof v.message === "string") return v.message;
    if (typeof v.content === "string") return v.content;
    if (typeof v.output === "string") return v.output;
    if (Array.isArray(v.content)) return visibleText(v.content);
    if (Array.isArray(v.output)) return visibleText(v.output);
  }
  return "";
}

function summaryText(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(summaryText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.summary_text === "string") return v.summary_text;
    if (typeof v.content === "string" && /summary/.test(String(v.type || "").toLowerCase())) return v.content;
    if (Array.isArray(v.content)) return summaryText(v.content);
  }
  return "";
}

// Codex-runtime event shapes (msg/event envelope, item/delta payloads).
function classifyCodex(o: any): LogEvent[] {
  const rows: LogEvent[] = [];
  const p = o && typeof o.msg === "object" ? o.msg : o && typeof o.event === "object" ? o.event : o;
  const item = p && typeof p.item === "object" ? p.item : p && typeof p.delta === "object" ? p.delta : p;
  const ptype = String((p && p.type) || (o && o.type) || "").toLowerCase();
  const itype = String((item && item.type) || "").toLowerCase();
  const kind = (ptype + " " + itype).trim();

  if (/reasoning/.test(kind)) {
    const isSummary = /reasoning.*summary|summary.*reasoning/.test(kind);
    const txt =
      summaryText(item && (item.summary || item.reasoning_summary || item.summary_text)) ||
      summaryText(p && (p.summary || p.reasoning_summary || p.summary_text)) ||
      (isSummary ? visibleText(p && (p.delta || p.text || p.content)) : "");
    rows.push(
      txt
        ? { type: "think", label: "reasoning", text: txt }
        : { type: "think", label: "reasoning", text: "reasoning summary unavailable", detail: "provider did not expose raw reasoning" },
    );
    return rows;
  }

  if (/function_call_output|tool_result|exec_command_output|command_output|exec_command_end|command_completed|tool_call_result/.test(kind)) {
    let detail =
      visibleText(item && (item.output || item.content || item.result || item.chunk)) ||
      visibleText(p && (p.output || p.content || p.result || p.chunk));
    if (!detail && item && item.exit_code != null) detail = "exit " + item.exit_code;
    if (!detail && p && p.exit_code != null) detail = "exit " + p.exit_code;
    const dec = /decision_made|"decision_id"/.test(detail || "");
    rows.push({
      type: dec ? "decision" : "result",
      label: dec ? "decision" : "tool result",
      text: dec ? "decision received {decision,reason}" : "tool result",
      detail: detail || jsonDetail(item || p),
    });
    return rows;
  }

  if (/function_call|tool_call|tool_use|exec_command_begin|exec_command_started|command_started|mcp_tool_call/.test(kind)) {
    const fn = (item && item.function) || (p && p.function) || {};
    const name =
      (item && (item.name || item.tool_name)) ||
      (p && (p.name || p.tool_name)) ||
      fn.name ||
      ((item && item.command) || (p && p.command) ? "exec" : "tool");
    const input =
      (item && (item.arguments || item.input || item.args || item.params || item.command)) ||
      (p && (p.arguments || p.input || p.args || p.params || p.command)) ||
      {};
    const self = selfAction(name, input);
    rows.push({ type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool", text: name, detail: jsonDetail(input) });
    return rows;
  }

  if (/output_text|message_delta|agent_message_delta|assistant_message_delta/.test(kind)) {
    const txt =
      visibleText(item && (item.content || item.message || item.text || item.delta)) ||
      visibleText(p && (p.content || p.message || p.text || p.delta));
    if (txt && txt.trim()) rows.push({ type: "narrate", label: "narration", text: txt });
    return rows;
  }

  if (/agent_message|assistant_message|message/.test(kind) || (item && item.role === "assistant")) {
    const txt =
      visibleText(item && (item.content || item.message || item.text || item.delta)) ||
      visibleText(p && (p.content || p.message || p.text || p.delta));
    if (txt && txt.trim()) rows.push({ type: "narrate", label: "narration", text: txt });
    return rows;
  }

  if (/error|failed/.test(kind)) {
    rows.push({
      type: "error",
      label: "error",
      text: trunc(visibleText(p && (p.message || p.error || p.reason)) || ptype || "error", 200),
      detail: jsonDetail(p && (p.error || p.detail || p)),
    });
    return rows;
  }
  if (/session.*(configured|created|started)|thread.*started/.test(ptype)) {
    rows.push({ type: "boot", label: "wake", text: "codex " + ptype });
    return rows;
  }
  if (/(turn|task|response).*(started|created|queued|in_progress|delta)/.test(ptype)) {
    rows.push({ type: "narrate", label: "progress", text: "codex " + ptype });
    return rows;
  }
  if (/(turn|task|response).*(completed|done|succeeded)/.test(ptype)) {
    rows.push({ type: "done", label: "run-complete", text: "codex " + ptype });
    return rows;
  }
  return rows;
}

// One raw worker stream-json line -> classified feed rows. Non-JSON lines
// degrade to a truncated plain-log row; blank lines emit nothing.
export function classifyLine(line: string): LogEvent[] {
  const out: LogEvent[] = [];
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    if ((line || "").trim()) out.push({ type: "narrate", label: "log", text: trunc(line, 240) });
    return out;
  }
  const t = o.type;
  const st = o.subtype;
  const cont = o.message && o.message.content;
  if (t === "assistant" && Array.isArray(cont)) {
    cont.forEach((c: any) => {
      if (c.type === "text" && c.text && c.text.trim()) out.push({ type: "narrate", label: "narration", text: c.text });
      else if (c.type === "thinking") out.push({ type: "think", label: "thinking", text: "(thinking)", detail: c.thinking || "" });
      else if (c.type === "tool_use") {
        const self = selfAction(c.name, c.input);
        out.push({
          type: self ? "decision" : "tool",
          label: self ? "orcha-action" : "tool",
          text: c.name,
          detail: JSON.stringify(c.input || {}),
        });
      }
    });
  } else if (t === "user" && Array.isArray(cont)) {
    cont.forEach((c: any) => {
      if (c.type === "tool_result") {
        const r = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        const dec = /decision_made|"decision_id"/.test(r);
        out.push({
          type: dec ? "decision" : "result",
          label: dec ? "decision" : "tool result",
          text: dec ? "decision received {decision,reason}" : "tool result",
          detail: r,
        });
      } else if (c.type === "text") out.push({ type: "boot", label: "injected prompt", text: trunc(c.text || "", 200) });
    });
  } else if (t === "system") {
    if (st === "init") out.push({ type: "boot", label: "wake", text: "wake start · cwd " + (o.cwd || "") });
    else if (st && String(st).indexOf("hook") === 0) out.push({ type: "think", label: "hook", text: "hook " + (o.hook_name || ""), detail: o.output || "" });
    else if (st === "thinking_tokens") {
      /* token noise: skip */
    } else out.push({ type: "boot", label: "lifecycle", text: "system " + (st || "") });
  } else if (t === "result") {
    out.push({ type: "done", label: "run-complete", text: trunc(JSON.stringify(o.result || o.subtype || "done"), 200) });
  } else {
    const codex = classifyCodex(o);
    if (codex.length) codex.forEach((e) => out.push(e));
    else out.push({ type: "narrate", label: t || "event", text: "" });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
