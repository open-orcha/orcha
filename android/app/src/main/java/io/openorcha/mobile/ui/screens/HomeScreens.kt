package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.WifiOff
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
        containerColor = Orcha.palette.bg,
        topBar = {
            TopAppBar(
                title = { Text("Orcha", fontWeight = FontWeight.W800) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, "Refresh") }
                    IconButton(onClick = onSettings) { Icon(Icons.Rounded.Settings, "Settings") }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onScan,
                containerColor = Orcha.palette.accent,
                contentColor = Orcha.palette.accentInk,
                icon = { Icon(Icons.Rounded.QrCodeScanner, null) },
                text = { Text("Add", fontWeight = FontWeight.W700) },
            )
        },
    ) { padding ->
        if (state.containers.isEmpty()) {
            // H3 · first launch: one job — get the user to pairing.
            StateLayout(
                title = "Add your Orcha",
                sub = "On your computer, open the Orcha portal and choose Pair phone — then scan the QR code here. Phone and laptop must share a Wi-Fi network.",
                modifier = Modifier.padding(padding),
                glyph = { BrandMark(44.dp) },
            ) {
                Spacer(Modifier.height(6.dp))
                PrimaryButton("Add your Orcha", onScan, leading = { Icon(Icons.Rounded.QrCodeScanner, null, tint = Orcha.palette.accentInk) })
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
                        "Long-press a card to rename or disconnect. Your phone talks to each Orcha directly on your network.",
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
                Icon(Icons.Rounded.ChevronRight, null, tint = Orcha.palette.faint)
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
                "Last seen a while ago — is the laptop awake?",
                style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted,
            )
            else -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${health.agents} agents · ${health.tasks} tasks", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted)
                Spacer(Modifier.weight(1f))
                if (health.needsYou > 0) {
                    io.openorcha.mobile.ui.components.StatusPill("${health.needsYou} need you", io.openorcha.mobile.ui.components.StatusDomain.Agent)
                }
            }
        }
    }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect ${container.displayName}?") },
            text = { Text("This only removes the pairing from this phone. The Orcha keeps running on your computer, and you can pair again anytime from the portal.") },
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
   Flow 03 — pairing. The pairing endpoint (doc 13 ask A1/A2) doesn't exist yet,
   so the scanner is honest about the gap: QR payloads paste-able, LAN address
   manual entry, unreachable state with the design's checklist copy.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualConnectScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onScan: () -> Unit,
    onConnect: (String) -> Unit,
) {
    var address by remember { mutableStateOf("") }
    Scaffold(
        containerColor = Orcha.palette.bg,
        topBar = {
            TopAppBar(
                title = { Text("Add your Orcha") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        if (state.error != null && state.error.contains("reach", ignoreCase = true)) {
            // A3 · unreachable after probe — checklist copy from the design package
            StateLayout(
                title = "Can't reach your laptop",
                sub = "${address.ifBlank { "That address" }} didn't answer. Your work is safe — the phone just can't see it right now.",
                modifier = Modifier.padding(padding),
                danger = true,
                glyph = { Icon(Icons.Rounded.WifiOff, null, tint = Orcha.palette.danger) },
            ) {
                OrchaCard {
                    Text("1  Is the phone on the same Wi-Fi as the laptop?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("2  Is the laptop awake and Orcha running?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("3  Firewall or VPN blocking the port?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                }
                NeutralButton("Try again", { onConnect(address) }, enabled = !state.connecting)
                TextButton(onClick = onBack) { Text("Back to My Orchas", color = Orcha.palette.accent, fontWeight = FontWeight.W700) }
            }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Banner(
                    BannerKind.Info,
                    "The portal's Pair-phone QR endpoint is still in review — until it ships, scan any orcha-pair QR, paste its payload, or enter the laptop's Wi-Fi address.",
                )
            }
            item { NeutralButton("Scan a QR instead", onScan, modifier = Modifier.fillMaxWidth()) }
            item {
                OrchaField(
                    address, { address = it },
                    label = "Address or QR payload",
                    placeholder = "192.168.1.24:8001",
                    minLines = 1, maxLines = 5,
                )
            }
            item {
                PrimaryButton(
                    if (state.connecting) "Connecting…" else "Connect",
                    { onConnect(address) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.connecting && address.isNotBlank(),
                )
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
        }
    }
}

/* =============================================================================
   Flow 04 S1 — Settings: Appearance (instant three-way theme), containers, about.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onTheme: (ThemeMode) -> Unit,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onAdd: () -> Unit,
) {
    Scaffold(
        containerColor = Orcha.palette.bg,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
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
            item { SectionH("Containers", "${state.containers.size}") }
            items(state.containers, key = { it.id }) { c ->
                OrchaCard(onClick = { onOpen(c.id) }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(c.displayName, human = false)
                        Column(Modifier.weight(1f)) {
                            Text(c.displayName, style = MaterialTheme.typography.titleSmall)
                            Text(c.baseUrl, style = MonoSmStyle, color = Orcha.palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        TextButton(onClick = { onForget(c.id) }) { Text("Disconnect", color = Orcha.palette.danger) }
                    }
                }
            }
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
}
