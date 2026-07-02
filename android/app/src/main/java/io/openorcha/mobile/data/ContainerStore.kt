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

    /** Theme setting (foundations §7): Auto (default) / Light / Dark, applied instantly. */
    fun loadThemeMode(): String = prefs.getString(THEME_KEY, "auto") ?: "auto"

    fun saveThemeMode(mode: String) {
        prefs.edit().putString(THEME_KEY, mode).apply()
    }

    private companion object {
        const val KEY = "containers"
        const val THEME_KEY = "theme_mode"
    }
}
