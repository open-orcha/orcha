package io.openorcha.mobile.data

/** Defines write-side request bodies and small action responses from Orcha's API. */

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class TaskMessageBody(
    @SerialName("author_agent_id") val authorAgentId: String? = null,
    val body: String,
)

@Serializable
data class TaskVerifyBody(
    val approve: Boolean,
    val feedback: String? = null,
    @SerialName("actor_agent_id") val actorAgentId: String,
)

@Serializable
data class TaskCancelBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    val reason: String? = null,
)

@Serializable
data class DecisionBody(
    @SerialName("subject_type") val subjectType: String,
    @SerialName("subject_id") val subjectId: String,
    val decision: String,
    val reason: String? = null,
    @SerialName("actor_agent_id") val actorAgentId: String,
    @SerialName("target_agent_id") val targetAgentId: String? = null,
)

@Serializable
data class RequestRespondBody(
    @SerialName("responder_agent_id") val responderAgentId: String,
    val response: String,
)

@Serializable
data class RequestActorBody(
    @SerialName("requester_agent_id") val requesterAgentId: String,
    val reason: String? = null,
)

@Serializable
data class NudgeBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    val note: String? = null,
)

@Serializable
data class TaskRequestAcceptBody(
    @SerialName("responder_agent_id") val responderAgentId: String,
    val note: String? = null,
)

@Serializable
data class TaskRequestRejectBody(
    @SerialName("responder_agent_id") val responderAgentId: String,
    val reason: String,
)

@Serializable
data class RequestConvertBody(
    @SerialName("requester_agent_id") val requesterAgentId: String,
    val title: String,
    @SerialName("definition_of_done") val definitionOfDone: String,
    val priority: Int = 100,
    @SerialName("assignee_alias") val assigneeAlias: String? = null,
)

@Serializable
data class AgentModelBody(
    val model: String,
)

@Serializable
data class AutoWakeBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    @SerialName("interval_secs") val intervalSecs: Int? = null,
)

@Serializable
data class AgentRetireBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
)

/** GH #148: the notifier kill-switch — `false` halts ALL wakes for the container. */
@Serializable
data class WakesToggleBody(
    val enabled: Boolean,
    @SerialName("actor_agent_id") val actorAgentId: String? = null,
)

@Serializable
data class WakesResponse(
    @SerialName("container_id") val containerId: String,
    @SerialName("wakes_enabled") val wakesEnabled: Boolean,
)

/** GH #148: the autonomy gearbox — `plan` | `pr` | `full`, human-gated server-side. */
@Serializable
data class AutonomyUpdateBody(
    val level: String,
    @SerialName("actor_agent_id") val actorAgentId: String,
)

@Serializable
data class AutonomyResponse(
    @SerialName("container_id") val containerId: String,
    @SerialName("autonomy_level") val autonomyLevel: String,
)

@Serializable
data class ConversationStartBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
)

@Serializable
data class ConversationActorBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
)

@Serializable
data class TurnAppendBody(
    val role: String,
    @SerialName("author_agent_id") val authorAgentId: String,
    val content: String,
)

@Serializable
data class TaskCreateBody(
    val title: String,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String,
    val priority: Int = 100,
    @SerialName("created_by_agent_id") val createdByAgentId: String? = null,
    @SerialName("assignee_alias") val assigneeAlias: String? = null,
    @SerialName("depends_on") val dependsOn: List<String> = emptyList(),
    @SerialName("not_ready") val notReady: Boolean = false,
)

@Serializable
data class AssignTaskBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    @SerialName("agent_id") val agentId: String,
    val reassign: Boolean = false,
)

@Serializable
data class WorkerRunStopBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
)

/* ---------- flow 09: agent detail lazy sections ---------- */

@Serializable
data class PersonaResponse(
    @SerialName("agent_id") val agentId: String? = null,
    val alias: String? = null,
    val role: String? = null,
    val model: String? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
)

@Serializable
data class DigestItem(val text: String = "")

@Serializable
data class DigestDto(
    @SerialName("current_focus") val currentFocus: String? = null,
    val decisions: List<DigestItem> = emptyList(),
    val learnings: List<DigestItem> = emptyList(),
    @SerialName("open_threads") val openThreads: List<DigestItem> = emptyList(),
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class DigestResponse(val digest: DigestDto? = null)

@Serializable
data class InboxResponse(@SerialName("open_requests") val openRequests: List<RequestDto> = emptyList())

@Serializable
data class OutboxResponse(@SerialName("outgoing_requests") val outgoingRequests: List<RequestDto> = emptyList())

@Serializable
data class AgentUpdateBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    val alias: String? = null,
    val role: String? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
)

/** Lenient: server copy varies; render whatever strings it offers, else generic copy. */
@Serializable
data class CloseImplicationsResponse(
    val implications: List<String> = emptyList(),
    val summary: String? = null,
    val detail: JsonElement? = null,
)

@Serializable
data class GenericIdResponse(
    val id: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("request_id") val requestId: String? = null,
    @SerialName("spawned_task_id") val spawnedTaskId: String? = null,
    val status: String? = null,
    // flow 07a: nudge returns {nudged: bool} (false = next action is a human — informative no-op);
    // close returns {already_closed: bool} on an idempotent re-close (still a success).
    val nudged: Boolean? = null,
    @SerialName("already_closed") val alreadyClosed: Boolean? = null,
)
