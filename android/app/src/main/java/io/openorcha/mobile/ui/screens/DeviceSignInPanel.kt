package io.openorcha.mobile.ui.screens

/* Device-token sign-in panel, split out of ManualConnectScreen.kt to keep it ≤250 lines. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import io.openorcha.mobile.domain.DeviceAuthFlow
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/**
 * Device-token auth (cloud unification), Android parity of iOS's `AuthOptionsSheet`:
 * shown when a probe bounces off the auth perimeter. Primary path is GitHub
 * sign-in — a Custom Tab round-trip that mints this phone's own device token,
 * nothing to paste. Pasting a team/device token stays available, collapsed, as
 * the advanced fallback.
 */
@Composable
fun DeviceSignInPanel(
    state: OrchaUiState,
    modifier: Modifier = Modifier,
    onSignIn: () -> Unit,
    onConnectWithToken: (String) -> Unit,
) {
    val p = Orcha.palette
    var showTokenEntry by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    val phase = state.deviceAuth.phase
    val busy = phase is DeviceAuthFlow.Phase.SigningIn || phase is DeviceAuthFlow.Phase.Connecting || state.connecting
    val signInTitle = when (phase) {
        is DeviceAuthFlow.Phase.SigningIn -> "Waiting for GitHub…"
        is DeviceAuthFlow.Phase.Connecting -> "Connecting…"
        else -> "Sign in with GitHub"
    }

    LazyColumn(
        modifier = modifier.fillMaxSize().imePadding(),
        contentPadding = PaddingValues(LSpace.l),
        verticalArrangement = Arrangement.spacedBy(LSpace.l),
    ) {
        item { PairingHero() }
        item { PairingStepper(if (busy) PairingStep.Connected else PairingStep.SignIn) }
        item {
            LCard(padding = LSpace.l) {
                Column(verticalArrangement = Arrangement.spacedBy(LSpace.l)) {
                    PairingStepCard(
                        1, "Sign in with GitHub",
                        "This server is protected. Sign in and this phone gets its own device token — nothing to paste.",
                    )
                    LButton(
                        signInTitle,
                        onSignIn,
                        modifier = Modifier.fillMaxWidth(),
                        icon = OrchaIcons.OpenInNew,
                        kind = LButtonKind.Primary,
                        enabled = !busy,
                    )
                }
            }
        }
        val failedMessage = (phase as? DeviceAuthFlow.Phase.Failed)?.message
        if (failedMessage != null) {
            item { Banner(BannerKind.Danger, failedMessage) }
        }
        item {
            LCard(padding = LSpace.m) {
                PairingDisclosure("Use an access token instead", OrchaIcons.Key, showTokenEntry) { showTokenEntry = !showTokenEntry }
                if (showTokenEntry) {
                    Column(Modifier.padding(top = LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
                        OrchaField(
                            token, { token = it },
                            label = "Access token",
                            masked = true,
                        )
                        Text(
                            "Advanced: paste the team access token your admin shared. Sign-in above does this for you.",
                            style = ltype(LType.Micro),
                            color = p.faint,
                        )
                        LButton(
                            if (state.connecting) "Connecting…" else "Connect with token",
                            { onConnectWithToken(token) },
                            modifier = Modifier.fillMaxWidth(),
                            kind = LButtonKind.Secondary,
                            enabled = !busy && token.isNotBlank(),
                        )
                        if (failedMessage == null) {
                            state.error?.let { Banner(BannerKind.Danger, it) }
                        }
                    }
                }
            }
        }
    }
}
