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

// The Orcha skill / slash-command verbs (templates/skills/orcha-*.md). Only
// these words count — a bare /orcha-[a-z]/ used to tag every Read/Bash that
// merely touched a path like /workspace/orcha-web or orcha-open/ as an
// Orcha action (screen review: Activity).
const ORCHA_SKILLS = [
  "accept-task", "ask", "checkpoint", "close", "container", "convert", "decide-suggestion",
  "done", "escalate", "inbox", "listen", "next", "nudge", "outbox", "pause", "post",
  "register-agent", "register-human", "reject-task", "respond", "resume", "self-wake",
  "snapshot", "status", "stop", "suggest-agent", "sweep", "task-new", "thread", "verify",
];
// The verb must stand alone: at the start / after whitespace, a quote, `=`,
// `(` or `:` — optionally as a `/slash-command` — and must not continue as a
// path or filename (`orcha-next.md`, `orcha-status/`, `orcha-web`).
const SKILL_RE = new RegExp(
  `(?:^|[\\s"'\\x60=(:])\\/?orcha-(?:${ORCHA_SKILLS.join("|")})(?![a-z0-9_./-])`,
);

// true when a tool call is the agent acting on Orcha itself (skills / API verbs).
export function selfAction(_name: unknown, input: unknown): boolean {
  const s = (typeof input === "string" ? input : JSON.stringify(input || "")).toLowerCase();
  if (SKILL_RE.test(s)) return true;
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

/* ---- Codex `exec --json` — the concrete shapes, rendered like Claude's ------------------
 * Two generations exist (same set the backend reads in evidence_parse.extract_commands and
 * notifier_codex_events):
 *   newer  {type:"item.started"|"item.updated"|"item.completed"|"item.failed", item:{id, type:
 *           "command_execution"|"agent_message"|"reasoning"|"file_change"|"mcp_tool_call"|
 *           "web_search"|"todo_list"|"error", …}} + thread.started / turn.* / error
 *   older  {id, msg:{type:"exec_command_begin"|"exec_command_output_delta"|"exec_command_end"|
 *           "agent_message"|"agent_reasoning"|"patch_apply_begin"|"patch_apply_end"|
 *           "task_started"|"task_complete"|"token_count"|…}}
 * A command becomes the SAME rows a Claude Bash call does — a "Bash" tool row whose detail is
 * {command} and a "tool result" row carrying the output ("Exit code N\n…" on a failure, the
 * way Claude's Bash result reads) — so the work log, activity line and live chat need no
 * Codex special-casing. File changes become "apply_patch" tool rows ({path, change}).
 * Returns null when the event is not one of these shapes (the generic reader takes over);
 * [] for a known event with nothing worth a row (deltas, token counts, item.updated). */

/** ["bash","-lc","pytest -q"] / "bash -lc 'pytest -q'" -> "pytest -q" (mirrors _codex_command). */
export function codexCommand(v: unknown): string {
  if (Array.isArray(v)) {
    const parts = v.map((x) => String(x));
    if (parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-[a-z]*c[a-z]*$/.test(parts[1])) return parts[2];
    return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'")).join(" ");
  }
  const s = String(v ?? "").trim();
  const m = /^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c[a-z]*\s+(['"])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
}

function commandOutput(output: unknown, exitCode: unknown): string {
  const out = visibleText(output);
  const code = typeof exitCode === "number" ? exitCode : null;
  if (code != null && code !== 0) return "Exit code " + code + (out ? "\n" + out : "");
  if (!out.trim()) return code === 0 ? "(no output · exit 0)" : "(no output)";
  return out;
}

const commandRow = (command: unknown): LogEvent => {
  const input = { command: codexCommand(command) };
  const self = selfAction("Bash", input);
  return { type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool", text: "Bash", detail: JSON.stringify(input) };
};

const resultRow = (detail: string): LogEvent => {
  const dec = /decision_made|"decision_id"/.test(detail);
  return {
    type: dec ? "decision" : "result",
    label: dec ? "decision" : "tool result",
    text: dec ? "decision received {decision,reason}" : "tool result",
    detail,
  };
};

const patchRow = (path: string, change: string, extra: Record<string, string> = {}): LogEvent => ({
  type: "tool",
  label: "tool",
  text: "apply_patch",
  detail: JSON.stringify({ path, change, ...extra }),
});

const CHANGE_WORD: Record<string, string> = { add: "added", create: "added", update: "updated", modify: "updated", delete: "deleted", remove: "deleted" };

function classifyCodexItem(o: any): LogEvent[] | null {
  if (!o || typeof o !== "object") return null;
  const top = String(o.type || "").toLowerCase();
  // ---- newer item.* lifecycle
  if (/^item\.(started|updated|completed|failed|done)$/.test(top) && o.item && typeof o.item === "object") {
    const it = o.item;
    const itype = String(it.type || "").toLowerCase();
    const phase = top.slice(5); // started | updated | completed | failed | done
    const end = phase !== "started" && phase !== "updated";
    if (itype === "command_execution" || itype === "local_shell_call" || itype === "exec_command") {
      if (phase === "updated") return [];
      if (!end) return [commandRow(it.command)];
      return [resultRow(commandOutput(it.aggregated_output ?? it.output, it.exit_code))];
    }
    if (itype === "agent_message" || itype === "assistant_message") {
      if (!end) return [];
      const txt = visibleText(it.text ?? it.message ?? it.content);
      return txt.trim() ? [{ type: "narrate", label: "narration", text: txt }] : [];
    }
    if (itype === "reasoning") {
      if (!end) return [];
      // Codex only ever exposes its reasoning SUMMARY (item.text / item.summary); raw or
      // encrypted content stays hidden (ISS-85 honesty boundary — see the generic reader).
      const txt = (typeof it.text === "string" ? it.text : "") || summaryText(it.summary || it.reasoning_summary || it.summary_text);
      return [
        txt.trim()
          ? { type: "think", label: "reasoning", text: txt }
          : { type: "think", label: "reasoning", text: "reasoning summary unavailable", detail: "provider did not expose raw reasoning" },
      ];
    }
    if (itype === "file_change") {
      if (!end) return [];
      const changes = Array.isArray(it.changes) ? it.changes : [];
      const failed = String(it.status || "").toLowerCase() === "failed" || phase === "failed";
      const rows: LogEvent[] = changes
        .filter((c: any) => c && typeof c.path === "string")
        .map((c: any) => patchRow(c.path, CHANGE_WORD[String(c.kind || "").toLowerCase()] || String(c.kind || "changed")));
      if (failed) rows.push(resultRow("Exit code 1\npatch failed to apply"));
      return rows;
    }
    if (itype === "mcp_tool_call") {
      const name = [it.server, it.tool].filter(Boolean).join(".") || "mcp tool";
      if (!end) {
        const args = it.arguments ?? {};
        const self = selfAction(name, args);
        return [{ type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool", text: name, detail: typeof args === "string" ? args : jsonDetail(args) }];
      }
      if (phase === "updated") return [];
      const err = it.error && (typeof it.error === "string" ? it.error : visibleText(it.error));
      const res = it.result && typeof it.result === "object" ? visibleText(it.result.content ?? it.result) : visibleText(it.result);
      return [resultRow(err ? "Error: " + err : res || "(no output)")];
    }
    if (itype === "web_search") {
      if (!end || !it.query) return [];
      return [{ type: "tool", label: "tool", text: "WebSearch", detail: JSON.stringify({ query: String(it.query) }) }];
    }
    if (itype === "todo_list") {
      const items = Array.isArray(it.items) ? it.items : [];
      if (!items.length || phase === "updated") return [];
      const lines = items.map((t: any) => (t && t.completed ? "[x] " : "[ ] ") + String((t && t.text) || ""));
      return [{ type: "narrate", label: "progress", text: "Plan: " + items.filter((t: any) => t && t.completed).length + "/" + items.length + " done", detail: lines.join("\n") }];
    }
    if (itype === "error") {
      const msg = visibleText(it.message ?? it.error) || "error";
      return [{ type: "error", label: "error", text: trunc(msg, 200), detail: msg }];
    }
    return null;
  }
  if (top === "turn.failed" || (top === "error" && !o.msg)) {
    const msg = visibleText((o.error && (o.error.message ?? o.error)) ?? o.message) || top;
    return [{ type: "error", label: "error", text: trunc(msg, 200), detail: msg }];
  }
  if (top === "turn.completed") return [{ type: "done", label: "run-complete", text: "turn completed" }];
  if (top === "turn.started") return [];
  // ---- older nested msg envelope
  const m = o.msg && typeof o.msg === "object" ? o.msg : null;
  if (!m) return null;
  const mt = String(m.type || "").toLowerCase();
  switch (mt) {
    case "exec_command_begin":
      return [commandRow(m.command)];
    case "exec_command_output_delta":
    case "agent_message_delta":
    case "agent_reasoning_delta":
    case "agent_reasoning_raw_content":
    case "agent_reasoning_raw_content_delta":
    case "agent_reasoning_section_break":
    case "token_count":
    case "turn_diff":
      return [];
    case "exec_command_end": {
      const out = m.aggregated_output || m.formatted_output || [m.stdout, m.stderr].filter((x) => typeof x === "string" && x).join("");
      return [resultRow(commandOutput(out, m.exit_code))];
    }
    case "agent_message": {
      const txt = visibleText(m.message ?? m.text);
      return txt.trim() ? [{ type: "narrate", label: "narration", text: txt }] : [];
    }
    case "agent_reasoning": {
      const txt = typeof m.text === "string" ? m.text : "";
      return txt.trim() ? [{ type: "think", label: "reasoning", text: txt }] : [];
    }
    case "patch_apply_begin": {
      const ch = m.changes && typeof m.changes === "object" ? m.changes : {};
      return Object.keys(ch).map((path) => {
        const c = ch[path] || {};
        const key = ["add", "update", "delete"].find((k) => c[k] != null) || String(c.type || "");
        const diff = c.update && typeof c.update.unified_diff === "string" ? c.update.unified_diff : "";
        return patchRow(path, CHANGE_WORD[key] || "changed", diff ? { diff } : {});
      });
    }
    case "patch_apply_end":
      return [resultRow(m.success === false ? "Exit code 1\n" + (visibleText(m.stderr) || "patch failed to apply") : visibleText(m.stdout) || "patch applied")];
    case "task_complete":
      return [{ type: "done", label: "run-complete", text: m.last_agent_message ? trunc(String(m.last_agent_message), 200) : "task complete" }];
    case "task_started":
      return [];
    default:
      return null;
  }
}

// Codex-runtime event shapes (msg/event envelope, item/delta payloads) — the tolerant
// generic reader for anything classifyCodexItem does not pin down.
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
  // Claude partial-message deltas (--include-partial-messages): the live chat reads them
  // (runlog useLiveTurn); a work log already shows the complete `assistant` event each
  // block ends with, so a delta is never its own row (it used to paint a blank one).
  if (t === "stream_event") return out;
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
    // a pinned Codex shape answers outright — [] means "known, nothing worth a row"
    const known = classifyCodexItem(o);
    if (known) return known;
    const codex = classifyCodex(o);
    if (codex.length) codex.forEach((e) => out.push(e));
    else out.push({ type: "narrate", label: t || "event", text: "" });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
