package io.openorcha.mobile.ui.screens

/* Owns manual connection entry and connection-help presentation. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 03 — manual entry (frame A4) + the unreachable checklist state (A3).
   Exact clone of iOS's `ManualConnectSheet`: cloud-first copy, address AND
   token fields together in the base form, and address-neutral wording
   throughout — this app supports both a local self-host address and a
   deployed cloud/remote portal address equally, so nothing here assumes LAN.
   ============================================================================= */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualConnectScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onScan: () -> Unit,
    onConnect: (String) -> Unit,
    // Device-token auth (cloud unification):
    onSignIn: () -> Unit = {},
    onConnectWithToken: (String, String) -> Unit = { _, _ -> },
) {
    var address by remember { mutableStateOf(state.connectDraft.orEmpty()) }
    var token by remember { mutableStateOf("") }
    // The probe's outcome only ever reaches this screen through `state.error` (the
    // connect call is fire-and-forget into the ViewModel, mirroring iOS's `async`
    // `connect(_:)` outcome) -- classify it the same way `friendlyConnectionError`
    // does, so an app-side data-shape failure never renders the unreachable
    // checklist. `dismissedFailure` lets "Back" leave the checklist without the
    // stale error re-triggering it before a fresh attempt runs.
    var dismissedFailure by remember { mutableStateOf(false) }
    val failed = !state.connectNeedsToken && !dismissedFailure &&
        state.error != null && state.error.contains("reach", ignoreCase = true)

    fun tryConnect() {
        dismissedFailure = false
        onConnect(address)
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = { Text("Add your Orcha") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        if (state.connectNeedsToken) {
            // Device-token auth, iOS `AuthOptionsSheet` parity: the perimeter
            // bounced this address — GitHub sign-in is the primary way through,
            // pasting a token the collapsed fallback.
            DeviceSignInPanel(
                state = state,
                modifier = Modifier.padding(padding),
                onSignIn = onSignIn,
                onConnectWithToken = { pastedToken ->
                    val draft = state.connectDraft ?: address
                    onConnectWithToken(draft, pastedToken)
                },
            )
            return@Scaffold
        }
        if (failed) {
            // A3 · unreachable after probe — address-neutral: this fires whether
            // the address was a local self-host box or a deployed cloud portal,
            // so the checklist names neither Wi-Fi nor a laptop specifically.
            StateLayout(
                title = "Can't reach this Orcha",
                sub = "${address.ifBlank { "That address" }} didn't answer. Your work is safe — the phone just can't see it right now.",
                modifier = Modifier.padding(padding),
                danger = true,
                glyph = { Icon(OrchaIcons.WifiOff, null, tint = Orcha.palette.danger) },
            ) {
                OrchaCard {
                    Text("1  Is the address right? A cloud portal needs no port.", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("2  Is the deployment up — or, self-hosting, is the computer awake with Orcha running?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("3  On a local address: same Wi-Fi, and no firewall or VPN in the way?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                }
                NeutralButton("Try again", { tryConnect() }, enabled = !state.connecting)
                TextButton(onClick = { dismissedFailure = true }) { Text("Back", color = Orcha.palette.accent, fontWeight = FontWeight.W700) }
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
                    "Enter your Orcha's address — for a cloud deployment that's the portal domain, like orcha.yourteam.com. Scanning the portal's Pair-phone QR fills this in for you.",
                )
            }
            item {
                OrchaField(
                    address, { address = it },
                    label = "Address or QR payload",
                    placeholder = "orcha.yourteam.com",
                    minLines = 1, maxLines = 5,
                )
            }
            item {
                OrchaField(
                    token, { token = it },
                    label = "Access token (if required)",
                    masked = true,
                )
            }
            item {
                Text(
                    "Cloud deployments sit behind a sign-in — connect and you'll get a Sign in with GitHub option, or paste the team access token your admin shared. Leave the token empty for an unprotected local server.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Orcha.palette.faint,
                )
            }
            item {
                PrimaryButton(
                    if (state.connecting) "Connecting…" else "Connect",
                    {
                        dismissedFailure = false
                        if (token.isBlank()) {
                            onConnect(address)
                        } else {
                            onConnectWithToken(address, token)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.connecting && address.isNotBlank(),
                )
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
            item { SelfHostHelpCard() }
        }
    }
}
