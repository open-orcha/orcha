package io.openorcha.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.call.body
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.client.statement.request
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

/**
 * Device-token auth (cloud unification): every request is authorized here, the one
 * seam every `OrchaApiClient`/`GitHubHubApi`/`streamRun` call funnels through --
 * reads, writes, and streams alike -- whenever [BearerTokens] has a token for the
 * request's host. iOS parity: `OrchaApiClient.swift`'s `makeRequest` comment.
 *
 * A caller that needs to probe with a token that ISN'T persisted yet (the pairing
 * retry with a freshly minted device token, or the reachability probe's
 * `Bearer probe`) sets the `X-Orcha-Bearer-Override` header before dispatch; this
 * plugin swaps it for a real `Authorization` header and strips the marker, so an
 * override always wins over anything already registered for that host.
 */
/**
 * The auth perimeter intercepted the request (bearer missing or rejected). iOS
 * parity: `OrchaApiClient.perimeterIntercepted` — the perimeter never answers
 * portal JSON without a valid credential; the request falls through to the
 * browser OAuth lane and, after the redirects are followed, comes back as an
 * HTML page (or a direct 401). Surfaced as its own type so connect flows show
 * "sign in", never a decode error dressed up as a network failure.
 */
internal class OrchaAuthRequiredException(url: String) :
    Exception("Auth perimeter intercepted: " + url)

private const val BEARER_OVERRIDE_HEADER = "X-Orcha-Bearer-Override"

private val BearerAuthPlugin = createClientPlugin("BearerAuthPlugin") {
    onRequest { request, _ ->
        val override = request.headers[BEARER_OVERRIDE_HEADER]
        if (override != null) {
            request.headers.remove(BEARER_OVERRIDE_HEADER)
            request.headers[HttpHeaders.Authorization] = "Bearer $override"
            return@onRequest
        }
        val token = BearerTokens.token(request.url.buildString())
        if (token != null) {
            request.headers[HttpHeaders.Authorization] = "Bearer $token"
        }
    }
}

/** Configures the shared Ktor transport and tolerant JSON reader for Orcha calls. */
internal fun createOrchaHttpClient(): HttpClient {
    val wireJson = Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
    }
    return HttpClient(OkHttp) {
        // Device-token auth: a 401 from the auth perimeter (and any other non-2xx)
        // must throw a `ResponseException` so `isAuthRequired`/`statusOfGithubError`
        // can inspect it -- `.body()` decoding an error page as a DTO otherwise
        // surfaces as an opaque serialization failure instead. Explicit rather than
        // relying on Ktor's own default, which this project's target version does
        // NOT enable client-wide.
        expectSuccess = true
        install(ContentNegotiation) { json(wireJson) }
        install(HttpTimeout) {
            requestTimeoutMillis = 10_000
            connectTimeoutMillis = 3_000
            socketTimeoutMillis = 10_000
        }
        install(BearerAuthPlugin)
        // iOS `perimeterIntercepted` clone, arm (b): a 2xx whose body is HTML can
        // only be the perimeter's sign-in/welcome page standing in for portal
        // JSON (OkHttp already followed the 302). Arm (a), the direct 401, is
        // covered by expectSuccess -> ResponseException in isAuthRequired.
        HttpResponseValidator {
            validateResponse { response ->
                val contentType = response.contentType()
                if (contentType != null && contentType.match(ContentType.Text.Html)) {
                    throw OrchaAuthRequiredException(response.request.url.toString())
                }
            }
        }
    }
}

/**
 * Attach a bearer credential to one request that isn't (yet) registered in
 * [BearerTokens] -- the pairing/reachability probe path. Set before the request is
 * sent; [BearerAuthPlugin] converts it into a real `Authorization` header.
 */
internal fun io.ktor.client.request.HttpRequestBuilder.bearerOverride(token: String) {
    headers.append(BEARER_OVERRIDE_HEADER, token)
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
