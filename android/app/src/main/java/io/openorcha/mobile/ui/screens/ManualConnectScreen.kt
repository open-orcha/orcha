package io.openorcha.mobile.ui.screens

/* Owns manual connection entry and connection-help presentation. */

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
            // issue 2 regression guard: with adjustResize the window no longer pans, so
            // the address form must give way to the keyboard
            modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
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
