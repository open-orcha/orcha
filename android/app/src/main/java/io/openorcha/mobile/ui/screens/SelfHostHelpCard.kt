package io.openorcha.mobile.ui.screens

/* Collapsed self-host explainer, split out of ManualConnectScreen.kt to keep it ≤250 lines. */

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/**
 * Collapsed explainer for the self-host path: local Wi-Fi entry and the
 * optional Tailscale remote address. The cloud path never needs any of it.
 * iOS `ManualConnectSheet.selfHostHelp` parity.
 */
@Composable
fun SelfHostHelpCard() {
    val p = Orcha.palette
    var expanded by remember { mutableStateOf(false) }
    OrchaCard {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(OrchaIcons.DesktopWindows, null, tint = p.accent, modifier = Modifier.size(16.dp))
            Text(
                "Running Orcha on your own computer?",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { expanded = !expanded }) {
                Text(if (expanded) "Hide" else "Show", color = p.accent)
            }
        }
        if (expanded) {
            Spacer(Modifier.height(8.dp))
            Text(
                "A cloud portal works from anywhere and none of this applies. Self-hosting on your own machine instead? Then the phone talks straight to that computer:",
                style = MaterialTheme.typography.bodySmall,
                color = p.text2,
            )
            Spacer(Modifier.height(8.dp))
            SelfHostStep(1, "On the same Wi-Fi, enter the computer's address with the portal port, e.g. 192.168.1.24:8001. No access token needed unless you put one in front of it.")
            SelfHostStep(2, "To check in from outside that Wi-Fi, install Tailscale (free for personal use) on this phone and on the computer, signed into the same account — an encrypted tunnel between your own devices.")
            SelfHostStep(3, "Add the computer's Tailscale address under Settings → Containers → \"Add remote…\", e.g. my-mac.tailnet.ts.net:8001. The app then uses whichever address answers, switching automatically as you come and go.")
            Spacer(Modifier.height(4.dp))
            Text(
                "The only requirement while you're out: the computer must be awake.",
                style = MaterialTheme.typography.bodySmall,
                color = p.text2,
            )
        }
    }
}

@Composable
private fun SelfHostStep(n: Int, text: String) {
    val p = Orcha.palette
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Box(
            Modifier
                .size(18.dp)
                .background(p.accentSoft, MaterialTheme.shapes.extraSmall),
            contentAlignment = Alignment.Center,
        ) {
            Text("$n", style = MaterialTheme.typography.labelSmall, color = p.accent, fontWeight = FontWeight.W700)
        }
        Text(text, style = MaterialTheme.typography.bodySmall, color = p.text2, modifier = Modifier.weight(1f))
    }
}
