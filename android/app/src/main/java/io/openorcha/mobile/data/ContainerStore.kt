package io.openorcha.mobile.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

@Serializable
data class StoredContainer(
    val id: String,
    val displayName: String,
    val baseUrl: String,
    val humanAgentId: String? = null,
    val humanAlias: String? = null,
    val lastOpenedAt: Long = System.currentTimeMillis(),
    /**
     * LAN↔remote failover (iOS `AppModel.swift` parity, e.g. a Tailscale address):
     * a second base URL `refreshSelected()` tries when `baseUrl` doesn't answer,
     * swapping the two on success — symmetric, so it swaps back to LAN once it's
     * reachable again. Absent for connections paired without one (old stored JSON
     * decodes fine — `ignoreUnknownKeys` + this default).
     */
    val remoteBaseUrl: String? = null,
    /**
     * Device-token auth (cloud unification): the per-device bearer token minted by
     * the GitHub sign-in flow (or pasted manually) for a deployment behind the
     * auth perimeter. Absent for an unprotected local server, and for connections
     * paired before this field existed -- old stored JSON decodes fine
     * (`ignoreUnknownKeys` + this default), same pattern as `remoteBaseUrl`.
     */
    val accessToken: String? = null,
)

class ContainerStore(context: Context) {
    private val prefs = context.getSharedPreferences("orcha_containers", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun load(): List<StoredContainer> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return runCatching {
            json.decodeFromString(ListSerializer(StoredContainer.serializer()), raw)
        }.getOrDefault(emptyList())
    }

    fun save(containers: List<StoredContainer>) {
        val ordered = containers.distinctBy { it.id }.sortedByDescending { it.lastOpenedAt }
        prefs.edit()
            .putString(KEY, json.encodeToString(ListSerializer(StoredContainer.serializer()), ordered))
            .apply()
    }

    fun upsert(container: StoredContainer): List<StoredContainer> {
        val next = listOf(container) + load().filterNot { it.id == container.id }
        save(next)
        return next
    }

    fun remove(id: String): List<StoredContainer> {
        val next = load().filterNot { it.id == id }
        save(next)
        return next
    }

    /** Rename is LOCAL ONLY (flow 04): edits the phone's display name, never the server. */
    fun rename(id: String, displayName: String): List<StoredContainer> {
        val next = load().map { if (it.id == id) it.copy(displayName = displayName) else it }
        save(next)
        return next
    }

    /**
     * Settings "Add remote…" (iOS §6 parity): set/clear the failover address for one
     * container. `url = null` clears it — the card goes back to LAN-only.
     */
    fun setRemoteUrl(id: String, url: String?): List<StoredContainer> {
        val next = load().map { if (it.id == id) it.copy(remoteBaseUrl = url) else it }
        save(next)
        return next
    }

    /**
     * Device-token auth: persist (or clear, `token = null`/blank) the per-device
     * bearer token for one container -- set after a successful GitHub sign-in
     * round-trip, or by the Settings "Sign in again" manual-entry fallback.
     */
    fun setAccessToken(id: String, token: String?): List<StoredContainer> {
        val normalized = token?.trim()?.takeIf { it.isNotEmpty() }
        val next = load().map { if (it.id == id) it.copy(accessToken = normalized) else it }
        save(next)
        return next
    }

    /** Theme setting (foundations §7): Auto (default) / Light / Dark, applied instantly. */
    fun loadThemeMode(): String = prefs.getString(THEME_KEY, "auto") ?: "auto"

    fun saveThemeMode(mode: String) {
        prefs.edit().putString(THEME_KEY, mode).apply()
    }

    /**
     * Design/skin setting, portal + iOS parity (Settings → Appearance §3): classic
     * (default) / swiss / minimal, applied instantly. Stores the same literal scalar
     * the web's localStorage "orcha:skin" and iOS's `SkinMode` raw value use.
     */
    fun loadSkinMode(): String = prefs.getString(SKIN_KEY, "classic") ?: "classic"

    fun saveSkinMode(skin: String) {
        prefs.edit().putString(SKIN_KEY, skin).apply()
    }

    private companion object {
        const val KEY = "containers"
        const val THEME_KEY = "theme_mode"
        const val SKIN_KEY = "skin_mode"
    }
}
