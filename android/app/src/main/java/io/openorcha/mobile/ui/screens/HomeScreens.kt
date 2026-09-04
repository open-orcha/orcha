package io.openorcha.mobile.ui.screens

/* Owns the saved-container home and its reachability summary cards. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
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
import io.openorcha.mobile.ui.theme.ThemeMode

/* =============================================================================
   Flow 04 — Containers home ("My Orchas"), Settings; Flow 03 — pairing entry.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContainersHomeScreen(
    state: OrchaUiState,
    onAdd: () -> Unit,
    onScan: () -> Unit,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
) {
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = { Text("Orcha", fontWeight = FontWeight.W800) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                actions = {
                    IconButton(onClick = onRefresh) { Icon(OrchaIcons.Refresh, "Refresh") }
                    IconButton(onClick = onSettings) { Icon(OrchaIcons.Settings, "Settings") }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onScan,
                containerColor = Orcha.palette.accent,
                contentColor = Orcha.palette.accentInk,
                icon = { Icon(OrchaIcons.QrCodeScanner, null) },
                text = { Text("Add", fontWeight = FontWeight.W700) },
            )
        },
    ) { padding ->
        if (state.containers.isEmpty()) {
            // H3 · first launch: one job — get the user to pairing.
            StateLayout(
                title = "Add your Orcha",
                sub = "Open your Orcha portal and choose Pair phone, then scan the QR here — or type the portal address, like orcha.yourteam.com. One pairing brings in every project on that Orcha.",
                modifier = Modifier.padding(padding),
                glyph = { BrandMark(44.dp) },
            ) {
                Spacer(Modifier.height(6.dp))
                PrimaryButton("Add your Orcha", onScan, leading = { Icon(OrchaIcons.QrCodeScanner, null, tint = Orcha.palette.accentInk) })
                TextButton(onClick = onAdd) { Text("Enter address manually", color = Orcha.palette.accent, fontWeight = FontWeight.W700) }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item { SectionH("My Orchas", "${state.containers.size}") }
                items(state.containers, key = { it.id }) { container ->
                    ContainerCard(
                        container = container,
                        health = state.containerHealth[container.id],
                        onOpen = onOpen,
                        onForget = onForget,
                        onRename = onRename,
                    )
                }
                item {
                    Text(
                        "Every project on a paired Orcha appears here automatically — tap one to switch into it. Long-press a card to rename or disconnect.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Orcha.palette.faint,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ContainerCard(
    container: StoredContainer,
    health: ContainerHealth?,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onRename: (String, String) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var confirmDisconnect by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf(container.displayName) }

    OrchaCard(onClick = { onOpen(container.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BrandMark()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(container.displayName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(container.baseUrl, style = MonoSmStyle, color = Orcha.palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            ConnChip(health?.state ?: "probing")
            IconButton(onClick = { menu = true }) {
                Icon(OrchaIcons.ChevronRight, null, tint = Orcha.palette.faint)
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Open") }, onClick = { menu = false; onOpen(container.id) })
                    DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; renaming = true })
                    DropdownMenuItem(text = { Text("Disconnect", color = Orcha.palette.danger) }, onClick = { menu = false; confirmDisconnect = true })
                }
            }
        }
        when {
            health == null || health.state == "probing" -> Text("Checking…", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.faint)
            health.state == "unreachable" -> Text(
                "Last seen a while ago — is this Orcha up?",
                style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted,
            )
            health.state == "signin" -> Text(
                "Signed out — Settings → Sign in again to reconnect.",
                style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.warn,
            )
            else -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // iOS ContainerCard parity: "N open" (non-terminal tasks), not the
                    // all-time task total.
                    Text("${health.agents} agents · ${health.tasks} open", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted)
                    Spacer(Modifier.weight(1f))
                    if (health.needsYou > 0) {
                        io.openorcha.mobile.ui.components.StatusPill("${health.needsYou} need you", io.openorcha.mobile.ui.components.StatusDomain.Agent)
                    }
                }
                // Bound GitHub repo (glance-only — connect/change lives in the workspace).
                health.githubRepo?.let { repo ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Icon(OrchaIcons.GitHub, contentDescription = null, tint = Orcha.palette.faint, modifier = Modifier.size(12.dp))
                        Text(repo, style = MonoSmStyle, color = Orcha.palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect ${container.displayName}?") },
            text = { Text("This removes the pairing — and every project sharing its address — from this phone only. The Orcha keeps running, and you can pair again anytime from the portal.") },
            confirmButton = {
                TextButton(onClick = { confirmDisconnect = false; onForget(container.id) }) {
                    Text("Disconnect", color = Orcha.palette.danger, fontWeight = FontWeight.W700)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel", color = Orcha.palette.accent) } },
            containerColor = Orcha.palette.raised,
        )
    }
    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename on this phone") },
            text = { OrchaField(newName, { newName = it }, label = "Display name") },
            confirmButton = {
                TextButton(onClick = { renaming = false; onRename(container.id, newName) }) {
                    Text("Rename", color = Orcha.palette.accent, fontWeight = FontWeight.W700)
                }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel", color = Orcha.palette.muted) } },
            containerColor = Orcha.palette.raised,
        )
    }
}

/* =============================================================================
   Flow 03 — pairing entry point (see ScannerScreen.kt / ManualConnectScreen.kt):
   scan is primary, manual address+token entry is the fallback. Both a local
   self-host address and a deployed cloud/remote portal address work equally —
   see ManualConnectScreen.kt for the address-neutral copy and self-host help.
   ============================================================================= */
