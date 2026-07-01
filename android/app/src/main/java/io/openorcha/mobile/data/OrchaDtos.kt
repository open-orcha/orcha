package io.openorcha.mobile.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

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
    @SerialName("wake_enabled") val wakeEnabled: Boolean? = null,
    @SerialName("auto_wake_interval_secs") val autoWakeIntervalSecs: Int? = null,
    @SerialName("current_task") val currentTask: AgentTaskRef? = null,
    @SerialName("active_run") val activeRun: ActiveRunDto? = null,
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
    val result: String? = null,
    @SerialName("is_root") val isRoot: Boolean = false,
    val assignees: List<String> = emptyList(),
    @SerialName("message_summary") val messageSummary: MessageSummaryDto? = null,
    @SerialName("plan_message") val planMessage: TaskMessageDto? = null,
    @SerialName("plan_decision") val planDecision: String? = null,
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
    @SerialName("requester_id") val requesterId: String? = null,
    @SerialName("requester_alias") val requesterAlias: String? = null,
    @SerialName("target_id") val targetId: String? = null,
    @SerialName("target_alias") val targetAlias: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("responded_at") val respondedAt: String? = null,
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

