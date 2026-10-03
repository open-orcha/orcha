package io.openorcha.mobile.ui.screens

/* Owns the projects list ("Projects") and its first-launch pairing empty state —
   iOS ContainersHomeScreen parity (Linear redesign). */

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.ui.ContainerHealth
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.BrandMark
import io.openorcha.mobile.ui.components.LBadgeCount
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

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
    val p = Orcha.palette
    val refreshAll = { onRefresh() }
    Scaffold(
        containerColor = p.bg,
        topBar = {
            Column(Modifier.fillMaxWidth().background(p.bg).statusBarsPadding()) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = LSpace.l, end = LSpace.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Projects",
                        style = ltype(LType.Headline),
                        color = p.text,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    IconButton(onClick = refreshAll) { Icon(OrchaIcons.Refresh, "Refresh", tint = p.text2) }
                    IconButton(onClick = onSettings) { Icon(OrchaIcons.Settings, "Settings", tint = p.text2) }
                    IconButton(onClick = onScan) { Icon(OrchaIcons.Add, "Add project", tint = p.accent) }
                }
                LDivider()
            }
        },
    ) { padding ->
        if (state.containers.isEmpty()) {
            PairingEmptyState(onScan = onScan, onAdd = onAdd, modifier = Modifier.padding(padding))
        } else {
            PullToRefreshBox(
                isRefreshing = false,
                onRefresh = refreshAll,
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
                verticalArrangement = Arrangement.spacedBy(LSpace.m),
            ) {
                item(key = "projects") {
                    LSection("All projects", count = state.containers.size) {
                        LCard(padding = 0.dp) {
                            state.containers.forEachIndexed { index, container ->
                                if (index > 0) LDivider()
                                ProjectRow(
                                    container = container,
                                    health = state.containerHealth[container.id],
                                    onOpen = onOpen,
                                    onForget = onForget,
                                    onRename = onRename,
                                )
                            }
                        }
                    }
                }
                item(key = "hint") {
                    Text(
                        "Every project on a paired Embodent appears here automatically. Long-press a project to rename or disconnect it.",
                        style = ltype(LType.Meta),
                        color = p.muted,
                        modifier = Modifier.padding(horizontal = LSpace.xs),
                    )
                }
            }
            }
        }
    }
}

/** First launch: one job — get the user to pairing (QR primary, manual address fallback). */
@Composable
private fun PairingEmptyState(onScan: () -> Unit, onAdd: () -> Unit, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    Box(modifier.fillMaxSize().padding(horizontal = LSpace.xl), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 420.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            BrandMark(44.dp)
            Text(
                "Add your Embodent",
                style = ltype(LType.Title),
                color = p.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                "Open your Embodent portal and choose Pair phone, then scan the QR here — or type the portal address, like embodent.yourteam.com. One pairing brings in every project on it.",
                style = ltype(LType.Body),
                color = p.text2,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.heightIn(min = LSpace.xs))
            LButton("Add your Embodent", onScan, Modifier.fillMaxWidth(), icon = OrchaIcons.QrCodeScanner, kind = LButtonKind.Primary)
            LButton("Enter address manually", onAdd, Modifier.fillMaxWidth(), kind = LButtonKind.Ghost)
        }
    }
}

/** Muted meta line for a project row, by reachability. */
internal fun projectMeta(health: ContainerHealth?): String = when (health?.state) {
    null, "probing" -> "Checking…"
    "unreachable" -> "Unreachable — is this project up?"
    "signin" -> "Signed out — sign in again in Settings"
    else -> "${health.agents} agents · ${health.tasks} open tasks" + (health.githubRepo?.let { " · $it" } ?: "")
}

internal fun projectStateLabel(health: ContainerHealth?): String = when (health?.state) {
    "live", "polling", "active" -> "Running"
    "paused" -> "Paused"
    "unreachable" -> "Unreachable"
    "signin" -> "Signed out"
    else -> "Checking"
}

/** One project: round glyph tile · name + one muted meta line · needs-you badge + status dot. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProjectRow(
    container: StoredContainer,
    health: ContainerHealth?,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onRename: (String, String) -> Unit,
) {
    val p = Orcha.palette
    var menu by remember { mutableStateOf(false) }
    var confirmDisconnect by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf(container.displayName) }
    val meta = projectMeta(health)
    val stateLabel = projectStateLabel(health)
    val needs = health?.needsYou ?: 0

    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .combinedClickable(
                    role = Role.Button,
                    onClick = { onOpen(container.id) },
                    onLongClickLabel = "Rename or disconnect",
                    onLongClick = { menu = true },
                )
                .semantics(mergeDescendants = true) {
                    contentDescription = container.displayName
                    stateDescription = listOfNotNull(stateLabel, meta, if (needs > 0) "$needs need you" else null).joinToString(", ")
                }
                .padding(start = LSpace.m, top = LSpace.s, bottom = LSpace.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            io.openorcha.mobile.ui.components.ProjectIconTile(health?.icon)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(container.displayName, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    meta,
                    style = ltype(LType.Meta),
                    color = if (health?.state == "signin") p.warn else p.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (needs > 0) LBadgeCount(needs)
            StatusDot(dotColorFor(health?.state ?: "probing"))
            // Visible way to Rename / Disconnect (long-press alone is undiscoverable).
            IconButton(onClick = { menu = true }) {
                Icon(OrchaIcons.MoreVert, "More options for ${container.displayName}", tint = p.muted)
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = p.raised) {
            DropdownMenuItem(text = { Text("Open", style = ltype(LType.Body)) }, onClick = { menu = false; onOpen(container.id) })
            DropdownMenuItem(text = { Text("Rename", style = ltype(LType.Body)) }, onClick = { menu = false; renaming = true })
            DropdownMenuItem(
                text = { Text("Disconnect", style = ltype(LType.Body), color = p.danger) },
                onClick = { menu = false; confirmDisconnect = true },
            )
        }
    }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect ${container.displayName}?", style = ltype(LType.Headline)) },
            text = { Text("This removes the pairing — and every project sharing its address — from this phone only. The project keeps running, and you can pair again anytime from the portal.", style = ltype(LType.Body)) },
            confirmButton = {
                TextButton(onClick = { confirmDisconnect = false; onForget(container.id) }) {
                    Text("Disconnect", color = p.danger, fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel", color = p.text2) } },
            containerColor = p.raised,
        )
    }
    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename on this phone", style = ltype(LType.Headline)) },
            text = { OrchaField(newName, { newName = it }, label = "Display name") },
            confirmButton = {
                TextButton(onClick = { renaming = false; onRename(container.id, newName) }) {
                    Text("Rename", color = p.accent, fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel", color = p.text2) } },
            containerColor = p.raised,
        )
    }
}

