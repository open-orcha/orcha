package io.openorcha.mobile.domain

import java.net.URI
import java.net.URLDecoder

/**
 * The QR -> GitHub OAuth device-token contract (orcha-cloud): the pure URL logic on
 * both edges of the browser round-trip, kept free of session/UI concerns so it is
 * directly testable. Ports `ios/Orcha/Domain/DeviceAuth.swift` 1:1. Deliberately
 * built on `java.net.URI` rather than `android.net.Uri` -- like `OrchaServerAddress`
 * -- so this stays a plain-JUnit unit under `src/test`, no Robolectric/instrumentation
 * needed.
 *
 * Outbound: `https://<host>/auth/device` -- the perimeter walks the user through
 * GitHub OAuth, then the authenticated portal page mints a per-device token.
 * Inbound: that page redirects to `orcha://auth/callback?host=<host>&token=<token>`,
 * which the Custom Tab intent-filter on `MainActivity` intercepts.
 */
object DeviceAuth {
    /** The registered custom scheme the callback intent-filter watches for. */
    const val CALLBACK_SCHEME = "orcha"

    /** The minted credential handed back by the portal's device page. */
    data class Callback(val host: String, val token: String)

    /**
     * The browser entry point for a protected deployment: its device-token sign-in
     * page. `base` is the pairing base URL, e.g. `https://orcha.quantallabs.ai`.
     */
    fun startUrl(base: String): String? {
        val trimmed = base.trim().trimEnd('/')
        if (trimmed.isBlank()) return null
        return "$trimmed/auth/device"
    }

    /**
     * True for any `orcha://auth/...` URI -- the sub-namespace owned by this flow.
     * Any stray delivery of one of these (e.g. a relaunch from the recents tray)
     * must be swallowed rather than routed as a normal deep link.
     */
    fun isAuthCallback(uri: URI): Boolean =
        uri.scheme?.lowercase() == CALLBACK_SCHEME && uri.host?.lowercase() == "auth"

    /**
     * Parse `orcha://auth/callback?host=<host>&token=<token>`; null for anything
     * else -- wrong scheme/host/path, missing or empty parameters.
     */
    fun parseCallback(uri: URI): Callback? {
        if (!isAuthCallback(uri)) return null
        if (uri.path != "/callback") return null
        val params = parseQuery(uri.rawQuery)
        val host = params["host"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val token = params["token"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return Callback(host, token)
    }

    /** Parse a raw `orcha://...` string; null on any malformed URI. */
    fun parseCallback(raw: String): Callback? =
        runCatching { URI(raw) }.getOrNull()?.let { parseCallback(it) }

    /**
     * The minted token is only ever attached to the deployment the flow started
     * against: the callback's `host` must name the same host as the pending base
     * URL. Lenient about the shapes a server might send -- bare host, host:port,
     * or a full URL -- strict about the host itself.
     */
    fun callbackMatchesBase(callback: Callback, base: String): Boolean {
        val baseHost = runCatching { URI(base).host }.getOrNull()?.lowercase() ?: return false
        val raw = callback.host.lowercase()
        val candidate = if (raw.contains("://")) {
            runCatching { URI(raw).host }.getOrNull()
        } else {
            raw.split(":").firstOrNull()
        }
        return candidate == baseHost
    }

    /** Minimal `a=1&b=2` decoder -- avoids pulling in a URI-component library. */
    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        return rawQuery.split("&").mapNotNull { pair ->
            if (pair.isEmpty()) return@mapNotNull null
            val idx = pair.indexOf('=')
            val key = if (idx >= 0) pair.substring(0, idx) else pair
            val value = if (idx >= 0) pair.substring(idx + 1) else ""
            val decodedKey = runCatching { URLDecoder.decode(key, "UTF-8") }.getOrDefault(key)
            val decodedValue = runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
            decodedKey to decodedValue
        }.toMap()
    }
}
