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
