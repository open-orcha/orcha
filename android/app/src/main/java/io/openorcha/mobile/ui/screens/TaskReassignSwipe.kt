package io.openorcha.mobile.ui.screens

/**
 * iOS parity (`TasksTabView` leading swipe action): swipe a task row from the leading edge to
 * reassign it. The row snaps back and the reassign sheet opens; TalkBack users get the same
 * action as a custom accessibility action.
 */

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@Composable
internal fun ReassignSwipeRow(onReassign: () -> Unit, content: @Composable () -> Unit) {
    val p = Orcha.palette
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.StartToEnd) onReassign()
            false // never dismiss: the row stays, the sheet opens
        },
    )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = true,
        enableDismissFromEndToStart = false,
        modifier = Modifier.semantics {
            customActions = listOf(CustomAccessibilityAction("Reassign") { onReassign(); true })
        },
        backgroundContent = {
            Row(
                Modifier.fillMaxSize().background(p.violet).padding(horizontal = LSpace.l),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LSpace.s),
            ) {
                Icon(OrchaIcons.SmartToy, null, tint = p.bg, modifier = Modifier.size(18.dp))
                Text("Reassign", style = ltype(LType.BodyEmph), color = p.bg)
            }
        },
    ) {
        content()
    }
}
