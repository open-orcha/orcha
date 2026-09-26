package io.openorcha.mobile.data

import io.ktor.client.plugins.ResponseException
import io.ktor.client.call.body
import io.ktor.client.request.get
import kotlinx.coroutines.runBlocking
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Regression guard for the shared Ktor client's `expectSuccess` contract: several
 * call sites (device-token auth's [isAuthRequired], `GitHubHubActions`'
 * `statusOfGithubError`) catch `ResponseException` to read a failed response's
 * status code, which only happens if the client is configured to throw on a
 * non-2xx response -- Ktor 3.x's client-level default for this does NOT do that,
 * so `expectSuccess = true` in [createOrchaHttpClient] is load-bearing, not
 * redundant. Exercised against a real socket (not a fake engine) so a config
 * regression that silently disables this is caught here, not by a request that
 * quietly starts decoding an error page as a DTO instead of throwing.
 */
class OrchaHttpClientTest {
    @Test
    fun aNon2xxResponseThrowsResponseException() {
        val server = ServerSocket(0)
        val serverThread = thread {
            val socket = server.accept()
            socket.getInputStream().bufferedReader().readLine() // consume the request line, ignore rest
            socket.getOutputStream().write(
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(),
            )
            socket.close()
        }
        try {
            val port = server.localPort
            val client = createOrchaHttpClient()
            var caught: ResponseException? = null
            runBlocking {
                try {
                    client.get("http://127.0.0.1:$port/api/containers")
                } catch (e: ResponseException) {
                    caught = e
                }
            }
            assertTrue(caught != null, "expected a ResponseException on a 401 response")
            assertTrue(isAuthRequired(caught), "isAuthRequired must recognize the thrown 401")
        } finally {
            serverThread.join(2_000)
            server.close()
        }
    }
}

class PerimeterInterceptTest {
    // iOS `perimeterIntercepted` parity: the three ways the auth perimeter answers
    // a portal-JSON request, classified before any decode can misfire.

    private fun serve(response: String, block: suspend (port: Int) -> Unit) = kotlinx.coroutines.runBlocking {
        val server = java.net.ServerSocket(0)
        val port = server.localPort
        val accept = kotlin.concurrent.thread {
            runCatching {
                val sock = server.accept()
                sock.getInputStream().bufferedReader().readLine()
                sock.getOutputStream().write(response.toByteArray())
                sock.getOutputStream().flush()
                sock.close()
            }
        }
        try { block(port) } finally { runCatching { server.close() }; accept.join(2000) }
    }

    @Test
    fun htmlBodyOnSuccessClassifiesAsAuthRequired() = serve(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 28\r\nConnection: close\r\n\r\n<!doctype html><html></html>",
    ) { port ->
        val client = createOrchaHttpClient()
        val err = runCatching {
            client.get("http://127.0.0.1:$port/api/containers").body<String>()
        }.exceptionOrNull()
        assertTrue(isAuthRequired(err), "expected OrchaAuthRequiredException, got $err")
    }

    @Test
    fun direct401ClassifiesAsAuthRequired() = serve(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    ) { port ->
        val client = createOrchaHttpClient()
        val err = runCatching { client.get("http://127.0.0.1:$port/api/x").body<String>() }.exceptionOrNull()
        assertTrue(isAuthRequired(err))
    }

    @Test
    fun jsonPortalErrorPassesThroughAsNotAuth() = serve(
        "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    ) { port ->
        val client = createOrchaHttpClient()
        val err = runCatching { client.get("http://127.0.0.1:$port/api/x").body<String>() }.exceptionOrNull()
        assertTrue(err != null && !isAuthRequired(err))
    }
}
