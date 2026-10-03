package io.openorcha.mobile.data

/**
 * Task-detail parity DTOs (web portal PR #270): proof-of-work evidence pack, Verdikt runs,
 * goal ancestry, the AI manager pre-review, routines ("Make recurring…"), reassign and the
 * reviewer picker. Mirrors `portal_backend/evidence_routes.py`, `verdikt_integration.run_public`,
 * `goal_ancestry*.py`, `routine_routes.py` and the web `evidenceTypes.ts` / `goalApi.ts` /
 * `routinesApi.ts`. Every field defaults so an older server (missing keys) still decodes.
 */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/* ---------- evidence pack: GET /api/tasks/{tid}/evidence ---------- */

@Serializable
data class EvidencePackDto(
    @SerialName("task_id") val taskId: String = "",
    @SerialName("task_status") val taskStatus: String? = null,
    @SerialName("built_at") val builtAt: String? = null,
    @SerialName("round_started_at") val roundStartedAt: String? = null,
    val runs: List<EvidenceRunRef> = emptyList(),
    val tests: EvidenceTests = EvidenceTests(),
    val changes: EvidenceChanges = EvidenceChanges(),
    val flags: List<EvidenceRiskFlag> = emptyList(),
    val branch: String? = null,
    @SerialName("pr_urls") val prUrls: List<String> = emptyList(),
    val links: List<EvidenceLink> = emptyList(),
    val claim: EvidenceClaim? = null,
    val dod: EvidenceDod = EvidenceDod(),
    val verdikt: VerdiktRunDto? = null,
    val summary: EvidenceSummaryDto = EvidenceSummaryDto(),
)

@Serializable
data class EvidenceRunRef(
    @SerialName("run_id") val runId: String = "",
    @SerialName("agent_alias") val agentAlias: String? = null,
    val status: String? = null,
)

@Serializable
data class EvidenceTestCounts(
    val passed: Int = 0,
    val failed: Int = 0,
    val skipped: Int = 0,
    val errors: Int = 0,
    val total: Int = 0,
    val unit: String = "tests",
)

@Serializable
data class EvidenceTestInvocation(
    val framework: String = "",
    val command: String = "",
    @SerialName("exit_code") val exitCode: Int? = null,
    val counts: EvidenceTestCounts? = null,
    /** passed | failed | no_tests | exit_ok | exit_failed | unknown */
    val outcome: String = "unknown",
)

@Serializable
data class EvidenceTests(
    /** none | passed | failed | exit_ok | unverified */
    val status: String = "none",
    val passed: Int = 0,
    val failed: Int = 0,
    val skipped: Int = 0,
    val errors: Int = 0,
    val suites: Int = 0,
    val latest: List<EvidenceTestInvocation> = emptyList(),
    val earlier: Int = 0,
)

@Serializable
data class EvidenceRiskFlag(
    val kind: String = "",
    val label: String = "",
    val detail: String = "",
    /** warn | danger */
    val severity: String = "warn",
    val files: List<String> = emptyList(),
    val count: Int = 0,
)

@Serializable
data class EvidenceChangedFile(
    val path: String = "",
    val status: String? = null,
    val additions: Int? = null,
    val deletions: Int? = null,
)

@Serializable
data class EvidenceChanges(
    val files: Int = 0,
    val additions: Int = 0,
    val deletions: Int = 0,
    val summary: String = "",
    val list: List<EvidenceChangedFile> = emptyList(),
    @SerialName("truncated_list") val truncatedList: Boolean = false,
)

@Serializable
data class EvidenceLink(
    val kind: String = "",
    val label: String = "",
    val href: String = "",
)

@Serializable
data class EvidenceClaim(val text: String = "", val truncated: Boolean = false)

@Serializable
data class EvidenceDodItem(
    val index: Int = 0,
    val text: String = "",
    /** proven | not_proven | needs_human */
    val status: String = "needs_human",
    val basis: String = "none",
    val evidence: String? = null,
    val claim: String? = null,
)

@Serializable
data class EvidenceDod(
    val items: List<EvidenceDodItem> = emptyList(),
    val total: Int = 0,
    val proven: Int = 0,
    @SerialName("not_proven") val notProven: Int = 0,
    @SerialName("needs_human") val needsHuman: Int = 0,
)

@Serializable
data class EvidenceSummaryDod(
    val total: Int = 0,
    val proven: Int = 0,
    @SerialName("not_proven") val notProven: Int = 0,
    @SerialName("needs_human") val needsHuman: Int = 0,
)

@Serializable
data class EvidenceSummaryTests(
    val status: String = "none",
    val passed: Int = 0,
    val failed: Int = 0,
    val skipped: Int = 0,
    val errors: Int = 0,
)

@Serializable
data class EvidenceSummaryVerdikt(val status: String = "", val verdict: String? = null)

@Serializable
data class EvidenceAutofixSummary(
    val status: String = "stopped",
    @SerialName("attempts_made") val attemptsMade: Int = 0,
    @SerialName("max_attempts") val maxAttempts: Int = 0,
    @SerialName("current_attempt") val currentAttempt: Int = 0,
    @SerialName("stop_kind") val stopKind: String? = null,
    @SerialName("stop_label") val stopLabel: String? = null,
    @SerialName("stop_reason") val stopReason: String? = null,
)

@Serializable
data class EvidenceSummaryDto(
    val dod: EvidenceSummaryDod? = null,
    val tests: EvidenceSummaryTests? = null,
    @SerialName("risk_flags") val riskFlags: Int = 0,
    val verdikt: EvidenceSummaryVerdikt? = null,
    val line: String = "",
    val autofix: EvidenceAutofixSummary? = null,
)

/* ---------- Verdikt: GET/POST /api/tasks/{tid}/verdikt/runs ---------- */

@Serializable
data class VerdiktCriterionDto(
    @SerialName("dod_index") val dodIndex: Int = 0,
    val text: String = "",
    val outcome: String? = null,
    val expected: String? = null,
    val actual: String? = null,
)

@Serializable
data class VerdiktRunDto(
    val id: String = "",
    /** manual | auto */
    val trigger: String = "manual",
    /** queued | running | completed | failed | cancelled | timeout | unavailable */
    val status: String = "",
    /** pass | fail | blocked | warning | unprocessable | running | null */
    val verdict: String? = null,
    val reason: String? = null,
    @SerialName("target_kind") val targetKind: String? = null,
    val locator: String? = null,
    val criteria: List<VerdiktCriterionDto> = emptyList(),
    /** Portal-relative redirect to the Verdikt report. */
    @SerialName("report_url") val reportUrl: String? = null,
    val error: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
    @SerialName("previous_round") val previousRound: Boolean = false,
)

@Serializable
data class VerdiktSettingsDto(
    val configured: Boolean = false,
    val enabled: Boolean = false,
    @SerialName("base_url") val baseUrl: String? = null,
    @SerialName("target_kind") val targetKind: String = "web",
    @SerialName("target_locator") val targetLocator: String? = null,
)

@Serializable
data class VerdiktRunsResponse(
    val settings: VerdiktSettingsDto? = null,
    val runs: List<VerdiktRunDto> = emptyList(),
)

@Serializable
data class VerdiktTriggerBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    val locator: String? = null,
)

/* ---------- goal ancestry: GET /api/tasks/{tid}/goal-chain ---------- */

@Serializable
data class GoalNodeDto(
    /** objective | parent | task */
    val kind: String = "task",
    val id: String? = null,
    val title: String = "",
    val text: String? = null,
    val status: String? = null,
    /** parent only: parent_link | task_request */
    val via: String? = null,
)

@Serializable
data class GoalChainDto(
    @SerialName("task_id") val taskId: String = "",
    @SerialName("goal_chain") val goalChain: List<GoalNodeDto> = emptyList(),
    val truncated: Boolean = false,
    val cycle: Boolean = false,
)

/* ---------- AI manager pre-review + review routing (task fields on the snapshot) ---------- */

@Serializable
data class ManagerReviewDto(
    /** pending | approved | sent_back | commented | superseded | overridden */
    val status: String = "",
    @SerialName("manager_agent_id") val managerAgentId: String? = null,
    @SerialName("manager_alias") val managerAlias: String? = null,
    val recommendation: String? = null,
    val reasons: String? = null,
    @SerialName("requested_at") val requestedAt: String? = null,
    @SerialName("decided_at") val decidedAt: String? = null,
)

@Serializable
data class ReviewRoutingDto(
    /** reports_to | owner | fallback | … */
    @SerialName("routed_via") val routedVia: String? = null,
    @SerialName("manager_depth") val managerDepth: Int? = null,
    @SerialName("assignee_alias") val assigneeAlias: String? = null,
    @SerialName("reviewer_alias") val reviewerAlias: String? = null,
    @SerialName("set_by_alias") val setByAlias: String? = null,
)

@Serializable
data class TaskReviewerBody(
    @SerialName("reviewer_agent_id") val reviewerAgentId: String?,
    @SerialName("actor_agent_id") val actorAgentId: String,
)

/* ---------- routines: POST /api/containers/{cid}/routines (+ /preview) ---------- */

@Serializable
data class RoutineCreateBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    val title: String,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String,
    @SerialName("assignee_agent_id") val assigneeAgentId: String? = null,
    // no Kotlin defaults: the client omits default-valued fields, and these must always be sent
    val priority: Int,
    val cron: String,
    val timezone: String,
    val enabled: Boolean,
    @SerialName("skip_if_open") val skipIfOpen: Boolean,
    @SerialName("origin_task_id") val originTaskId: String? = null,
)

@Serializable
data class RoutineDto(
    val id: String = "",
    val title: String = "",
    val cron: String = "",
    val timezone: String = "UTC",
    @SerialName("schedule_text") val scheduleText: String = "",
    val enabled: Boolean = true,
    @SerialName("next_run_at") val nextRunAt: String? = null,
    @SerialName("origin_task_id") val originTaskId: String? = null,
)

@Serializable
data class RoutineListResponse(val routines: List<RoutineDto> = emptyList())

@Serializable
data class SchedulePreviewBody(val cron: String, val timezone: String, val count: Int = 3)

@Serializable
data class SchedulePreviewDto(
    val valid: Boolean = false,
    val error: String? = null,
    @SerialName("schedule_text") val scheduleText: String? = null,
    @SerialName("next_runs") val nextRuns: List<String> = emptyList(),
)
