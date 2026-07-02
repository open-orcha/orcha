package io.openorcha.mobile.data

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

/**
 * tasks.result is a JSONB column: /done writes `{"result": <text>, "by_agent_id": ...}`,
 * legacy rows may hold a bare string, and unset is null. The portal shipped the same
 * wrong assumption once (rendered "[object Object]") — this serializer accepts all
 * three shapes and yields the human-readable text.
 */
object FlexibleResultSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FlexibleTaskResult", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String? {
        val input = decoder as? JsonDecoder ?: return decoder.decodeString()
        return when (val el = input.decodeJsonElement()) {
            is JsonNull -> null
            is JsonPrimitive -> el.contentOrNull
            is JsonObject -> (el["result"] as? JsonPrimitive)?.contentOrNull ?: el.toString()
            else -> el.toString()
        }
    }

    override fun serialize(encoder: Encoder, value: String?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(value)
    }
}

@Serializable
data class ContainersResponse(
    val containers: List<ContainerDto> = emptyList(),
)

@Serializable
data class ContainerSnapshot(
    val container: ContainerDto,
    val agents: List<AgentDto> = emptyList(),
    val tasks: List<TaskDto> = emptyList(),
    val requests: List<RequestDto> = emptyList(),
    @SerialName("task_total") val taskTotal: Int? = null,
    @SerialName("request_total") val requestTotal: Int? = null,
)

@Serializable
data class ContainerDto(
    val id: String,
    val name: String,
    val description: String? = null,
    val status: String = "unknown",
    @SerialName("root_task_id") val rootTaskId: String? = null,
    @SerialName("wakes_enabled") val wakesEnabled: Boolean? = null,
    @SerialName("autonomy_level") val autonomyLevel: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("completed_at") val completedAt: String? = null,
)

@Serializable
data class AgentDto(
    val id: String,
    val alias: String,
    val role: String? = null,
    val kind: String = "ai",
    val status: String? = null,
    val model: String? = null,
    @SerialName("prompt_preview") val promptPreview: String? = null,
    @SerialName("wake_enabled") val wakeEnabled: Boolean? = null,
    @SerialName("auto_wake_interval_secs") val autoWakeIntervalSecs: Int? = null,
    @SerialName("current_task") val currentTask: AgentTaskRef? = null,
    @SerialName("active_run") val activeRun: ActiveRunDto? = null,
    @SerialName("last_active") val lastActive: String? = null,
    @SerialName("heartbeat_age_secs") val heartbeatAgeSecs: Double? = null,
    @SerialName("terminated_at") val terminatedAt: String? = null,
)

@Serializable
data class AgentTaskRef(
    @SerialName("task_id") val taskId: String? = null,
    val title: String? = null,
)

@Serializable
data class ActiveRunDto(
    @SerialName("run_id") val runId: String,
    @SerialName("wake_event") val wakeEvent: String? = null,
    @SerialName("wake_kind") val wakeKind: String? = null,
    val runtime: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("task_title") val taskTitle: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
)

@Serializable
data class TaskDto(
    val id: String,
    val title: String,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String? = null,
    val status: String = "unknown",
    val priority: Int? = null,
    @Serializable(with = FlexibleResultSerializer::class)
    val result: String? = null,
    @SerialName("is_root") val isRoot: Boolean = false,
    @SerialName("created_by_agent_id") val createdByAgentId: String? = null,
    @SerialName("owner_alias") val ownerAlias: String? = null,
    @SerialName("owner_id") val ownerId: String? = null,
    val assignees: List<String> = emptyList(),
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("completed_at") val completedAt: String? = null,
    @SerialName("message_summary") val messageSummary: MessageSummaryDto? = null,
    @SerialName("plan_message") val planMessage: TaskMessageDto? = null,
    @SerialName("plan_decision") val planDecision: String? = null,
    @SerialName("depends_on") val dependsOn: List<String> = emptyList(),
)

@Serializable
data class MessageSummaryDto(
    val count: Int = 0,
    val last: TaskMessageDto? = null,
)

@Serializable
data class TaskMessageDto(
    @SerialName("message_id") val messageId: String? = null,
    @SerialName("author_id") val authorId: String? = null,
    @SerialName("author_alias") val authorAlias: String? = null,
    @SerialName("is_human") val isHuman: Boolean = false,
    val body: String = "",
    val attachments: List<JsonElement> = emptyList(),
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class RequestDto(
    val id: String,
    val type: String = "info",
    val status: String = "open",
    val priority: Int? = null,
    val payload: String = "",
    val response: String? = null,
    @SerialName("rejection_reason") val rejectionReason: String? = null,
    @SerialName("requester_id") val requesterId: String? = null,
    @SerialName("requester_alias") val requesterAlias: String? = null,
    @SerialName("target_id") val targetId: String? = null,
    @SerialName("target_alias") val targetAlias: String? = null,
    @SerialName("parent_request_id") val parentRequestId: String? = null,
    @SerialName("chain_depth") val chainDepth: Int = 0,
    @SerialName("spawned_task_id") val spawnedTaskId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("responded_at") val respondedAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    val detail: JsonElement? = null,
    @SerialName("task_link") val taskLink: TaskLinkDto? = null,
)

@Serializable
data class TaskLinkDto(
    @SerialName("task_id") val taskId: String? = null,
    val title: String? = null,
)

@Serializable
data class TaskMessagesResponse(
    @SerialName("task_id") val taskId: String,
    val task: TaskHeaderDto? = null,
    val messages: List<TaskMessageDto> = emptyList(),
)

@Serializable
data class TaskHeaderDto(
    val title: String,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String? = null,
)

@Serializable
data class RunsResponse(
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    val runs: List<RunDto> = emptyList(),
)

@Serializable
data class RunDto(
    @SerialName("run_id") val runId: String,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("agent_alias") val agentAlias: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("task_title") val taskTitle: String? = null,
    val status: String = "unknown",
    @SerialName("wake_kind") val wakeKind: String? = null,
    @SerialName("wake_event") val wakeEvent: String? = null,
    val runtime: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("exit_code") val exitCode: Int? = null,
)

@Serializable
data class ModelsResponse(
    val models: List<ModelDto> = emptyList(),
    val default: String? = null,
)

@Serializable
data class ModelDto(
    val id: String,
    val name: String? = null,
    val provider: String? = null,
    val runtime: String? = null,
)

@Serializable
data class ConversationDto(
    val id: String,
    @SerialName("agent_id") val agentId: String? = null,
    val status: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("last_turn_at") val lastTurnAt: String? = null,
)

@Serializable
data class ConversationResponse(
    val conversation: ConversationDto? = null,
    val turns: List<TurnDto> = emptyList(),
    val created: Boolean? = null,
)

@Serializable
data class TurnsResponse(
    @SerialName("conversation_id") val conversationId: String? = null,
    val turns: List<TurnDto> = emptyList(),
)

@Serializable
data class TurnDto(
    val id: String? = null,
    val seq: Int = 0,
    val role: String = "human",
    @SerialName("author_agent_id") val authorAgentId: String? = null,
    val content: String = "",
    @SerialName("run_id") val runId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

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

@Serializable
class EmptyBody

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
)
