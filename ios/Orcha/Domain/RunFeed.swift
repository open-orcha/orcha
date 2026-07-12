import Foundation

/// One typed row of the worker-run feed — the web's classified row shape
/// (app.js classifyLine/classifyCodex, lines 1288-1439). `type` is one of the web's
/// tokens: boot / narrate / think / tool / result / subagent / decision / error / done.
/// `detail` renders collapsed (expand on tap), matching the web's <details> payloads.
struct RunFeedRow: Equatable {
    let type: String
    let label: String
    let text: String
    var detail: String?

    init(type: String, label: String, text: String, detail: String? = nil) {
        self.type = type
        self.label = label
        self.text = text
        self.detail = detail
    }
}

/// Swift port of the portal's run-line classifier — a 1:1 mirror of the Android
/// `RunFeed.kt` (which itself ports app.js classifyLine/classifyCodex). No raw JSON
/// blocks: every stream-json line becomes one or more typed rows. Foundation
/// `JSONSerialization` parses; `[String: Any]`/`NSNull` mirror Kotlin's
/// `JsonObject`/`JsonNull` (an absent key is `nil`, a JSON `null` is a real value that
/// stops `??` coalescing — the same way `JsonNull` stops Kotlin's `?:`).
enum RunFeed {
    // MARK: precompiled patterns (fidelity choice: NSRegularExpression, not Swift Regex)

    private struct Re {
        let re: NSRegularExpression
        init(_ pattern: String) { re = try! NSRegularExpression(pattern: pattern) }
        func matches(_ s: String) -> Bool {
            re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
        }
    }

    private static let orchaSkillRe = Re("orcha-[a-z]")
    private static let orchaApiRe = Re(#"/api/(decisions|agent-suggestions/[^ "/]+/decide|containers/[^ "/]+/(requests|tasks)|tasks/[^ "/]+/(done|messages|next|verify|cancel|close|respond)|requests/[^ "/]+/[a-z-]+|agents/[^ "/]+/(next|digest|reachability|wake-ack|wake-claim))"#)
    private static let decisionRe = Re(#"decision_made|"decision_id""#)
    private static let reasoningRe = Re("reasoning")
    private static let reasoningSummaryRe = Re("reasoning.*summary|summary.*reasoning")
    private static let toolResultRe = Re("function_call_output|tool_result|exec_command_output|command_output|exec_command_end|command_completed|tool_call_result")
    private static let toolCallRe = Re("function_call|tool_call|tool_use|exec_command_begin|exec_command_started|command_started|mcp_tool_call")
    private static let outputTextRe = Re("output_text|message_delta|agent_message_delta|assistant_message_delta")
    private static let agentMessageRe = Re("agent_message|assistant_message|message")
    private static let errorRe = Re("error|failed")
    private static let sessionRe = Re("session.*(configured|created|started)|thread.*started")
    private static let turnStartedRe = Re("(turn|task|response).*(started|created|queued|in_progress|delta)")
    private static let turnCompletedRe = Re("(turn|task|response).*(completed|done|succeeded)")
    private static let summaryWordRe = Re("summary")

    // MARK: entry point

    static func classifyLine(_ line: String) -> [RunFeedRow] {
        guard let obj = parseObject(line) else {
            return line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? []
                : [RunFeedRow(type: "narrate", label: "log", text: trunc(line, 240))]
        }
        var out: [RunFeedRow] = []
        let t = str(obj, "type")
        let st = str(obj, "subtype")
        let content = (obj["message"] as? [String: Any])?["content"] as? [Any]
        if t == "assistant", let content {
            for c in content.compactMap({ $0 as? [String: Any] }) {
                switch str(c, "type") {
                case "text":
                    if let txt = str(c, "text"), !txt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        out.append(RunFeedRow(type: "narrate", label: "narration", text: txt))
                    }
                case "thinking":
                    out.append(RunFeedRow(type: "think", label: "thinking", text: "(thinking)", detail: str(c, "thinking") ?? ""))
                case "tool_use":
                    let selfA = selfAction(c["input"])
                    out.append(RunFeedRow(
                        type: selfA ? "decision" : "tool",
                        label: selfA ? "orcha-action" : "tool",
                        text: str(c, "name") ?? "tool",
                        detail: jsonDetail(c["input"])
                    ))
                default:
                    break
                }
            }
        } else if t == "user", let content {
            for c in content.compactMap({ $0 as? [String: Any] }) {
                switch str(c, "type") {
                case "tool_result":
                    let r: String
                    if let s = str(c, "content") {
                        r = s
                    } else if let cv = c["content"] {
                        r = elementToString(cv)
                    } else {
                        r = ""
                    }
                    let dec = decisionRe.matches(r)
                    out.append(RunFeedRow(
                        type: dec ? "decision" : "result",
                        label: dec ? "decision" : "tool result",
                        text: dec ? "decision received {decision,reason}" : "tool result",
                        detail: r
                    ))
                case "text":
                    out.append(RunFeedRow(type: "boot", label: "injected prompt", text: trunc(str(c, "text") ?? "", 200)))
                default:
                    break
                }
            }
        } else if t == "system" {
            if st == "init" {
                out.append(RunFeedRow(type: "boot", label: "wake", text: "wake start · cwd " + (str(obj, "cwd") ?? "")))
            } else if st?.hasPrefix("hook") == true {
                out.append(RunFeedRow(type: "think", label: "hook", text: "hook " + (str(obj, "hook_name") ?? ""), detail: str(obj, "output") ?? ""))
            } else if st == "thinking_tokens" {
                // token noise: skip (web parity)
            } else {
                out.append(RunFeedRow(type: "boot", label: "lifecycle", text: "system " + (st ?? "")))
            }
        } else if t == "result" {
            let rv = obj["result"] ?? obj["subtype"]
            let text = rv.map { elementToString($0) } ?? "\"done\""
            out.append(RunFeedRow(type: "done", label: "run-complete", text: trunc(text, 200)))
        } else {
            let codex = classifyCodex(obj)
            if codex.isEmpty {
                out.append(RunFeedRow(type: "narrate", label: t ?? "event", text: ""))
            } else {
                out.append(contentsOf: codex)
            }
        }
        return out
    }

    // MARK: codex stream-json events (web classifyCodex) — kind = payload type + item type

    private static func classifyCodex(_ o: [String: Any]) -> [RunFeedRow] {
        let p = (o["msg"] as? [String: Any]) ?? (o["event"] as? [String: Any]) ?? o
        let item = (p["item"] as? [String: Any]) ?? (p["delta"] as? [String: Any]) ?? p
        let ptype = (str(p, "type") ?? str(o, "type") ?? "").lowercased()
        let itype = (str(item, "type") ?? "").lowercased()
        let kind = (ptype + " " + itype).trimmingCharacters(in: .whitespaces)

        if reasoningRe.matches(kind) {
            let isSummary = reasoningSummaryRe.matches(kind)
            var txt = summaryText(item["summary"] ?? item["reasoning_summary"] ?? item["summary_text"])
            if txt.isEmpty { txt = summaryText(p["summary"] ?? p["reasoning_summary"] ?? p["summary_text"]) }
            if txt.isEmpty { txt = isSummary ? visibleText(p["delta"] ?? p["text"] ?? p["content"]) : "" }
            return [
                txt.isEmpty
                    ? RunFeedRow(type: "think", label: "reasoning", text: "reasoning summary unavailable", detail: "provider did not expose raw reasoning")
                    : RunFeedRow(type: "think", label: "reasoning", text: txt),
            ]
        }

        if toolResultRe.matches(kind) {
            var detail = visibleText(item["output"] ?? item["content"] ?? item["result"] ?? item["chunk"])
            if detail.isEmpty { detail = visibleText(p["output"] ?? p["content"] ?? p["result"] ?? p["chunk"]) }
            if detail.isEmpty {
                if let exit = primitiveString(item["exit_code"]) ?? primitiveString(p["exit_code"]) {
                    detail = "exit " + exit
                }
            }
            let dec = decisionRe.matches(detail)
            return [
                RunFeedRow(
                    type: dec ? "decision" : "result",
                    label: dec ? "decision" : "tool result",
                    text: dec ? "decision received {decision,reason}" : "tool result",
                    detail: detail.isEmpty ? jsonDetail(item) : detail
                ),
            ]
        }

        if toolCallRe.matches(kind) {
            let fn = (item["function"] as? [String: Any]) ?? (p["function"] as? [String: Any])
            let name = str(item, "name") ?? str(item, "tool_name") ?? str(p, "name") ?? str(p, "tool_name")
                ?? fn.flatMap { str($0, "name") }
                ?? ((item["command"] != nil || p["command"] != nil) ? "exec" : "tool")
            let input = item["arguments"] ?? item["input"] ?? item["args"] ?? item["params"] ?? item["command"]
                ?? p["arguments"] ?? p["input"] ?? p["args"] ?? p["params"] ?? p["command"]
            let selfA = selfAction(input)
            return [
                RunFeedRow(
                    type: selfA ? "decision" : "tool",
                    label: selfA ? "orcha-action" : "tool",
                    text: name,
                    detail: jsonDetail(input)
                ),
            ]
        }

        if outputTextRe.matches(kind) {
            var txt = visibleText(item["content"] ?? item["message"] ?? item["text"] ?? item["delta"])
            if txt.isEmpty { txt = visibleText(p["content"] ?? p["message"] ?? p["text"] ?? p["delta"]) }
            return txt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? [] : [RunFeedRow(type: "narrate", label: "narration", text: txt)]
        }

        if agentMessageRe.matches(kind) || str(item, "role") == "assistant" {
            var txt = visibleText(item["content"] ?? item["message"] ?? item["text"] ?? item["delta"])
            if txt.isEmpty { txt = visibleText(p["content"] ?? p["message"] ?? p["text"] ?? p["delta"]) }
            return txt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? [] : [RunFeedRow(type: "narrate", label: "narration", text: txt)]
        }

        if errorRe.matches(kind) {
            let msg = visibleText(p["message"] ?? p["error"] ?? p["reason"])
            let text = trunc(msg.isEmpty ? (ptype.isEmpty ? "error" : ptype) : msg, 200)
            return [RunFeedRow(type: "error", label: "error", text: text, detail: jsonDetail(p["error"] ?? p["detail"] ?? p))]
        }
        if sessionRe.matches(ptype) {
            return [RunFeedRow(type: "boot", label: "wake", text: "codex " + ptype)]
        }
        if turnStartedRe.matches(ptype) {
            return [RunFeedRow(type: "narrate", label: "progress", text: "codex " + ptype)]
        }
        if turnCompletedRe.matches(ptype) {
            return [RunFeedRow(type: "done", label: "run-complete", text: "codex " + ptype)]
        }
        return []
    }

    // MARK: value helpers (mirror Android RunFeed.kt)

    /// Web selfAction: a tool call whose INPUT hits an orcha skill or a self-serve API path.
    private static func selfAction(_ input: Any?) -> Bool {
        let s = jsonDetail(input).lowercased()
        return orchaSkillRe.matches(s) || orchaApiRe.matches(s)
    }

    private static func jsonDetail(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        return elementToString(v)
    }

    /// Web visibleText: dig the human-readable text out of the common content shapes.
    private static func visibleText(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return numberString(n) }
        if let arr = v as? [Any] { return joinLines(arr.map { visibleText($0) }) }
        if let o = v as? [String: Any] {
            if let s = o["text"] as? String { return s }
            if let s = o["output_text"] as? String { return s }
            if let s = o["summary_text"] as? String { return s }
            if let s = o["message"] as? String { return s }
            if let s = o["content"] as? String { return s }
            if let s = o["output"] as? String { return s }
            if let arr = o["content"] as? [Any] { return visibleText(arr) }
            if let arr = o["output"] as? [Any] { return visibleText(arr) }
        }
        return ""
    }

    /// Web summaryText: reasoning-summary extraction (strings only, unlike visibleText).
    private static func summaryText(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        if v is NSNumber { return "" }
        if let arr = v as? [Any] { return joinLines(arr.map { summaryText($0) }) }
        if let o = v as? [String: Any] {
            if let s = o["text"] as? String { return s }
            if let s = o["summary_text"] as? String { return s }
            if let s = o["content"] as? String, summaryWordRe.matches((o["type"] as? String ?? "").lowercased()) { return s }
            if let arr = o["content"] as? [Any] { return summaryText(arr) }
        }
        return ""
    }

    /// Kotlin `.joinToString("\n").lines().filter { it.isNotEmpty() }.joinToString("\n")` —
    /// join everything, then drop empty LINES (not empty elements). Web filters elements, but
    /// this is a 1:1 Android port so the line-filter behavior is the anchor.
    private static func joinLines(_ parts: [String]) -> String {
        parts.joined(separator: "\n").components(separatedBy: "\n").filter { !$0.isEmpty }.joined(separator: "\n")
    }

    /// Kotlin `(x as? JsonPrimitive)?.contentOrNull` for primitives — the scalar's string form,
    /// nil for JSON null / objects / arrays.
    private static func primitiveString(_ v: Any?) -> String? {
        guard let v, !(v is NSNull) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return numberString(n) }
        return nil
    }

    private static func numberString(_ n: NSNumber) -> String {
        CFGetTypeID(n) == CFBooleanGetTypeID() ? (n.boolValue ? "true" : "false") : n.stringValue
    }

    /// JSON-serialize a value to its `.toString()`/`JSON.stringify` form: strings come back
    /// quoted, `NSNull` → "null". `.fragmentsAllowed` permits bare scalars; `.withoutEscapingSlashes`
    /// matches JS not escaping `/`.
    private static func elementToString(_ v: Any) -> String {
        if v is NSNull { return "null" }
        if let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .withoutEscapingSlashes]),
           let s = String(data: d, encoding: .utf8) {
            return s
        }
        if let s = v as? String { return s }
        return String(describing: v)
    }

    /// Parse one line into a JSON object. No `.fragmentsAllowed`: a bare scalar or a JSON array
    /// line fails the `[String: Any]` cast → nil → the narrate/log fallback (Kotlin `as? JsonObject`).
    private static func parseObject(_ line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    /// Kotlin `JsonObject.str` — the value only when it is a JSON string.
    private static func str(_ o: [String: Any], _ key: String) -> String? {
        o[key] as? String
    }

    private static func trunc(_ s: String, _ n: Int) -> String {
        s.count <= n ? s : String(s.prefix(n - 1)) + "…"
    }
}
