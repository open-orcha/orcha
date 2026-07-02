package io.openorcha.mobile.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * One typed row of the worker-run feed — the web's classified row shape
 * (app.js classifyLine/classifyCodex, lines 1288-1439). `type` is one of the web's
 * tokens: boot / narrate / think / tool / result / subagent / decision / error / done.
 * `detail` renders collapsed (expand on tap), matching the web's <details> payloads.
 */
data class RunFeedRow(
    val type: String,
    val label: String,
    val text: String,
    val detail: String? = null,
)

/** Kotlin port of the portal's run-line classifier — web parity, no raw JSON blocks. */
object RunFeed {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val orchaSkillRegex = Regex("orcha-[a-z]")
    private val orchaApiRegex = Regex(
        "/api/(decisions|agent-suggestions/[^ \"/]+/decide|containers/[^ \"/]+/(requests|tasks)|" +
            "tasks/[^ \"/]+/(done|messages|next|verify|cancel|close|respond)|requests/[^ \"/]+/[a-z-]+|" +
            "agents/[^ \"/]+/(next|digest|reachability|wake-ack|wake-claim))",
    )
    private val decisionRegex = Regex("decision_made|\"decision_id\"")

    fun classifyLine(line: String): List<RunFeedRow> {
        val obj = runCatching { json.parseToJsonElement(line) as? JsonObject }.getOrNull()
            ?: return if (line.isBlank()) emptyList() else listOf(RunFeedRow("narrate", "log", trunc(line, 240)))
        val out = mutableListOf<RunFeedRow>()
        val t = obj.str("type")
        val st = obj.str("subtype")
        val content = (obj["message"] as? JsonObject)?.get("content") as? JsonArray
        when {
            t == "assistant" && content != null -> content.filterIsInstance<JsonObject>().forEach { c ->
                when (c.str("type")) {
                    "text" -> c.str("text")?.takeIf { it.isNotBlank() }
                        ?.let { out += RunFeedRow("narrate", "narration", it) }
                    "thinking" -> out += RunFeedRow("think", "thinking", "(thinking)", c.str("thinking") ?: "")
                    "tool_use" -> {
                        val self = selfAction(c["input"])
                        out += RunFeedRow(
                            if (self) "decision" else "tool",
                            if (self) "orcha-action" else "tool",
                            c.str("name") ?: "tool",
                            jsonDetail(c["input"]),
                        )
                    }
                }
            }
            t == "user" && content != null -> content.filterIsInstance<JsonObject>().forEach { c ->
                when (c.str("type")) {
                    "tool_result" -> {
                        val r = c.str("content") ?: c["content"]?.toString().orEmpty()
                        val dec = decisionRegex.containsMatchIn(r)
                        out += RunFeedRow(
                            if (dec) "decision" else "result",
                            if (dec) "decision" else "tool result",
                            if (dec) "decision received {decision,reason}" else "tool result",
                            r,
                        )
                    }
                    "text" -> out += RunFeedRow("boot", "injected prompt", trunc(c.str("text") ?: "", 200))
                }
            }
            t == "system" -> when {
                st == "init" -> out += RunFeedRow("boot", "wake", "wake start · cwd " + (obj.str("cwd") ?: ""))
                st?.startsWith("hook") == true ->
                    out += RunFeedRow("think", "hook", "hook " + (obj.str("hook_name") ?: ""), obj.str("output") ?: "")
                st == "thinking_tokens" -> Unit // token noise: skip (web parity)
                else -> out += RunFeedRow("boot", "lifecycle", "system " + (st ?: ""))
            }
            t == "result" ->
                out += RunFeedRow("done", "run-complete", trunc((obj["result"] ?: obj["subtype"])?.toString() ?: "\"done\"", 200))
            else -> {
                val codex = classifyCodex(obj)
                if (codex.isNotEmpty()) out += codex else out += RunFeedRow("narrate", t ?: "event", "")
            }
        }
        return out
    }

    /** Codex stream-json events (web classifyCodex) — kind = payload type + item type. */
    private fun classifyCodex(o: JsonObject): List<RunFeedRow> {
        val p = (o["msg"] as? JsonObject) ?: (o["event"] as? JsonObject) ?: o
        val item = (p["item"] as? JsonObject) ?: (p["delta"] as? JsonObject) ?: p
        val ptype = (p.str("type") ?: o.str("type") ?: "").lowercase()
        val itype = (item.str("type") ?: "").lowercase()
        val kind = "$ptype $itype".trim()

        if (Regex("reasoning").containsMatchIn(kind)) {
            val isSummary = Regex("reasoning.*summary|summary.*reasoning").containsMatchIn(kind)
            val txt = summaryText(item["summary"] ?: item["reasoning_summary"] ?: item["summary_text"])
                .ifEmpty { summaryText(p["summary"] ?: p["reasoning_summary"] ?: p["summary_text"]) }
                .ifEmpty { if (isSummary) visibleText(p["delta"] ?: p["text"] ?: p["content"]) else "" }
            return listOf(
                if (txt.isNotEmpty()) RunFeedRow("think", "reasoning", txt)
                else RunFeedRow("think", "reasoning", "reasoning summary unavailable", "provider did not expose raw reasoning"),
            )
        }

        if (Regex("function_call_output|tool_result|exec_command_output|command_output|exec_command_end|command_completed|tool_call_result").containsMatchIn(kind)) {
            var detail = visibleText(item["output"] ?: item["content"] ?: item["result"] ?: item["chunk"])
                .ifEmpty { visibleText(p["output"] ?: p["content"] ?: p["result"] ?: p["chunk"]) }
            if (detail.isEmpty()) {
                val exit = (item["exit_code"] as? JsonPrimitive)?.contentOrNull
                    ?: (p["exit_code"] as? JsonPrimitive)?.contentOrNull
                if (exit != null) detail = "exit $exit"
            }
            val dec = decisionRegex.containsMatchIn(detail)
            return listOf(
                RunFeedRow(
                    if (dec) "decision" else "result",
                    if (dec) "decision" else "tool result",
                    if (dec) "decision received {decision,reason}" else "tool result",
                    detail.ifEmpty { jsonDetail(item) },
                ),
            )
        }

        if (Regex("function_call|tool_call|tool_use|exec_command_begin|exec_command_started|command_started|mcp_tool_call").containsMatchIn(kind)) {
            val fn = (item["function"] as? JsonObject) ?: (p["function"] as? JsonObject)
            val name = item.str("name") ?: item.str("tool_name") ?: p.str("name") ?: p.str("tool_name")
                ?: fn?.str("name")
                ?: if (item["command"] != null || p["command"] != null) "exec" else "tool"
            val input = item["arguments"] ?: item["input"] ?: item["args"] ?: item["params"] ?: item["command"]
                ?: p["arguments"] ?: p["input"] ?: p["args"] ?: p["params"] ?: p["command"]
            val self = selfAction(input)
            return listOf(
                RunFeedRow(
                    if (self) "decision" else "tool",
                    if (self) "orcha-action" else "tool",
                    name,
                    jsonDetail(input),
                ),
            )
        }

        if (Regex("output_text|message_delta|agent_message_delta|assistant_message_delta").containsMatchIn(kind)) {
            val txt = visibleText(item["content"] ?: item["message"] ?: item["text"] ?: item["delta"])
                .ifEmpty { visibleText(p["content"] ?: p["message"] ?: p["text"] ?: p["delta"]) }
            return if (txt.isNotBlank()) listOf(RunFeedRow("narrate", "narration", txt)) else emptyList()
        }

        if (Regex("agent_message|assistant_message|message").containsMatchIn(kind) || item.str("role") == "assistant") {
            val txt = visibleText(item["content"] ?: item["message"] ?: item["text"] ?: item["delta"])
                .ifEmpty { visibleText(p["content"] ?: p["message"] ?: p["text"] ?: p["delta"]) }
            return if (txt.isNotBlank()) listOf(RunFeedRow("narrate", "narration", txt)) else emptyList()
        }

        if (Regex("error|failed").containsMatchIn(kind)) {
            return listOf(
                RunFeedRow(
                    "error", "error",
                    trunc(visibleText(p["message"] ?: p["error"] ?: p["reason"]).ifEmpty { ptype.ifEmpty { "error" } }, 200),
                    jsonDetail(p["error"] ?: p["detail"] ?: p),
                ),
            )
        }
        if (Regex("session.*(configured|created|started)|thread.*started").containsMatchIn(ptype)) {
            return listOf(RunFeedRow("boot", "wake", "codex $ptype"))
        }
        if (Regex("(turn|task|response).*(started|created|queued|in_progress|delta)").containsMatchIn(ptype)) {
            return listOf(RunFeedRow("narrate", "progress", "codex $ptype"))
        }
        if (Regex("(turn|task|response).*(completed|done|succeeded)").containsMatchIn(ptype)) {
            return listOf(RunFeedRow("done", "run-complete", "codex $ptype"))
        }
        return emptyList()
    }

    /** Web selfAction: a tool call whose INPUT hits an orcha skill or a self-serve API path. */
    private fun selfAction(input: JsonElement?): Boolean {
        val s = jsonDetail(input).lowercase()
        return orchaSkillRegex.containsMatchIn(s) || orchaApiRegex.containsMatchIn(s)
    }

    private fun jsonDetail(v: JsonElement?): String = when {
        v == null || v is JsonNull -> ""
        v is JsonPrimitive && v.isString -> v.content
        else -> v.toString()
    }

    /** Web visibleText: dig the human-readable text out of the common content shapes. */
    private fun visibleText(v: JsonElement?): String = when (v) {
        null, is JsonNull -> ""
        is JsonPrimitive -> v.contentOrNull ?: ""
        is JsonArray -> v.joinToString("\n") { visibleText(it) }.lines().filter { it.isNotEmpty() }.joinToString("\n")
        is JsonObject -> v.str("text") ?: v.str("output_text") ?: v.str("summary_text") ?: v.str("message")
            ?: v.str("content") ?: v.str("output")
            ?: (v["content"] as? JsonArray)?.let { visibleText(it) }
            ?: (v["output"] as? JsonArray)?.let { visibleText(it) }
            ?: ""
    }

    /** Web summaryText: reasoning-summary extraction (strings only, unlike visibleText). */
    private fun summaryText(v: JsonElement?): String = when (v) {
        null, is JsonNull -> ""
        is JsonPrimitive -> if (v.isString) v.content else ""
        is JsonArray -> v.joinToString("\n") { summaryText(it) }.lines().filter { it.isNotEmpty() }.joinToString("\n")
        is JsonObject -> v.str("text") ?: v.str("summary_text")
            ?: v.str("content")?.takeIf { Regex("summary").containsMatchIn((v.str("type") ?: "").lowercase()) }
            ?: (v["content"] as? JsonArray)?.let { summaryText(it) }
            ?: ""
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun trunc(s: String, n: Int): String = if (s.length <= n) s else s.take(n - 1) + "…"
}
