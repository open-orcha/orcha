package io.openorcha.mobile.data

/* D14 project icon write — `PUT /api/containers/{cid}/icon {icon, actor_agent_id}`. The body
   is built explicitly so `"icon": null` (clear) reaches the wire (the shared client drops
   defaults). Own client instance, same bearer-auth plugin as the shared client. */

import io.ktor.client.call.body
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.openorcha.mobile.domain.ProjectIconValue
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

@Serializable
data class ProjectIconResponse(
    @SerialName("container_id") val containerId: String? = null,
    val icon: JsonElement? = null,
)

object ProjectIconApi {
    private val client by lazy { createOrchaHttpClient() }

    fun body(icon: ProjectIconValue?, actorId: String?): JsonObject = buildJsonObject {
        put("icon", icon?.toJson() ?: JsonNull)
        put("actor_agent_id", actorId?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    suspend fun setIcon(baseUrl: String, cid: String, actorId: String?, icon: ProjectIconValue?): ProjectIconResponse =
        withTimeout(10_000) {
            client.put("${baseUrl.endpoint()}/api/containers/$cid/icon") {
                contentType(ContentType.Application.Json)
                setBody(body(icon, actorId))
            }.body()
        }
}
