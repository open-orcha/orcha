import Foundation

// Responsibility: Classification of Codex stream-JSON events into visible run-feed rows.

extension RunFeed {
    // MARK: codex stream-json events (web classifyCodex) — kind = payload type + item type

    static func classifyCodex(_ o: [String: Any]) -> [RunFeedRow] {
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

}
