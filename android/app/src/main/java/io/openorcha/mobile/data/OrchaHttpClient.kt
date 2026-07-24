package io.openorcha.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.call.body
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

/** Configures the shared Ktor transport and tolerant JSON reader for Orcha calls. */
internal fun createOrchaHttpClient(): HttpClient {
    val wireJson = Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
    }
    return HttpClient(OkHttp) {
        install(ContentNegotiation) { json(wireJson) }
        install(HttpTimeout) {
            requestTimeoutMillis = 10_000
            connectTimeoutMillis = 3_000
            socketTimeoutMillis = 10_000
        }
    }
}

/** Executes typed JSON writes while preserving the API client's timeout contract. */
internal class OrchaJsonTransport(private val client: HttpClient) {
    suspend inline fun <reified T : Any, reified R> post(url: String, payload: T): R =
        withTimeout(10_000) {
            val response: HttpResponse = client.post(url) {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            response.body()
        }

    suspend inline fun <reified T : Any, reified R> patch(url: String, payload: T): R =
        withTimeout(10_000) {
            val response: HttpResponse = client.patch(url) {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            response.body()
        }
}
