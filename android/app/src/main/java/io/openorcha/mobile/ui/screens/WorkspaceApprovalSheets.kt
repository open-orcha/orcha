package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Flow 08 — the approval sheets, shared by WorkspaceScreen and TaskScreens. Linear
   sheets: surface background, a small caption + headline, content in hairline cards,
   compact buttons with exactly one primary. Plan text / DoD render in full (never
   truncated); Request-changes / Send-back expand a REQUIRED feedback field. */

@Composable
private fun SheetHeader(caption: String, title: String, glyph: @Composable () -> Unit) {
    val p = Orcha.palette
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            glyph()
            Text(caption, style = ltype(LType.Micro), color = p.faint)
        }
        Text(title, style = ltype(LType.Title), color = p.text, modifier = Modifier.semantics { heading() })
    }
}

@Composable
private fun SheetCaption(text: String) {
    Text(text, style = ltype(LType.Meta), color = Orcha.palette.faint, modifier = Modifier.semantics { heading() })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanApprovalSheet(
    task: TaskDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onDecide: (Boolean, String?) -> Unit,
) {
    val p = Orcha.palette
    var rejecting by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = LSpace.l).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            SheetHeader("Plan approval", task.title) {
                androidx.compose.material3.Icon(OrchaIcons.Checklist, null, tint = p.violet, modifier = Modifier.size(14.dp))
            }
            task.planMessage?.let { pm ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    LAvatar(pm.authorAlias ?: "?", isAI = true, size = 20.dp)
                    Text("${pm.authorAlias ?: "The agent"} proposes a plan", style = ltype(LType.Meta), color = p.text2)
                }
            }
            SheetCaption("Proposed plan")
            LCard {
                MarkdownText(task.planMessage?.body ?: "No plan text found on the thread.")
            }
            if (rejecting) {
                OrchaField(
                    reason, { reason = it }, label = "What should change?", minLines = 3,
                    supporting = "${task.planMessage?.authorAlias ?: "The agent"} sees this on the next wake — required.",
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LSpace.s, Alignment.End)) {
                    LButton("Cancel", { rejecting = false }, kind = LButtonKind.Ghost, enabled = !busy)
                    LButton("Send back with changes", { onDecide(false, reason.trim()) }, kind = LButtonKind.Danger, enabled = reason.isNotBlank() && !busy)
                }
            } else {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LSpace.s, Alignment.End)) {
                    LButton("Request changes…", { rejecting = true }, kind = LButtonKind.Secondary, enabled = !busy)
                    LButton("Approve plan", { onDecide(true, null) }, icon = OrchaIcons.Check, kind = LButtonKind.Primary, enabled = !busy)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerifySheet(
    task: TaskDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    startRejecting: Boolean = false,
    onVerify: (Boolean, String?) -> Unit,
) {
    val p = Orcha.palette
    var rejecting by remember { mutableStateOf(startRejecting) }
    var feedback by remember { mutableStateOf("") }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = LSpace.l).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            SheetHeader("Verify task", task.title) { LStatusGlyph("needs_verification", size = 13.dp) }
            SheetCaption("Done when")
            LCard {
                val lines = (task.definitionOfDone ?: "").split("\n").map { it.trim().removePrefix("- ") }.filter { it.isNotBlank() }
                if (lines.isEmpty()) Text("No definition of done was provided.", style = ltype(LType.Body), color = p.faint)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    lines.forEach { line ->
                        Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                            LStatusGlyph("needs_verification", size = 14.dp, modifier = Modifier.padding(top = 3.dp))
                            Text(inlineMarkdown(line), style = ltype(LType.Body), color = p.text)
                        }
                    }
                }
            }
            (task.result ?: task.messageSummary?.last?.body)?.takeIf { it.isNotBlank() }?.let {
                SheetCaption("Claimed result")
                LCard { MarkdownText(it) }
            }
            if (rejecting) {
                OrchaField(feedback, { feedback = it }, label = "What's missing?", minLines = 3, supporting = "Returns the task to in progress — required.")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LSpace.s, Alignment.End)) {
                    LButton("Cancel", { rejecting = false }, kind = LButtonKind.Ghost, enabled = !busy)
                    LButton("Send back", { onVerify(false, feedback.trim()) }, kind = LButtonKind.Danger, enabled = feedback.isNotBlank() && !busy)
                }
            } else {
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.spacedBy(LSpace.s, Alignment.End)) {
                    LButton("Reject…", { rejecting = true }, kind = LButtonKind.Secondary, enabled = !busy)
                    LButton("Accept", { onVerify(true, null) }, icon = OrchaIcons.Check, kind = LButtonKind.Primary, enabled = !busy)
                }
            }
        }
    }
}
