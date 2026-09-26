package io.openorcha.mobile.ui.screens

/* Device-token sign-in panel, split out of ManualConnectScreen.kt to keep it ≤250 lines. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.DeviceAuthFlow
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
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
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Banner(
                BannerKind.Info,
                "This Orcha is protected. Sign in with GitHub and this phone gets its own device token — nothing to paste.",
            )
        }
        item {
            PrimaryButton(
                signInTitle,
                onSignIn,
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
                leading = { Icon(OrchaIcons.OpenInNew, null, modifier = Modifier.size(18.dp)) },
            )
        }
        val failedMessage = (phase as? DeviceAuthFlow.Phase.Failed)?.message
        if (failedMessage != null) {
            item { Banner(BannerKind.Danger, failedMessage) }
        }
        item {
            OrchaCard {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(OrchaIcons.Key, null, tint = p.accent, modifier = Modifier.size(16.dp))
                    Text(
                        "Use an access token instead",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { showTokenEntry = !showTokenEntry }) {
                        Text(if (showTokenEntry) "Hide" else "Show", color = p.accent)
                    }
                }
                if (showTokenEntry) {
                    Spacer(Modifier.height(8.dp))
                    OrchaField(
                        token, { token = it },
                        label = "Access token",
                        masked = true,
                    )
                    Text(
                        "Advanced: paste the team access token your admin shared. Sign-in above does this for you.",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.faint,
                    )
                    Spacer(Modifier.height(8.dp))
                    NeutralButton(
                        if (state.connecting) "Connecting…" else "Connect with token",
                        { onConnectWithToken(token) },
                        enabled = !busy && token.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (failedMessage == null) {
                        state.error?.let { Banner(BannerKind.Danger, it) }
                    }
                }
            }
        }
    }
}
