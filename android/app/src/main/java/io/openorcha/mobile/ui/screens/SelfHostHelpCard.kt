package io.openorcha.mobile.ui.screens

/* Linear onboarding pieces shared by the pairing screens (ManualConnectScreen,
   DeviceSignInPanel): the Embodent hero, the 3-step tracker, numbered step cards,
   a disclosure header and the collapsed self-host explainer. iOS
   PairingScreens.swift parity. */

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.components.BrandMark
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

internal const val PAIRING_TAGLINE = "Your agents, approvals and reviews — in your pocket."

/** The three pairing steps (Address → Sign in → Connected). */
internal enum class PairingStep(val title: String) { Address("Address"), SignIn("Sign in"), Connected("Connected") }

/** App mark, "Embodent", tagline. */
@Composable
internal fun PairingHero(subtitle: String = PAIRING_TAGLINE) {
    val p = Orcha.palette
    Column(
        Modifier.fillMaxWidth().padding(top = LSpace.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        BrandMark(size = 60.dp)
        Text("Embodent", style = ltype(LType.Display), color = p.text, modifier = Modifier.semantics { heading() })
        Text(subtitle, style = ltype(LType.Body), color = p.text2, textAlign = TextAlign.Center)
    }
}

/** Three-step progress tracker; the current step sits in a surface pill. */
@Composable
internal fun PairingStepper(current: PairingStep, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    Row(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "Step ${current.ordinal + 1} of ${PairingStep.entries.size}: ${current.title}"
            },
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PairingStep.entries.forEach { step ->
            val isCurrent = step == current
            val reached = step.ordinal <= current.ordinal
            val ring by animateColorAsState(if (reached) p.accent else p.border2, label = "ring")
            Row(
                Modifier
                    .then(
                        if (isCurrent) {
                            Modifier.background(p.surface, CircleShape).border(1.dp, p.border2, CircleShape)
                        } else {
                            Modifier
                        },
                    )
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(Modifier.size(16.dp).border(1.5.dp, ring, CircleShape), contentAlignment = Alignment.Center) {
                    when {
                        step.ordinal < current.ordinal ->
                            Icon(OrchaIcons.Check, null, tint = p.accent, modifier = Modifier.size(10.dp))
                        isCurrent -> Box(Modifier.size(8.dp).background(p.accent, CircleShape))
                    }
                }
                Text(
                    step.title,
                    style = ltype(LType.Micro).copy(fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal),
                    color = if (isCurrent) p.text else p.muted,
                )
            }
            if (step != PairingStep.entries.last()) {
                Box(
                    Modifier
                        .width(14.dp)
                        .height(1.dp)
                        .background(if (step.ordinal < current.ordinal) p.accent.copy(alpha = 0.6f) else p.border),
                )
            }
        }
    }
}

/** A big, numbered onboarding step. */
@Composable
internal fun PairingStepCard(number: Int, title: String, detail: String) {
    val p = Orcha.palette
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.size(28.dp).background(p.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
            Text("$number", style = ltype(LType.Mono).copy(fontWeight = FontWeight.SemiBold), color = p.accent)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = ltype(LType.Headline), color = p.text)
            Text(detail, style = ltype(LType.Meta), color = p.muted)
        }
    }
}

/** Collapsible header row used by the advanced / self-host cards. */
@Composable
internal fun PairingDisclosure(title: String, icon: ImageVector, expanded: Boolean, onToggle: () -> Unit) {
    val p = Orcha.palette
    val angle by animateFloatAsState(if (expanded) 90f else 0f, label = "chevron")
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onToggle)
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Icon(icon, null, tint = p.text2, modifier = Modifier.size(16.dp))
        Text(title, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
        Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(16.dp).rotate(angle))
    }
}

/** A small numbered line used inside checklists (can't-reach, self-host). */
@Composable
internal fun NumberedLine(n: Int, text: String) {
    val p = Orcha.palette
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        Box(Modifier.size(18.dp).background(p.surface2, CircleShape).border(1.dp, p.border, CircleShape), contentAlignment = Alignment.Center) {
            Text("$n", style = ltype(LType.Micro), color = p.text2)
        }
        Text(text, style = ltype(LType.Meta), color = p.text2, modifier = Modifier.weight(1f))
    }
}

/**
 * Collapsed explainer for the self-host path: local Wi-Fi entry and the
 * optional Tailscale remote address. The cloud path never needs any of it.
 */
@Composable
fun SelfHostHelpCard() {
    val p = Orcha.palette
    var expanded by remember { mutableStateOf(false) }
    LCard(padding = LSpace.m) {
        PairingDisclosure("Running Embodent on your own computer?", OrchaIcons.DesktopWindows, expanded) { expanded = !expanded }
        AnimatedVisibility(expanded) {
            Column(Modifier.padding(top = LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.xs)) {
                Text(
                    "A cloud portal works from anywhere and none of this applies. Self-hosting on your own machine instead? Then the phone talks straight to that computer:",
                    style = ltype(LType.Meta), color = p.text2,
                )
                NumberedLine(1, "On the same Wi-Fi, enter the computer's address with the portal port, e.g. 192.168.1.24:8001. No access token needed unless you put one in front of it.")
                NumberedLine(2, "To check in from outside that Wi-Fi, install Tailscale (free for personal use) on this phone and on the computer, signed into the same account.")
                NumberedLine(3, "Add the computer's Tailscale address under Settings › Devices and pairing › Remote address, e.g. my-mac.tailnet.ts.net:8001. The app uses whichever address answers.")
                Text("The only requirement while you're out: the computer must be awake.", style = ltype(LType.Micro), color = p.faint)
            }
        }
    }
}
