package io.openorcha.mobile.ui.screens

/* Owns mobile appearance settings and saved-container management. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.ui.ContainerHealth
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.BrandMark
import io.openorcha.mobile.ui.components.ConnChip
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.SegControl
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.SkinMode
import io.openorcha.mobile.ui.theme.ThemeMode

/* =============================================================================
   Flow 04 — Containers home ("My Orchas"), Settings; Flow 03 — pairing entry.
   ============================================================================= */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onTheme: (ThemeMode) -> Unit,
    onSkin: (SkinMode) -> Unit,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onAdd: () -> Unit,
    onSetRemoteUrl: (String, String?) -> Unit = { _, _ -> },
    // Device-token auth (cloud unification):
    onSetAccessToken: (String, String?) -> Unit = { _, _ -> },
    onSignInAgain: (String) -> Unit = {},
) {
    // LAN↔remote failover (iOS Settings §6 "Add remote…"): which container's dialog is open.
    var remoteDialogFor by remember { mutableStateOf<StoredContainer?>(null) }
    // Device-token auth: which container's manual token-update dialog is open.
    var tokenDialogFor by remember { mutableStateOf<StoredContainer?>(null) }
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { SectionH("Appearance") }
            item {
                OrchaCard {
                    SegControl(
                        options = listOf("Auto", "Light", "Dark"),
                        selected = state.themeMode.ordinal,
                        onSelect = { onTheme(ThemeMode.entries[it]) },
                    )
                    Text("Auto follows the system setting. Changes apply instantly.", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted)
                }
            }
            item { SectionH("Design") }
            item {
                OrchaCard {
                    SegControl(
                        options = SkinMode.entries.map { it.label },
                        selected = state.skinMode.ordinal,
                        onSelect = { onSkin(SkinMode.entries[it]) },
                    )
                    Text(state.skinMode.blurb, style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted)
                }
            }
            item { SectionH("Containers", "${state.containers.size}") }
            items(state.containers, key = { it.id }) { c ->
                // iOS containersSection parity: three stacked rows (identity+Disconnect /
                // token / remote) — four TextButtons on one row squeezed the weighted
                // text column to zero width, ballooning the card with wrapped text.
                OrchaCard(onClick = { onOpen(c.id) }) {
                    val hasToken = !c.accessToken.isNullOrBlank()
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(c.displayName, human = false)
                        Column(Modifier.weight(1f)) {
                            Text(c.displayName, style = MaterialTheme.typography.titleSmall)
                            Text(c.baseUrl, style = MonoSmStyle, color = Orcha.palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        TextButton(onClick = { onForget(c.id) }) { Text("Disconnect", color = Orcha.palette.danger) }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(
                            OrchaIcons.Key, null, modifier = Modifier.size(16.dp),
                            tint = if (hasToken) Orcha.palette.accent else Orcha.palette.faint,
                        )
                        Text(
                            if (hasToken) "Access token set" else "No access token",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (hasToken) Orcha.palette.text2 else Orcha.palette.faint,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { tokenDialogFor = c }) {
                            Text(if (hasToken) "Update token…" else "Add token…", color = Orcha.palette.accent)
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(
                            OrchaIcons.Public, null, modifier = Modifier.size(16.dp),
                            tint = if (c.remoteBaseUrl.isNullOrBlank()) Orcha.palette.faint else Orcha.palette.accent,
                        )
                        if (!c.remoteBaseUrl.isNullOrBlank()) {
                            Text(
                                c.remoteBaseUrl.orEmpty(), style = MonoSmStyle, color = Orcha.palette.text2,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                            )
                        } else {
                            Text(
                                "No second address", style = MaterialTheme.typography.bodySmall,
                                color = Orcha.palette.faint, modifier = Modifier.weight(1f),
                            )
                        }
                        TextButton(onClick = { remoteDialogFor = c }) {
                            Text(if (c.remoteBaseUrl.isNullOrBlank()) "Add remote…" else "Edit remote…", color = Orcha.palette.accent)
                        }
                    }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
            item { NeutralButton("Add container", onAdd, modifier = Modifier.fillMaxWidth()) }
            item { SectionH("About") }
            item {
                OrchaCard {
                    io.openorcha.mobile.ui.components.KVRow("Version", "0.1.0 (design-spec build)")
                    io.openorcha.mobile.ui.components.KVRow("Project", "github.com/open-orcha/orcha", mono = true)
                    MetaTag("GH #30 · mobile companion")
                }
            }
        }
    }
    remoteDialogFor?.let { c ->
        AddRemoteDialog(
            container = c,
            onDismiss = { remoteDialogFor = null },
            onSave = { url -> onSetRemoteUrl(c.id, url); remoteDialogFor = null },
        )
    }
    tokenDialogFor?.let { c ->
        AccessTokenDialog(
            container = c,
            onDismiss = { tokenDialogFor = null },
            onSave = { token -> onSetAccessToken(c.id, token); tokenDialogFor = null },
        )
    }
}

/**
 * LAN↔remote failover (iOS §6 "Add remote…" alert parity): set/clear the container's
 * second address. Validated via `OrchaServerAddress.normalize` — blank clears it.
 */
@Composable
private fun AddRemoteDialog(container: StoredContainer, onDismiss: () -> Unit, onSave: (String?) -> Unit) {
    val p = Orcha.palette
    var text by remember { mutableStateOf(container.remoteBaseUrl.orEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Remote address") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "A second address for ${container.displayName} (e.g. a Tailscale name) — the app fails over to it when the local address doesn't answer, and swaps back once it's reachable again. Leave blank to remove it.",
                    style = MaterialTheme.typography.bodyMedium, color = p.muted,
                )
                io.openorcha.mobile.ui.components.OrchaField(
                    text, { text = it; error = null },
                    label = "Remote address",
                    placeholder = "100.x.x.x:8001",
                )
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val trimmed = text.trim()
                if (trimmed.isBlank()) {
                    onSave(null)
                    return@TextButton
                }
                runCatching { io.openorcha.mobile.data.OrchaServerAddress.normalize(trimmed) }
                    .onSuccess { onSave(it) }
                    .onFailure { error = it.message ?: "That doesn't look like an address." }
            }) { Text("Save", color = p.accent, fontWeight = FontWeight.W700) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = p.muted) } },
        containerColor = p.raised,
    )
}

/**
 * Device-token auth: Settings "Update token…" -- mirrors [AddRemoteDialog]'s
 * pattern. Set (or clear, blank) one already-paired container's stored bearer
 * token directly, without a fresh probe.
 */
@Composable
private fun AccessTokenDialog(container: StoredContainer, onDismiss: () -> Unit, onSave: (String?) -> Unit) {
    val p = Orcha.palette
    var text by remember { mutableStateOf(container.accessToken.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Access token") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "The device/team token ${container.displayName} uses to get past its sign-in. \"Sign in again\" does this for you via GitHub — paste one here only for the advanced/manual path. Leave blank to remove it.",
                    style = MaterialTheme.typography.bodyMedium, color = p.muted,
                )
                io.openorcha.mobile.ui.components.OrchaField(
                    text, { text = it },
                    label = "Access token",
                    masked = true,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text.trim().ifBlank { null }) }) {
                Text("Save", color = p.accent, fontWeight = FontWeight.W700)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = p.muted) } },
        containerColor = p.raised,
    )
}
