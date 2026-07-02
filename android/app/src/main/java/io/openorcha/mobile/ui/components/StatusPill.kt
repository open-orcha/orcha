package io.openorcha.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.theme.OrchaColors

enum class StatusDomain { Task, Request, Agent, Connection, Run }

@Composable
fun StatusPill(
    label: String,
    domain: StatusDomain,
    modifier: Modifier = Modifier,
) {
    val color = statusColor(label, domain)
    val copy = statusCopy(label)
    Row(
        modifier = modifier
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(999.dp))
            .border(BorderStroke(1.dp, color.copy(alpha = 0.32f)), RoundedCornerShape(999.dp))
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .background(color, CircleShape),
        )
        Text(
            text = copy,
            color = color,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

fun statusColor(status: String, domain: StatusDomain): Color {
    val normalized = status.lowercase()
    return when (domain) {
        StatusDomain.Task -> when (normalized) {
            "completed" -> OrchaColors.Ok
            "needs_verification" -> OrchaColors.Violet
            "blocked" -> OrchaColors.Warn
            "cancelled" -> OrchaColors.Danger
            "ready" -> OrchaColors.Info
            "in_progress" -> OrchaColors.Accent
            else -> OrchaColors.Idle
        }

        StatusDomain.Request -> when (normalized) {
            "open" -> OrchaColors.Info
            "accepted" -> OrchaColors.Accent
            "answered", "converted_to_task" -> OrchaColors.Violet
            "closed" -> OrchaColors.Idle
            "rejected" -> OrchaColors.Danger
            else -> OrchaColors.Idle
        }

        StatusDomain.Agent -> when (normalized) {
            "working", "ephemeral", "resident" -> OrchaColors.Accent
            "blocked" -> OrchaColors.Warn
            "awaiting_request" -> OrchaColors.Info
            "awaiting_human" -> OrchaColors.Violet
            "terminated" -> OrchaColors.Danger
            else -> OrchaColors.Idle
        }

        StatusDomain.Connection -> when (normalized) {
            "live", "active" -> OrchaColors.Ok
            "polling" -> OrchaColors.Warn
            "unreachable", "failed" -> OrchaColors.Danger
            else -> OrchaColors.Idle
        }

        StatusDomain.Run -> when (normalized) {
            "running" -> OrchaColors.Accent
            "exited", "finished" -> OrchaColors.Ok
            "killed", "failed", "error" -> OrchaColors.Danger
            else -> OrchaColors.Idle
        }
    }
}

fun statusCopy(status: String): String = when (status) {
    "needs_verification" -> "needs verification"
    "converted_to_task" -> "became a task"
    "awaiting_request" -> "waiting"
    "awaiting_human" -> "needs human"
    "in_progress" -> "in progress"
    else -> status.replace('_', ' ')
}
