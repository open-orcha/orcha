import Foundation

// Responsibility: Run-feed row model and top-level worker-log line classification.

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

    struct Re {
        let re: NSRegularExpression
        init(_ pattern: String) { re = try! NSRegularExpression(pattern: pattern) }
        func matches(_ s: String) -> Bool {
            re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
        }
    }

    static let orchaSkillRe = Re("orcha-[a-z]")
    static let orchaApiRe = Re(#"/api/(decisions|agent-suggestions/[^ "/]+/decide|containers/[^ "/]+/(requests|tasks)|tasks/[^ "/]+/(done|messages|next|verify|cancel|close|respond)|requests/[^ "/]+/[a-z-]+|agents/[^ "/]+/(next|digest|reachability|wake-ack|wake-claim))"#)
    static let decisionRe = Re(#"decision_made|"decision_id""#)
    static let reasoningRe = Re("reasoning")
    static let reasoningSummaryRe = Re("reasoning.*summary|summary.*reasoning")
    static let toolResultRe = Re("function_call_output|tool_result|exec_command_output|command_output|exec_command_end|command_completed|tool_call_result")
    static let toolCallRe = Re("function_call|tool_call|tool_use|exec_command_begin|exec_command_started|command_started|mcp_tool_call")
    static let outputTextRe = Re("output_text|message_delta|agent_message_delta|assistant_message_delta")
    static let agentMessageRe = Re("agent_message|assistant_message|message")
    static let errorRe = Re("error|failed")
    static let sessionRe = Re("session.*(configured|created|started)|thread.*started")
    static let turnStartedRe = Re("(turn|task|response).*(started|created|queued|in_progress|delta)")
    static let turnCompletedRe = Re("(turn|task|response).*(completed|done|succeeded)")
    static let summaryWordRe = Re("summary")

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

}
