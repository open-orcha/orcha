package io.openorcha.mobile.data

/* Inbox slice API: notification preferences, routines, members, synced prefs, GitHub
   repo connect, and the deferred request close. A separate client instance so this slice
   never edits the shared OrchaApiClient — it carries the same bearer-auth plugin
   (BearerTokens is process-wide), timeouts and tolerant JSON reader. Write bodies are
   JsonObjects so an explicit `null` (unpause, unbind, quiet hours off) reaches the wire;
   the shared wire Json omits null data-class fields. */

import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object InboxApi {
    private val client by lazy { createOrchaHttpClient() }

    private fun actorQuery(actorId: String?): String =
        actorId?.let { "?actor_agent_id=${it.encodeURLParameter()}" } ?: ""

    private fun JsonObject.withActor(actorId: String?): JsonObject =
        if (actorId == null) this else JsonObject(this + ("actor_agent_id" to JsonPrimitive(actorId)))

    // ── notification preferences ──

    suspend fun notificationPrefs(baseUrl: String, cid: String, actorId: String?): NotifPrefsPayload = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/notification-prefs${actorQuery(actorId)}").body()
    }

    /** PUT this project's override: `rules` replaces the whole override map; `muted` toggles mute. */
    suspend fun putProjectPrefs(baseUrl: String, cid: String, actorId: String?, body: JsonObject): NotifPrefsPayload =
        withTimeout(10_000) {
            client.put("${baseUrl.endpoint()}/api/containers/$cid/notification-prefs") {
                contentType(ContentType.Application.Json)
                setBody(body.withActor(actorId))
            }.body()
        }

    /** DELETE the project override — the project follows the person's defaults again. */
    suspend fun resetProjectPrefs(baseUrl: String, cid: String, actorId: String?): NotifPrefsPayload = withTimeout(10_000) {
        client.delete("${baseUrl.endpoint()}/api/containers/$cid/notification-prefs${actorQuery(actorId)}").body()
    }

    /** PUT the person's defaults: complete `rules`, `pause` and/or `quiet_hours` (JsonNull = off). */
    suspend fun putDefaultPrefs(baseUrl: String, cid: String, actorId: String?, body: JsonObject): NotifPrefsPayload =
        withTimeout(10_000) {
            client.put("${baseUrl.endpoint()}/api/containers/$cid/notification-prefs/defaults") {
                contentType(ContentType.Application.Json)
                setBody(body.withActor(actorId))
            }.body()
        }

    // ── routines ──

    suspend fun routines(baseUrl: String, cid: String): InboxRoutinesResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/routines").body()
    }

    suspend fun routineRuns(baseUrl: String, rid: String): InboxRoutineRunsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/routines/$rid/runs").body()
    }

    suspend fun setRoutineEnabled(baseUrl: String, rid: String, actorId: String?, enabled: Boolean): InboxRoutineDto =
        withTimeout(10_000) {
            client.patch("${baseUrl.endpoint()}/api/routines/$rid") {
                contentType(ContentType.Application.Json)
                setBody(buildJsonObject { put("enabled", enabled) }.withActor(actorId))
            }.body()
        }

    suspend fun runRoutineNow(baseUrl: String, rid: String, actorId: String?): InboxRoutineRunNowResponse = withTimeout(15_000) {
        client.post("${baseUrl.endpoint()}/api/routines/$rid/run") {
            contentType(ContentType.Application.Json)
            setBody(JsonObject(emptyMap()).withActor(actorId))
        }.body()
    }

    suspend fun deleteRoutine(baseUrl: String, rid: String, actorId: String?) {
        withTimeout(10_000) {
            client.delete("${baseUrl.endpoint()}/api/routines/$rid${actorQuery(actorId)}").body<JsonElement>()
        }
    }

    // ── members & synced prefs ──

    suspend fun members(baseUrl: String, cid: String): InboxMembersResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/members").body()
    }

    /** The signed-in user's cosmetic prefs bag, or null (self-host / trust-off: stay local). */
    suspend fun getPrefs(baseUrl: String): JsonObject? = withTimeout(6_000) {
        val root: JsonObject = client.get("${baseUrl.endpoint()}/api/prefs").body()
        root["prefs"] as? JsonObject
    }

    /** Whole-bag replace of the signed-in user's cosmetic prefs. */
    suspend fun putPrefs(baseUrl: String, prefs: JsonObject) {
        withTimeout(8_000) {
            client.put("${baseUrl.endpoint()}/api/prefs") {
                contentType(ContentType.Application.Json)
                setBody(buildJsonObject { put("prefs", prefs) })
            }.body<JsonElement>()
        }
    }

    // ── GitHub repo connect ──

    suspend fun githubRepos(baseUrl: String, cid: String?): InboxGithubReposResponse = withTimeout(12_000) {
        val q = cid?.let { "?cid=${it.encodeURLParameter()}" } ?: ""
        client.get("${baseUrl.endpoint()}/api/github/repos$q").body()
    }

    /** Bind ("owner/name") or unbind (null) the project's repository. */
    suspend fun setGithubRepo(baseUrl: String, cid: String, repo: String?): InboxGithubBindingResponse = withTimeout(10_000) {
        client.put("${baseUrl.endpoint()}/api/containers/$cid/github") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("repo", repo?.let { JsonPrimitive(it) } ?: JsonNull) })
        }.body()
    }

    // ── requests ──

    /** The requester resolving its own answered request (no reason) — the deferred Resolve. */
    suspend fun closeRequest(baseUrl: String, requestId: String, requesterId: String) {
        withTimeout(10_000) {
            client.post("${baseUrl.endpoint()}/api/requests/$requestId/close") {
                contentType(ContentType.Application.Json)
                setBody(buildJsonObject { put("requester_agent_id", requesterId) })
            }.body<JsonElement>()
        }
    }
}
