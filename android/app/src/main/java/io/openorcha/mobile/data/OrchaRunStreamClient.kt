package io.openorcha.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** Reads a live worker stream without applying the short request timeout. */
internal fun streamRun(
    client: HttpClient,
    baseUrl: String,
    agentId: String,
    runId: String,
): Flow<RunStreamEvent> = flow {
    client.prepareGet("$baseUrl/api/agents/$agentId/runs/$runId/stream") {
        timeout {
            requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
            socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
        }
    }.execute { response ->
        val channel = response.bodyAsChannel()
        while (true) {
            val raw = channel.readUTF8Line() ?: break
            RunStream.parse(raw)?.let { emit(it) }
        }
    }
}
