package io.openorcha.mobile.data

import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/**
 * Device-token auth (cloud unification): the in-memory origin -> bearer-token registry
 * consulted by the single Ktor request seam in [createOrchaHttpClient] so the
 * credential rides on every call -- reads, writes, and streams alike -- for any
 * container paired behind the auth perimeter. iOS parity: `AppModel`'s `BearerTokens`
 * referenced from `OrchaApiClient.swift`'s `makeRequest`.
 *
 * Keyed by normalized ORIGIN (`scheme://host:port`, with the scheme's default port
 * filled in), never by bare host: two Orcha servers on one hostname but different
 * ports (`https://orcha.example:8443` vs `:9443`), or http vs https, are distinct
 * deployments with distinct credentials, and a host-only key would let server A's
 * token ride to server B. Registered under every address a container is reachable
 * at, so the `baseUrl` / `remoteBaseUrl` failover pair still shares one token.
 * Populated from [ContainerStore.load] on app start ([seed]) and kept in sync by
 * every call that persists a token via [ContainerStore.setAccessToken] or a fresh
 * pairing/connect.
 */
object BearerTokens {
    private val tokens = ConcurrentHashMap<String, String>()

    /** Register (or clear, `token = null`/blank) the token this base URL's origin uses. */
    fun set(baseUrl: String, token: String?) {
        val origin = originOf(baseUrl) ?: return
        val normalized = token?.trim()?.takeIf { it.isNotEmpty() }
        if (normalized == null) tokens.remove(origin) else tokens[origin] = normalized
    }

    /** The registered token for this URL's origin, if any (path/query are ignored). */
    fun token(url: String): String? = originOf(url)?.let { tokens[it] }

    /** Rebuild from every stored container -- call once at startup (iOS `rebuild` parity). */
    fun seed(containers: List<StoredContainer>) {
        tokens.clear()
        containers.forEach { c ->
            set(c.baseUrl, c.accessToken)
            c.remoteBaseUrl?.let { set(it, c.accessToken) }
        }
    }

    /** Drop every registration (tests). */
    internal fun clear() = tokens.clear()

    /**
     * `scheme://host:port` with the default port made explicit, lower-cased -- so
     * `https://h` and `https://h:443/` are one origin while `https://h:8443` is another.
     * Null for anything that isn't an absolute http(s) URL.
     */
    internal fun originOf(url: String): String? = runCatching {
        val uri = URI(url.trim())
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = when {
            uri.port != -1 -> uri.port
            scheme == "https" -> 443
            scheme == "http" -> 80
            else -> return null
        }
        "$scheme://$host:$port"
    }.getOrNull()
}
