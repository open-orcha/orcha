package io.openorcha.mobile.data

/* Project slice DTOs: objective, agent limit, budgets, metrics (performance), agent
   worktrees, routine schedule preview and members-with-grants. Every field defaults so a
   missing key never breaks decoding (the shared reader ignores unknown keys). */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ProjectObjectiveResponse(
    @SerialName("container_id") val containerId: String = "",
    val objective: String? = null,
)

@Serializable
data class ProjectLimitsResponse(
    @SerialName("container_id") val containerId: String = "",
    @SerialName("max_auto_agents") val maxAutoAgents: Int = 12,
    @SerialName("auto_agents_in_use") val autoAgentsInUse: Int = 0,
    @SerialName("min_max_auto_agents") val minMaxAutoAgents: Int = 1,
    @SerialName("max_max_auto_agents") val maxMaxAutoAgents: Int = 50,
)

// ── budgets ──

@Serializable
data class BudgetLimitsDto(val usd: Double? = null, val tokens: Long? = null)

@Serializable
data class BudgetUsageDto(
    @SerialName("spend_usd") val spendUsd: Double = 0.0,
    val tokens: Long = 0,
    val runs: Int = 0,
    @SerialName("unmetered_runs") val unmeteredRuns: Int = 0,
)

@Serializable
data class BudgetOverrideDto(val active: Boolean = false, val note: String? = null)

@Serializable
data class BudgetStatusDto(
    val limits: BudgetLimitsDto = BudgetLimitsDto(),
    val usage: BudgetUsageDto = BudgetUsageDto(),
    val state: String = "none",
    @SerialName("usd_ratio") val usdRatio: Double? = null,
    @SerialName("token_ratio") val tokenRatio: Double? = null,
    val paused: Boolean = false,
    val override: BudgetOverrideDto = BudgetOverrideDto(),
    @SerialName("agent_id") val agentId: String? = null,
    val alias: String? = null,
)

@Serializable
data class ProjectBudgetsResponse(
    val period: String = "",
    @SerialName("resets_at") val resetsAt: String? = null,
    val project: BudgetStatusDto = BudgetStatusDto(),
    val agents: List<BudgetStatusDto> = emptyList(),
)

// ── metrics / performance ──

@Serializable
data class PerfRateDto(val value: Double? = null, val numerator: Int = 0, val denominator: Int = 0, val enough: Boolean = false)

@Serializable
data class PerfMedianDto(val value: Double? = null, val n: Int = 0, val enough: Boolean = false)

@Serializable
data class PerfCostDto(
    val value: Double? = null,
    @SerialName("metered_tasks") val meteredTasks: Int = 0,
    @SerialName("unmetered_tasks") val unmeteredTasks: Int = 0,
    val enough: Boolean = false,
)

@Serializable
data class PerfReworkDto(
    val total: Int = 0,
    @SerialName("human_rejections") val humanRejections: Int = 0,
    @SerialName("manager_send_backs") val managerSendBacks: Int = 0,
)

@Serializable
data class PerfMetricsDto(
    @SerialName("tasks_verified") val tasksVerified: Int = 0,
    @SerialName("first_pass_rate") val firstPassRate: PerfRateDto = PerfRateDto(),
    val rework: PerfReworkDto = PerfReworkDto(),
    @SerialName("median_time_to_verified_seconds") val medianTimeToVerified: PerfMedianDto = PerfMedianDto(),
    @SerialName("cost_per_verified_task_usd") val costPerVerified: PerfCostDto = PerfCostDto(),
    @SerialName("plan_approval_rate") val planApprovalRate: PerfRateDto = PerfRateDto(),
    val escalations: Int = 0,
)

@Serializable
data class PerfBucketDto(val start: String = "", val end: String = "", val verified: Int = 0, val rework: Int = 0)

@Serializable
data class PerfRowDto(
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("container_id") val containerId: String? = null,
    val alias: String? = null,
    val name: String? = null,
    val model: String? = null,
    val role: String? = null,
    val retired: Boolean = false,
    val metrics: PerfMetricsDto = PerfMetricsDto(),
    val series: List<PerfBucketDto> = emptyList(),
)

@Serializable
data class PerformanceResponse(
    val range: String = "7d",
    @SerialName("bucket_days") val bucketDays: Int = 1,
    @SerialName("min_sample") val minSample: Int = 3,
    val project: PerfRowDto = PerfRowDto(),
    val agents: List<PerfRowDto> = emptyList(),
)

@Serializable
data class AgentPerformanceResponse(
    val range: String = "7d",
    val agent: PerfRowDto = PerfRowDto(),
)

// ── agent worktrees ──

@Serializable
data class WorktreeSettingsDto(
    @SerialName("auto_cleanup") val autoCleanup: Boolean = true,
    @SerialName("grace_days") val graceDays: Int = 7,
)

@Serializable
data class WorktreeInventoryDto(
    val host: String? = null,
    @SerialName("scanned_at") val scannedAt: String? = null,
    val counts: Map<String, Int> = emptyMap(),
    @SerialName("reclaimable_bytes") val reclaimableBytes: Long = 0,
    @SerialName("total_bytes") val totalBytes: Long = 0,
)

@Serializable
data class AgentWorktreesResponse(
    val settings: WorktreeSettingsDto = WorktreeSettingsDto(),
    val inventory: WorktreeInventoryDto? = null,
)

// ── routines (create / edit) ──

@Serializable
data class SchedulePreviewResponse(
    val valid: Boolean = false,
    val error: String? = null,
    @SerialName("schedule_text") val scheduleText: String? = null,
    @SerialName("next_runs") val nextRuns: List<String> = emptyList(),
)

/** GET /api/routines/{rid} — the fields the editor needs that the list row lacks. */
@Serializable
data class RoutineDetailDto(
    val id: String,
    val title: String = "",
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String = "",
    @SerialName("assignee_agent_id") val assigneeAgentId: String? = null,
    @SerialName("assignee_alias") val assigneeAlias: String? = null,
    val priority: Int = 100,
    val cron: String = "",
    val timezone: String = "UTC",
    val enabled: Boolean = true,
    @SerialName("skip_if_open") val skipIfOpen: Boolean = true,
)

// ── members with grants (authority) ──

@Serializable
data class ProjectMemberDto(
    @SerialName("agent_id") val agentId: String,
    @SerialName("member_role") val memberRole: String = "member",
    val grants: List<String> = emptyList(),
)

@Serializable
data class ProjectMembersResponse(val members: List<ProjectMemberDto> = emptyList(), val restricted: Boolean = false)
