/* Orcha shared portal module: Claude and Codex worker output classification. */
function logRow(e, isNew) {
  const t = e.type || "narrate";
  const det = e.detail ? `<span class="det">${esc(e.detail)}</span>` : "";
  return `<div class="ln t-${t}${isNew ? " new" : ""}"><span class="gut">›</span><span class="ty">${esc(e.label || t)}</span><span class="tx">${esc(e.text)}${det}</span></div>`;
}
function appendLine(logEl, e) {
  const atBottom = logEl.scrollHeight - logEl.clientHeight - logEl.scrollTop < 36;
  if (e.sec != null) {
    logEl.insertAdjacentHTML("beforeend", `<div class="sec"><span class="chev">${icon("chev", "")}</span><span>${esc(e.sec)}</span></div>`);
  } else {
    logEl.insertAdjacentHTML("beforeend", logRow(e, true));
    const last = logEl.lastElementChild;
    setTimeout(() => last && last.classList.remove("new"), 360);
  }
  // cap length so a long live stream can't grow unbounded
  while (logEl.children.length > 400) logEl.removeChild(logEl.firstElementChild);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- classify one raw stream-json worker line into the feed's row shape.
// Maps the 9 Orcha event types onto the design system's type tokens
// (boot/narrate/think/tool/result/subagent/decision/error/done).
function selfAction(name, input) {
  const s = (typeof input === "string" ? input : JSON.stringify(input || "")).toLowerCase();
  if (/orcha-[a-z]/.test(s)) return true;
  return /\/api\/(decisions|agent-suggestions\/[^ "\/]+\/decide|containers\/[^ "\/]+\/(requests|tasks)|tasks\/[^ "\/]+\/(done|messages|next|verify|cancel|close|respond)|requests\/[^ "\/]+\/[a-z-]+|agents\/[^ "\/]+\/(next|digest|reachability|wake-ack|wake-claim))/.test(s);
}
function jsonDetail(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function visibleText(v) {
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
function summaryText(v) {
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
function classifyCodex(o) {
  const rows = [];
  const p = o && typeof o.msg === "object" ? o.msg
    : (o && typeof o.event === "object" ? o.event : o);
  const item = p && typeof p.item === "object" ? p.item
    : (p && typeof p.delta === "object" ? p.delta : p);
  const ptype = String((p && p.type) || (o && o.type) || "").toLowerCase();
  const itype = String((item && item.type) || "").toLowerCase();
  const kind = (ptype + " " + itype).trim();

  if (/reasoning/.test(kind)) {
    const isSummary = /reasoning.*summary|summary.*reasoning/.test(kind);
    const txt = summaryText(item && (item.summary || item.reasoning_summary || item.summary_text))
      || summaryText(p && (p.summary || p.reasoning_summary || p.summary_text))
      || (isSummary ? visibleText(p && (p.delta || p.text || p.content)) : "");
    rows.push(txt
      ? { type: "think", label: "reasoning", text: txt }
      : { type: "think", label: "reasoning", text: "reasoning summary unavailable", detail: "provider did not expose raw reasoning" });
    return rows;
  }

  if (/function_call_output|tool_result|exec_command_output|command_output|exec_command_end|command_completed|tool_call_result/.test(kind)) {
    let detail = visibleText(item && (item.output || item.content || item.result || item.chunk))
      || visibleText(p && (p.output || p.content || p.result || p.chunk));
    if (!detail && item && item.exit_code != null) detail = "exit " + item.exit_code;
    if (!detail && p && p.exit_code != null) detail = "exit " + p.exit_code;
    const dec = /decision_made|"decision_id"/.test(detail || "");
    rows.push({ type: dec ? "decision" : "result", label: dec ? "decision" : "tool result",
      text: dec ? "decision received {decision,reason}" : "tool result", detail: detail || jsonDetail(item || p) });
    return rows;
  }

  if (/function_call|tool_call|tool_use|exec_command_begin|exec_command_started|command_started|mcp_tool_call/.test(kind)) {
    const fn = (item && item.function) || (p && p.function) || {};
    const name = (item && (item.name || item.tool_name)) || (p && (p.name || p.tool_name)) || fn.name
      || ((item && item.command) || (p && p.command) ? "exec" : "tool");
    const input = (item && (item.arguments || item.input || item.args || item.params || item.command))
      || (p && (p.arguments || p.input || p.args || p.params || p.command)) || {};
    const self = selfAction(name, input);
    rows.push({ type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool",
      text: name, detail: jsonDetail(input) });
    return rows;
  }

  if (/output_text|message_delta|agent_message_delta|assistant_message_delta/.test(kind)) {
    const txt = visibleText(item && (item.content || item.message || item.text || item.delta))
      || visibleText(p && (p.content || p.message || p.text || p.delta));
    if (txt && txt.trim()) rows.push({ type: "narrate", label: "narration", text: txt });
    return rows;
  }

  if (/agent_message|assistant_message|message/.test(kind) || (item && item.role === "assistant")) {
    const txt = visibleText(item && (item.content || item.message || item.text || item.delta))
      || visibleText(p && (p.content || p.message || p.text || p.delta));
    if (txt && txt.trim()) rows.push({ type: "narrate", label: "narration", text: txt });
    return rows;
  }

  if (/error|failed/.test(kind)) {
    rows.push({ type: "error", label: "error",
      text: trunc(visibleText(p && (p.message || p.error || p.reason)) || ptype || "error", 200),
      detail: jsonDetail(p && (p.error || p.detail || p)) });
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
function classifyLine(line) {
  const out = [];
  let o; try { o = JSON.parse(line); } catch (e) { if ((line || "").trim()) out.push({ type: "narrate", label: "log", text: trunc(line, 240) }); return out; }
  const t = o.type, st = o.subtype, cont = o.message && o.message.content;
  if (t === "assistant" && Array.isArray(cont)) {
    cont.forEach((c) => {
      if (c.type === "text" && c.text && c.text.trim()) out.push({ type: "narrate", label: "narration", text: c.text });
      else if (c.type === "thinking") out.push({ type: "think", label: "thinking", text: "(thinking)", detail: c.thinking || "" });
      else if (c.type === "tool_use") { const self = selfAction(c.name, c.input);
        out.push({ type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool", text: c.name, detail: JSON.stringify(c.input || {}) }); }
    });
  } else if (t === "user" && Array.isArray(cont)) {
    cont.forEach((c) => {
      if (c.type === "tool_result") { const r = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        const dec = /decision_made|"decision_id"/.test(r);
        out.push({ type: dec ? "decision" : "result", label: dec ? "decision" : "tool result", text: dec ? "decision received {decision,reason}" : "tool result", detail: r }); }
      else if (c.type === "text") out.push({ type: "boot", label: "injected prompt", text: trunc(c.text || "", 200) });
    });
  } else if (t === "system") {
    if (st === "init") out.push({ type: "boot", label: "wake", text: "wake start · cwd " + (o.cwd || "") });
    else if (st && st.indexOf("hook") === 0) out.push({ type: "think", label: "hook", text: "hook " + (o.hook_name || ""), detail: o.output || "" });
    else if (st === "thinking_tokens") { /* token noise: skip */ }
    else out.push({ type: "boot", label: "lifecycle", text: "system " + (st || "") });
  } else if (t === "result") {
    out.push({ type: "done", label: "run-complete", text: trunc(JSON.stringify(o.result || o.subtype || "done"), 200) });
  } else {
    const codex = classifyCodex(o);
    if (codex.length) codex.forEach((e) => out.push(e));
    else out.push({ type: "narrate", label: t || "event", text: "" });
  }
  return out;
}
