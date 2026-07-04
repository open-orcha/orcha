package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * One frame of GET /api/agents/{aid}/runs/{run_id}/stream. The server emits
 * `data: {"seq":n,"line":"…"}` per log line, comment heartbeats every second, and a
 * terminal `data: {"seq":n,"done":true,"status":…}` (30-min cap → status "stream_timeout").
 */
sealed class RunStreamEvent {
    abstract val seq: Int

    data class Line(override val seq: Int, val line: String) : RunStreamEvent()
    data class Done(override val seq: Int, val status: String?) : RunStreamEvent()
}

object RunStream {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /**
     * Parse one raw SSE line. Only `data: `-prefixed lines carry frames (the server never
     * uses `event:`/`id:` fields); heartbeat comments (`:` lines) and blanks yield null.
     */
    fun parse(raw: String): RunStreamEvent? {
        if (!raw.startsWith("data:")) return null
        val payload = raw.removePrefix("data:").trim()
        if (payload.isEmpty()) return null
        return runCatching {
            val obj = json.parseToJsonElement(payload) as? JsonObject ?: return@runCatching null
            val seq = (obj["seq"] as? JsonPrimitive)?.intOrNull ?: 0
            val done = (obj["done"] as? JsonPrimitive)?.booleanOrNull == true
            if (done) {
                RunStreamEvent.Done(seq, (obj["status"] as? JsonPrimitive)?.contentOrNull)
            } else {
                val line = (obj["line"] as? JsonPrimitive)?.contentOrNull
                if (line != null) RunStreamEvent.Line(seq, line) else null
            }
        }.getOrNull()
    }
}
