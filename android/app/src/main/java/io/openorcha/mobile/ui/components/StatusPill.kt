package io.openorcha.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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

enum class StatusDomain { Task, Request, Agent, Connection }

@Composable
fun StatusPill(
    label: String,
    domain: StatusDomain,
    modifier: Modifier = Modifier,
) {
    val color = statusColor(label, domain)
    Row(
        modifier = modifier
            .background(color.copy(alpha = 0.13f), RoundedCornerShape(999.dp))
            .width(128.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(color, CircleShape),
        )
        Text(
            text = label.replace('_', ' '),
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
            "completed" -> OrchaColors.Success
            "needs_verification" -> OrchaColors.Warning
            "blocked", "cancelled" -> OrchaColors.Danger
            "ready" -> OrchaColors.Info
            "in_progress" -> OrchaColors.Accent
            else -> OrchaColors.Muted
        }

        StatusDomain.Request -> when (normalized) {
            "open" -> OrchaColors.Warning
            "answered", "accepted" -> OrchaColors.Info
            "closed" -> OrchaColors.Success
            "rejected" -> OrchaColors.Danger
            else -> OrchaColors.Muted
        }

        StatusDomain.Agent -> when (normalized) {
            "working", "ephemeral", "resident" -> OrchaColors.Accent
            "idle" -> OrchaColors.Success
            "blocked" -> OrchaColors.Warning
            else -> OrchaColors.Muted
        }

        StatusDomain.Connection -> when (normalized) {
            "live", "active" -> OrchaColors.Success
            "polling" -> OrchaColors.Warning
            "unreachable" -> OrchaColors.Danger
            else -> OrchaColors.Muted
        }
    }
}

