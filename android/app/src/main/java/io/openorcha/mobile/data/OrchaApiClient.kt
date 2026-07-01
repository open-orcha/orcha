package io.openorcha.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

class OrchaApiClient {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
    }

    private val client = HttpClient(OkHttp) {
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            requestTimeoutMillis = 5_000
            connectTimeoutMillis = 3_000
            socketTimeoutMillis = 5_000
        }
    }

    suspend fun listContainers(baseUrl: String): ContainersResponse = withTimeout(6_000) {
        client.get("${baseUrl.clean()}/api/containers").body()
    }

    suspend fun getSnapshot(baseUrl: String, containerId: String): ContainerSnapshot = withTimeout(8_000) {
        client.get("${baseUrl.clean()}/api/containers/$containerId").body()
    }

    suspend fun getTaskMessages(baseUrl: String, taskId: String): TaskMessagesResponse = withTimeout(8_000) {
        client.get("${baseUrl.clean()}/api/tasks/$taskId/messages").body()
    }

    private fun String.clean(): String = trim().trimEnd('/')
}

