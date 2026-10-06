package io.openorcha.mobile.data

/* Inbox slice DTOs: notification preferences, routines, members, synced prefs and the
   GitHub repo-connect list. Shapes mirror the portal backend (notification_pref_routes,
   routine_routes, member_routes, user_pref_routes, github_routes). Every field is
   defaulted so an older or newer server still decodes. */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// ── Notification preferences ─────────────────────────────────────────────────

@Serializable
data class NotifCategory(val key: String, val label: String = "", val description: String? = null)

@Serializable
data class NotifChannel(val key: String, val label: String = "", val alert: Boolean = false)

@Serializable
data class NotifScope(val key: String, val label: String = "")

@Serializable
data class NotifRule(val scope: String = "all", val channels: Map<String, Boolean> = emptyMap())

/** A project override entry: either half may be absent (inherit it from the defaults). */
@Serializable
data class NotifPartialRule(val scope: String? = null, val channels: Map<String, Boolean>? = null)

@Serializable
data class NotifPreset(
    val key: String,
    val label: String = "",
    val description: String? = null,
    val rules: Map<String, NotifRule> = emptyMap(),
)

@Serializable
data class NotifLock(val category: String, val channel: String, val reason: String? = null)

@Serializable
data class NotifCatalog(
    val categories: List<NotifCategory> = emptyList(),
    val channels: List<NotifChannel> = emptyList(),
    val scopes: List<NotifScope> = emptyList(),
    val presets: List<NotifPreset> = emptyList(),
    val locks: List<NotifLock> = emptyList(),
)

/** `null` on the wire = not paused; `{until: null}` = until turned back on; else epoch seconds. */
@Serializable
data class NotifPause(val until: Double? = null)

@Serializable
data class NotifQuietHours(val start: String = "22:00", val end: String = "07:00", val tz: String = "UTC")

@Serializable
data class NotifDefaults(
    val rules: Map<String, NotifRule> = emptyMap(),
    val pause: NotifPause? = null,
    @SerialName("quiet_hours") val quietHours: NotifQuietHours? = null,
    val stored: Boolean = false,
)

@Serializable
data class NotifProject(
    val rules: Map<String, NotifPartialRule> = emptyMap(),
    val muted: Boolean = false,
    val stored: Boolean = false,
)

@Serializable
data class NotifChannelAvailability(val available: Boolean = true, val reason: String? = null)

@Serializable
data class NotifMember(val id: String? = null, val alias: String? = null, @SerialName("member_role") val memberRole: String? = null)

@Serializable
data class NotifPrefsPayload(
    val member: NotifMember? = null,
    val catalog: NotifCatalog = NotifCatalog(),
    val channels: Map<String, NotifChannelAvailability> = emptyMap(),
    val defaults: NotifDefaults = NotifDefaults(),
    val project: NotifProject = NotifProject(),
    val editable: Boolean = true,
)

// ── Routines ────────────────────────────────────────────────────────────────

@Serializable
data class InboxRoutineRunDto(
    @SerialName("run_id") val runId: String? = null,
    val outcome: String = "pending",
    val trigger: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("task_status") val taskStatus: String? = null,
    @SerialName("task_title") val taskTitle: String? = null,
    val detail: JsonElement? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("missed_count") val missedCount: Int? = null,
    @SerialName("actor_alias") val actorAlias: String? = null,
) {
    /** The run's human detail line (a string on the wire), never raw JSON. */
    val detailText: String?
        get() = (detail as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
}

@Serializable
data class InboxRoutineDto(
    val id: String,
    val title: String = "",
    @SerialName("title_preview") val titlePreview: String? = null,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String = "",
    @SerialName("assignee_alias") val assigneeAlias: String? = null,
    @SerialName("assignee_retired") val assigneeRetired: Boolean = false,
    val cron: String = "",
    val timezone: String = "UTC",
    @SerialName("schedule_text") val scheduleText: String = "",
    val enabled: Boolean = true,
    @SerialName("skip_if_open") val skipIfOpen: Boolean = true,
    @SerialName("next_run_at") val nextRunAt: String? = null,
    @SerialName("last_run_at") val lastRunAt: String? = null,
    @SerialName("last_run") val lastRun: InboxRoutineRunDto? = null,
    @SerialName("origin_task_title") val originTaskTitle: String? = null,
) {
    /** Web `routineTitle`: the server-rendered preview of a templated title, else the title. */
    val displayTitle: String get() = titlePreview?.takeIf { it.isNotBlank() } ?: title
}

@Serializable
data class InboxRoutineSchedulerDto(@SerialName("last_tick_at") val lastTickAt: String? = null)

@Serializable
data class InboxRoutinesResponse(
    val routines: List<InboxRoutineDto> = emptyList(),
    val scheduler: InboxRoutineSchedulerDto = InboxRoutineSchedulerDto(),
)

@Serializable
data class InboxRoutineRunsResponse(val runs: List<InboxRoutineRunDto> = emptyList())

@Serializable
data class InboxRoutineRunNowResponse(
    @SerialName("run_id") val runId: String? = null,
    val outcome: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    val detail: JsonElement? = null,
) {
    val detailText: String?
        get() = (detail as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
}

// ── Members ─────────────────────────────────────────────────────────────────

@Serializable
data class InboxMemberDto(
    @SerialName("agent_id") val agentId: String,
    val alias: String = "",
    @SerialName("github_login") val githubLogin: String? = null,
    @SerialName("member_role") val memberRole: String = "member",
    val pending: Boolean = false,
)

@Serializable
data class InboxMembersResponse(val members: List<InboxMemberDto> = emptyList(), val restricted: Boolean = false)

// ── GitHub repo connect ─────────────────────────────────────────────────────

@Serializable
data class InboxGithubRepoDto(
    @SerialName("full_name") val fullName: String,
    @SerialName("private") val isPrivate: Boolean = false,
    val description: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
)

@Serializable
data class InboxGithubReposResponse(
    val available: Boolean = false,
    val repos: List<InboxGithubRepoDto> = emptyList(),
    val detail: String? = null,
)

@Serializable
data class InboxGithubBindingResponse(val repo: String? = null)
