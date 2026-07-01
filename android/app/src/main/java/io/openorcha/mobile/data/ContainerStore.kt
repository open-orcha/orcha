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

    private companion object {
        const val KEY = "containers"
    }
}

