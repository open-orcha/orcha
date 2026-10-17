package io.openorcha.mobile.ui.screens

/* Owns manual connection entry and connection-help presentation. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 03 — manual entry + the unreachable checklist state. Linear onboarding
   like iOS `ManualConnectSheet`: Embodent hero, Address · Sign in · Connected
   tracker, numbered steps, Linear fields and ONE primary Connect. Address-neutral
   wording: both a local self-host address and a cloud portal domain work.
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
    val p = Orcha.palette
    var address by remember { mutableStateOf(state.connectDraft.orEmpty()) }
    var token by remember { mutableStateOf("") }
    // The probe's outcome only reaches this screen through `state.error`; only a
    // reachability failure renders the checklist. `dismissedFailure` lets "Back"
    // leave the checklist without the stale error re-triggering it.
    var dismissedFailure by remember { mutableStateOf(false) }
    val failed = !state.connectNeedsToken && !dismissedFailure &&
        state.error != null && state.error.contains("reach", ignoreCase = true)

    fun connect() {
        dismissedFailure = false
        if (token.isBlank()) onConnect(address) else onConnectWithToken(address, token)
    }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    title = { Text("Add a server", style = ltype(LType.Headline), color = p.text) },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg),
                    navigationIcon = {
                        IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back", tint = p.text2) }
                    },
                    actions = {
                        IconButton(onClick = onScan) { Icon(OrchaIcons.QrCodeScanner, "Scan the pairing QR", tint = p.text2) }
                    },
                )
                LDivider()
            }
        },
    ) { padding ->
        if (state.connectNeedsToken) {
            // The perimeter bounced this address — GitHub sign-in is the primary way
            // through, pasting a token the collapsed fallback.
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
            StateLayout(
                title = "Can't reach this Embodent",
                sub = "${address.ifBlank { "That address" }} didn't answer. Your work is safe — the phone just can't see it right now.",
                modifier = Modifier.padding(padding),
                danger = true,
                glyph = { Icon(OrchaIcons.WifiOff, null, tint = p.danger, modifier = Modifier.size(28.dp)) },
            ) {
                LCard {
                    NumberedLine(1, "Is the address right? A cloud portal needs no port.")
                    NumberedLine(2, "Is the deployment up — or, self-hosting, is the computer awake with Embodent running?")
                    NumberedLine(3, "On a local address: same Wi-Fi, and no firewall or VPN in the way?")
                }
                LButton(
                    if (state.connecting) "Connecting…" else "Try again",
                    { connect() },
                    modifier = Modifier.fillMaxWidth(),
                    icon = OrchaIcons.Refresh,
                    kind = LButtonKind.Primary,
                    enabled = !state.connecting,
                )
                LButton("Back", { dismissedFailure = true }, icon = OrchaIcons.ArrowBack, kind = LButtonKind.Ghost)
            }
            return@Scaffold
        }
        LazyColumn(
            // issue 2 regression guard: with adjustResize the window no longer pans, so
            // the address form must give way to the keyboard
            modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.l),
        ) {
            item { PairingHero() }
            item { PairingStepper(PairingStep.Address) }
            item {
                LCard(padding = LSpace.l) {
                    Column(verticalArrangement = Arrangement.spacedBy(LSpace.l)) {
                        PairingStepCard(1, "Scan the QR", "Open your portal → Settings → Devices and pairing → Pair phone. Scanning fills this in for you.")
                        PairingStepCard(2, "Or enter the address", "For a cloud deployment that's the portal domain, like embodent.yourteam.com.")
                        OrchaField(
                            address, { address = it },
                            label = "Address or QR payload",
                            placeholder = "embodent.yourteam.com",
                            minLines = 1, maxLines = 5,
                        )
                        OrchaField(
                            token, { token = it },
                            label = "Access token (if required)",
                            masked = true,
                        )
                        Text(
                            "Cloud deployments sit behind a sign-in — connect and you'll get a Sign in with GitHub option, or paste the team access token your admin shared. Leave the token empty for an unprotected local server.",
                            style = ltype(LType.Micro),
                            color = p.faint,
                        )
                        LButton(
                            if (state.connecting) "Connecting…" else "Connect",
                            { connect() },
                            modifier = Modifier.fillMaxWidth(),
                            icon = OrchaIcons.ArrowForward,
                            kind = LButtonKind.Primary,
                            enabled = !state.connecting && address.isNotBlank(),
                        )
                    }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
            item { SelfHostHelpCard() }
        }
    }
}
