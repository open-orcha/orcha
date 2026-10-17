package io.openorcha.mobile.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Agent slice DTOs: monthly budgets (budget_routes.py), the org chart's reporting line
 * (org_chart_routes.py) and a run's live changes (run_changes_routes.py). Every field
 * has a default so an older server (missing keys) degrades instead of failing to decode.
 */

// ---------- budgets: GET/PUT /api/agents/{aid}/budget, GET /api/containers/{cid}/budgets ----------

@Serializable
data class BudgetLimits(
    val usd: Double? = null,
    val tokens: Long? = null,
)

@Serializable
data class BudgetUsage(
    @SerialName("spend_usd") val spendUsd: Double = 0.0,
    @SerialName("metered_runs") val meteredRuns: Int = 0,
    @SerialName("unmetered_runs") val unmeteredRuns: Int = 0,
    @SerialName("unmetered_tokens") val unmeteredTokens: Long = 0,
    val tokens: Long = 0,
    val runs: Int = 0,
    @SerialName("in_flight_runs") val inFlightRuns: Int = 0,
)

@Serializable
data class BudgetOverride(
    val active: Boolean = false,
    val note: String? = null,
)

/** One agent's budget status (the `/budget` response, or one row of `/budgets`). */
@Serializable
data class AgentBudgetDto(
    val period: String? = null,
    @SerialName("resets_at") val resetsAt: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    val alias: String? = null,
    val limits: BudgetLimits = BudgetLimits(),
    val usage: BudgetUsage = BudgetUsage(),
    /** none | ok | warning | exceeded */
    val state: String = "none",
    @SerialName("usd_ratio") val usdRatio: Double? = null,
    @SerialName("token_ratio") val tokenRatio: Double? = null,
    val paused: Boolean = false,
    /** agent | project | null — which budget is holding the agent. */
    @SerialName("blocked_by") val blockedBy: String? = null,
    val reason: String? = null,
    val override: BudgetOverride = BudgetOverride(),
)

@Serializable
data class ContainerBudgetsDto(
    val period: String? = null,
    @SerialName("resets_at") val resetsAt: String? = null,
    val agents: List<AgentBudgetDto> = emptyList(),
)

/** PUT body for the one-time override only: limits are left OUT so the server keeps them. */
@Serializable
data class BudgetOverrideBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    /** grant | revoke */
    val override: String,
    val note: String? = null,
)

// ---------- org chart: GET /api/agents/{aid}/reports-to ----------

@Serializable
data class ChainMemberDto(
    val id: String,
    val alias: String = "",
    val kind: String = "ai",
    @SerialName("member_role") val memberRole: String? = null,
    val terminated: Boolean = false,
)

@Serializable
data class ReportsToDto(
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("reports_to_agent_id") val reportsToAgentId: String? = null,
    @SerialName("reports_to_alias") val reportsToAlias: String? = null,
    /** Chain of command, nearest manager first. */
    val chain: List<ChainMemberDto> = emptyList(),
)

// ---------- live changes: GET /api/agents/{aid}/runs/{rid}/changes[/diff] ----------

@Serializable
data class RunChangedFileDto(
    val path: String,
    /** M | A | D | R | ?? */
    val status: String = "M",
    val additions: Int = 0,
    val deletions: Int = 0,
    @SerialName("orig_path") val origPath: String? = null,
    val binary: Boolean = false,
)

@Serializable
data class RunChangesSummaryDto(
    val files: Int = 0,
    val additions: Int = 0,
    val deletions: Int = 0,
)

@Serializable
data class RunChangesDto(
    /** `?since=` matched: nothing changed, keep the current list. */
    val unchanged: Boolean = false,
    val available: Boolean = true,
    val reason: String? = null,
    val detail: String? = null,
    val running: Boolean = false,
    @SerialName("run_status") val runStatus: String? = null,
    /** live | captured */
    val source: String? = null,
    val branch: String? = null,
    val files: List<RunChangedFileDto> = emptyList(),
    val summary: RunChangesSummaryDto = RunChangesSummaryDto(),
    val truncated: Boolean = false,
    val version: String? = null,
)

@Serializable
data class RunChangeDiffDto(
    val available: Boolean = true,
    val path: String? = null,
    val diff: String = "",
    val binary: Boolean = false,
    val truncated: Boolean = false,
    val reason: String? = null,
    val detail: String? = null,
)

// ---------- chat live reply: GET /api/agents/{aid}/runs (the fields the chat needs) ----------

@Serializable
data class ChatRunDto(
    @SerialName("run_id") val runId: String,
    val status: String = "unknown",
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("wake_event") val wakeEvent: String? = null,
    val lane: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
) {
    /** Web `ofThisConv`: a run answers this conversation by id, else by its lane / wake event. */
    fun answers(convId: String?): Boolean =
        if (conversationId != null) convId != null && conversationId == convId
        else lane == "conversation" || wakeEvent == "conversation_turn"
}

@Serializable
data class ChatRunsResponse(val runs: List<ChatRunDto> = emptyList())

// ---------- config history: GET /api/agents/{aid}/config-revisions[/{rev}], POST …/restore ----------

/** One field a revision touched. Values are string | number | null on the wire. */
@Serializable
data class ConfigFieldChangeDto(
    val field: String,
    val before: kotlinx.serialization.json.JsonElement? = null,
    val after: kotlinx.serialization.json.JsonElement? = null,
    val derived: Boolean = false,
)

@Serializable
data class ConfigRevisionActorDto(
    @SerialName("agent_id") val agentId: String? = null,
    val alias: String? = null,
    val kind: String? = null,
)

@Serializable
data class ConfigRevisionDto(
    @SerialName("revision_no") val revisionNo: Int,
    /** initial | change | restore */
    val kind: String = "change",
    val changes: List<ConfigFieldChangeDto> = emptyList(),
    val actor: ConfigRevisionActorDto? = null,
    @SerialName("restored_from") val restoredFrom: Int? = null,
    val reason: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class ConfigRevisionPageDto(
    @SerialName("latest_revision_no") val latestRevisionNo: Int? = null,
    val total: Int = 0,
    val revisions: List<ConfigRevisionDto> = emptyList(),
    @SerialName("next_before") val nextBefore: Int? = null,
)

@Serializable
data class ConfigRestorePreviewDto(
    val field: String,
    val current: kotlinx.serialization.json.JsonElement? = null,
    val target: kotlinx.serialization.json.JsonElement? = null,
    val grant: String? = null,
)

@Serializable
data class ConfigRestoreBlockedDto(val field: String, val reason: String = "")

/** The revision plus what restoring it would change (or why it can't). */
@Serializable
data class ConfigRevisionDetailDto(
    @SerialName("revision_no") val revisionNo: Int,
    @SerialName("restore_preview") val restorePreview: List<ConfigRestorePreviewDto> = emptyList(),
    @SerialName("restore_blocked") val restoreBlocked: List<ConfigRestoreBlockedDto> = emptyList(),
)

@Serializable
data class ConfigRestoreResultDto(
    @SerialName("restored_from") val restoredFrom: Int? = null,
    val applied: List<String> = emptyList(),
)

@Serializable
data class ConfigRestoreBody(
    @SerialName("actor_agent_id") val actorAgentId: String,
    val reason: String? = null,
)

// ---------- org lines: the snapshot's per-agent `reports_to` ----------

@Serializable
data class OrgRowDto(
    val id: String,
    @SerialName("reports_to") val reportsTo: String? = null,
)

@Serializable
data class OrgSnapshotDto(val agents: List<OrgRowDto> = emptyList())

// ---------- acting identity: GET /api/me?cid= (role + grants gate the controls) ----------

@Serializable
data class ActingIdentityDto(
    @SerialName("agent_id") val agentId: String? = null,
    val alias: String = "",
    @SerialName("member_role") val memberRole: String = "member",
    val grants: List<String> = emptyList(),
)

@Serializable
data class MeDto(
    val identity: ActingIdentityDto? = null,
    val trusted: Boolean = false,
)
