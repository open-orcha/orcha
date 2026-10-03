package io.openorcha.mobile.ui.screens

/** Agent detail "Budget": month spend vs limit, hard-stop banner, one-time override. */

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentBudgetDto
import io.openorcha.mobile.data.getAgentBudget
import io.openorcha.mobile.data.setBudgetOverride
import io.openorcha.mobile.domain.AgentControlsUx
import io.openorcha.mobile.domain.AgentInsights
import io.openorcha.mobile.data.updateAgentBudget
import io.openorcha.mobile.domain.ConnectionErrorCopy
import io.openorcha.mobile.ui.AgentSliceStore
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val BUDGET_REFRESH_MS = 60_000L

/**
 * Self-loading (GET on mount + every 60s, web parity). Hidden entirely when the server
 * has no budgets (older stack) or the agent is human.
 */
@Composable
internal fun AgentBudgetSection(
    baseUrl: String,
    agentId: String,
    alias: String,
    actorId: String?,
    memberRole: String?,
    canEditLimits: Boolean = false,
) {
    val p = Orcha.palette
    val canEdit = canEditLimits && actorId != null && memberRole?.lowercase() != "viewer"
    var editOpen by remember { mutableStateOf(false) }
    val cached by AgentSliceStore.budgets.collectAsState()
    var budget by remember(agentId) { mutableStateOf(cached[agentId]) }
    var unsupported by remember(agentId) { mutableStateOf(false) }
    var overrideOpen by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var writeError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(baseUrl, agentId) {
        while (true) {
            runCatching { AgentSliceStore.api.getAgentBudget(baseUrl, agentId) }
                .onSuccess { budget = it; AgentSliceStore.put(agentId, it) }
                .onFailure { if (budget == null) unsupported = true }
            delay(BUDGET_REFRESH_MS)
        }
    }
    val b = budget ?: return

    LSection(
        "Budget",
        trailing = { Text("${AgentInsights.fmtPeriod(b.period)} · resets ${AgentInsights.fmtReset(b.resetsAt)}", style = ltype(LType.Meta), color = p.faint) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            if (b.paused) {
                Banner(
                    BannerKind.Danger,
                    AgentInsights.pausedTitle(b) + (b.reason?.let { "\n$it" } ?: ""),
                    action = if (actorId != null && AgentInsights.canGrantOverride(b, memberRole)) "Grant override" else null,
                    onAction = { writeError = null; overrideOpen = true },
                )
            }
            BudgetCard(b, alias, editable = canEdit)
            if (canEdit) {
                Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalAlignment = Alignment.CenterVertically) {
                    val hasLimit = b.limits.usd != null || b.limits.tokens != null
                    LButton(
                        if (hasLimit) "Edit limits" else "Set budget",
                        { writeError = null; editOpen = true },
                        kind = if (hasLimit) LButtonKind.Secondary else LButtonKind.Primary,
                        size = LSize.Small,
                        enabled = !busy,
                    )
                    if (b.override.active) {
                        LButton(
                            "Revoke override",
                            {
                                busy = true
                                writeError = null
                                scope.launch {
                                    runCatching {
                                        AgentSliceStore.api.updateAgentBudget(baseUrl, agentId, AgentControlsUx.overrideJson(actorId!!, grant = false))
                                    }
                                        .onSuccess { budget = it; AgentSliceStore.put(agentId, it) }
                                        .onFailure { err -> writeError = "Budget change failed — " + ConnectionErrorCopy.friendly(err) }
                                    busy = false
                                }
                            },
                            kind = LButtonKind.Ghost,
                            size = LSize.Small,
                            enabled = !busy,
                        )
                    }
                }
            }
            writeError?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
        }
    }

    if (editOpen && actorId != null) {
        BudgetLimitsDialog(
            alias = alias,
            budget = b,
            busy = busy,
            onDismiss = { editOpen = false },
        ) { usd, tokens ->
            busy = true
            scope.launch {
                runCatching { AgentSliceStore.api.updateAgentBudget(baseUrl, agentId, AgentControlsUx.budgetLimitsJson(actorId, usd, tokens)) }
                    .onSuccess { budget = it; AgentSliceStore.put(agentId, it); editOpen = false }
                    .onFailure { err ->
                        writeError = "Budget change failed — " + ConnectionErrorCopy.friendly(err)
                        editOpen = false
                    }
                busy = false
            }
        }
    }

    if (overrideOpen && actorId != null) {
        var note by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { if (!busy) overrideOpen = false },
            title = { Text("Grant a one-time override", style = ltype(LType.Headline), color = p.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    Text(
                        "Lets $alias start new runs for the rest of ${AgentInsights.fmtPeriod(b.period)} despite the limit. " +
                            "It ends on ${AgentInsights.fmtReset(b.resetsAt)} and is recorded in the audit log.",
                        style = ltype(LType.Body), color = p.text2,
                    )
                    OrchaField(note, { if (it.length <= 500) note = it }, label = "Reason (optional)")
                }
            },
            confirmButton = {
                LButton(
                    "Grant override",
                    {
                        busy = true
                        scope.launch {
                            runCatching { AgentSliceStore.api.setBudgetOverride(baseUrl, agentId, actorId, grant = true, note = note) }
                                .onSuccess { budget = it; AgentSliceStore.put(agentId, it); overrideOpen = false }
                                .onFailure { err ->
                                    writeError = "Budget change failed — " + ConnectionErrorCopy.friendly(err)
                                    overrideOpen = false
                                }
                            busy = false
                        }
                    },
                    kind = LButtonKind.Primary,
                    enabled = !busy,
                )
            },
            dismissButton = { LButton("Cancel", { overrideOpen = false }, kind = LButtonKind.Ghost, enabled = !busy) },
            containerColor = p.surface,
        )
    }
}

@Composable
private fun BudgetCard(b: AgentBudgetDto, alias: String, editable: Boolean = false) {
    val p = Orcha.palette
    val u = b.usage
    val hasLimit = b.limits.usd != null || b.limits.tokens != null
    val unknownSpend = AgentInsights.spendUnknown(u)
    LCard(padding = LSpace.l) {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
            if (!hasLimit) {
                Text("No monthly budget", style = ltype(LType.BodyEmph), color = p.text)
                val usage = if (u.runs > 0 || u.inFlightRuns > 0) {
                    "This month: " + (if (unknownSpend) "cost not metered" else AgentInsights.fmtUsd(u.spendUsd)) +
                        " · ${AgentInsights.fmtTok(u.tokens)} tokens."
                } else "No runs this month."
                Text("$alias can start runs without a spending limit. $usage", style = ltype(LType.Meta), color = p.muted)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    Text("Monthly spend", style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
                    AgentInsights.healthLabel(b)?.takeIf { !b.paused }?.let { label ->
                        LTag(label, tint = toneColor(if (b.state == "ok") AgentInsights.Tone.Ok else if (b.state == "warning") AgentInsights.Tone.Warn else AgentInsights.Tone.Over), dot = true)
                    }
                }
                val usd = b.limits.usd
                when {
                    usd == null -> Text(
                        "No dollar limit · " + if (unknownSpend) "cost not metered" else AgentInsights.fmtUsd(u.spendUsd) + " this month",
                        style = ltype(LType.Meta), color = p.muted,
                    )
                    unknownSpend -> Text("Not metered · limit ${AgentInsights.fmtUsd(usd)}", style = ltype(LType.Meta), color = p.muted)
                    else -> {
                        Text(
                            "${AgentInsights.fmtUsd(u.spendUsd)} of ${AgentInsights.fmtUsd(usd)} · ${AgentInsights.pctLabel(b.usdRatio)}",
                            style = ltype(LType.Meta), color = p.text2,
                        )
                        BudgetMeter(b.usdRatio, "Monthly spend against budget")
                    }
                }
                LDivider()
                Text("Token cap", style = ltype(LType.BodyEmph), color = p.text)
                val tok = b.limits.tokens
                if (tok == null) {
                    Text("No token cap · ${AgentInsights.fmtTok(u.tokens)} tokens this month", style = ltype(LType.Meta), color = p.muted)
                } else {
                    Text(
                        "${AgentInsights.fmtTok(u.tokens)} of ${AgentInsights.fmtTok(tok)} tokens · ${AgentInsights.pctLabel(b.tokenRatio)}",
                        style = ltype(LType.Meta), color = p.text2,
                    )
                    BudgetMeter(b.tokenRatio, "Monthly tokens against cap")
                }
            }
            if (u.unmeteredRuns > 0) {
                Text(
                    "${u.unmeteredRuns} ${if (u.unmeteredRuns == 1) "run" else "runs"} · ${AgentInsights.fmtTok(u.unmeteredTokens)} tokens not metered — not counted as \$0.",
                    style = ltype(LType.Meta), color = p.faint,
                )
            }
            if (b.override.active) {
                Text(
                    "One-time override active until ${AgentInsights.fmtReset(b.resetsAt)}" + (b.override.note?.let { " · “$it”" } ?: ""),
                    style = ltype(LType.Meta), color = p.text2,
                )
            }
            if (u.inFlightRuns > 0) {
                Text(
                    "${u.inFlightRuns} ${if (u.inFlightRuns == 1) "run" else "runs"} in progress — not stopped by the budget",
                    style = ltype(LType.Meta), color = p.faint,
                )
            }
            if (hasLimit && !editable) {
                Text("Human-only · read-only here", style = ltype(LType.Micro), color = p.faint)
            }
        }
    }
}

@Composable
private fun toneColor(t: AgentInsights.Tone) = when (t) {
    AgentInsights.Tone.Ok -> Orcha.palette.ok
    AgentInsights.Tone.Warn -> Orcha.palette.warn
    AgentInsights.Tone.Over -> Orcha.palette.danger
}

@Composable
private fun BudgetMeter(ratio: Double?, label: String) {
    val p = Orcha.palette
    val frac = AgentInsights.meterFraction(ratio)
    val shape = RoundedCornerShape(3.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .height(6.dp)
            .background(p.surface2, shape)
            .semantics {
                contentDescription = "$label, ${AgentInsights.pctLabel(ratio)} of limit"
                progressBarRangeInfo = ProgressBarRangeInfo(frac, 0f..1f)
            },
    ) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(frac).background(toneColor(AgentInsights.meterTone(ratio)), shape))
    }
}

/** Agents-tab chip: only when the server says the agent is paused by a budget. */
@Composable
internal fun BudgetPausedCapsule(modifier: Modifier = Modifier) {
    val p = Orcha.palette
    LTag("Budget paused", modifier = modifier, tint = p.danger, dot = true)
}

/** Set / edit the monthly limits. Blank = no limit (sent as an explicit null that clears it). */
@Composable
private fun BudgetLimitsDialog(
    alias: String,
    budget: AgentBudgetDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (AgentControlsUx.Limit, AgentControlsUx.Limit) -> Unit,
) {
    val p = Orcha.palette
    var usd by remember { mutableStateOf(AgentControlsUx.usdField(budget.limits.usd)) }
    var tokens by remember { mutableStateOf(budget.limits.tokens?.toString().orEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Budget", style = ltype(LType.Headline), color = p.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                OrchaField(
                    usd, { usd = it; error = null },
                    label = "Monthly limit (USD)", placeholder = "No limit",
                )
                OrchaField(
                    tokens, { tokens = it; error = null },
                    label = "Token cap", placeholder = "No cap",
                )
                Text(
                    "At 80% you get a Needs-you notice. At 100% $alias is paused for new runs; a run already in progress is not stopped. Leave a field blank for no limit.",
                    style = ltype(LType.Meta), color = p.muted,
                )
                error?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
            }
        },
        confirmButton = {
            LButton(
                "Save",
                {
                    val u = AgentControlsUx.parseLimit(usd, integer = false)
                    val t = AgentControlsUx.parseLimit(tokens, integer = true)
                    if (u == AgentControlsUx.Limit.Invalid || t == AgentControlsUx.Limit.Invalid) {
                        error = "Enter a positive number, or leave blank for no limit."
                    } else {
                        onSave(u, t)
                    }
                },
                kind = LButtonKind.Primary,
                enabled = !busy,
            )
        },
        dismissButton = { LButton("Cancel", onDismiss, kind = LButtonKind.Ghost, enabled = !busy) },
        containerColor = p.surface,
    )
}
