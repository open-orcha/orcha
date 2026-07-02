package io.openorcha.mobile.data

import java.net.URI

object OrchaServerAddress {
    private const val DEFAULT_LOCAL_PORT = 8001

    fun normalize(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isBlank() || trimmed == "http://" || trimmed == "https://") {
            invalid()
        }
        if (trimmed.any { it.isWhitespace() }) {
            invalid()
        }

        val hasHttpScheme = trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        if (trimmed.endsWith(":", ignoreCase = true) || (!hasHttpScheme && trimmed.contains("://"))) {
            invalid()
        }

        val candidate = if (hasHttpScheme) trimmed else "http://$trimmed"
        val uri = try {
            URI(candidate)
        } catch (_: IllegalArgumentException) {
            invalid()
        }

        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            invalid()
        }

        val host = uri.host?.takeIf { it.isNotBlank() } ?: invalid()
        if (host.equals("localhost", ignoreCase = true) || host == "127.0.0.1" || host == "::1") {
            throw IllegalArgumentException(
                "Use your computer's Wi-Fi address instead of localhost. Localhost points at the phone.",
            )
        }

        val formattedHost = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
        val parsedPort = uri.port
        val port = when {
            parsedPort >= 0 -> ":$parsedPort"
            scheme == "http" -> ":$DEFAULT_LOCAL_PORT"
            else -> ""
        }
        return "$scheme://$formattedHost$port"
    }

    private fun invalid(): Nothing {
        throw IllegalArgumentException(
            "Enter your computer's local address, for example 192.168.1.8:8001.",
        )
    }
}
