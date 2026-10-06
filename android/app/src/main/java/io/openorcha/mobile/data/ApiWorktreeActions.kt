package io.openorcha.mobile.data

/* Agent worktree "Clean up now": a human request the host notifier carries out, then polled
   for its answer (iOS `requestWorktreeCleanup` / `worktreeAction`). Own client instance, same
   bearer-auth plugin as the shared client, so this slice never edits the shared client. */

import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object WorktreeActionsApi {
    private val client by lazy { createOrchaHttpClient() }

    /** Clean up every clean worktree; output-holding and unmerged ones are left alone. */
    suspend fun requestCleanup(baseUrl: String, cid: String, actorId: String?): WorktreeActionDto = withTimeout(10_000) {
        client.post("${baseUrl.endpoint()}/api/containers/$cid/agent-worktrees/actions") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("action", "clean_up")
                put("include_output", false)
                put("unmerged_paths", JsonArray(emptyList()))
                put("actor_agent_id", actorId?.let { JsonPrimitive(it) } ?: JsonNull)
            })
        }.body()
    }

    suspend fun action(baseUrl: String, cid: String, actionId: String): WorktreeActionDto = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/agent-worktrees/actions/$actionId").body()
    }

    /** File the clean-up, then poll every 2 s for up to 30 s (web parity). Returns the last
     *  state seen — still [WorktreeActionDto.pending] when the notifier hasn't answered. */
    suspend fun cleanUpAndWait(baseUrl: String, cid: String, actorId: String?): WorktreeActionDto {
        var action = requestCleanup(baseUrl, cid, actorId)
        var tries = 0
        while (action.pending && tries < 15) {
            delay(2_000)
            action = action(baseUrl, cid, action.id)
            tries++
        }
        return action
    }
}
