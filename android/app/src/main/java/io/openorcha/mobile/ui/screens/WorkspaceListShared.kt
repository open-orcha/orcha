package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* Linear list pieces shared by the workspace tabs: a row with a muted trailing meta
   (time / id / count) and the web "Load more · N of M" row (tasks.html:272 /
   requests.html:148), used by WorkspaceTasksTab and WorkspaceRequestsTab. */

/** [LRow] with an optional muted trailing text (mono for ids); an explicit [trailing]
 *  slot wins over [trailingText]. */
@Composable
internal fun LinearListRow(
    title: String,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    trailingText: String? = null,
    trailingMono: Boolean = false,
) {
    val p = Orcha.palette
    LRow(
        title = title,
        modifier = modifier,
        subtitle = subtitle,
        onClick = onClick,
        leading = leading,
        trailing = trailing ?: trailingText?.takeIf { it.isNotEmpty() }?.let { text ->
            {
                Text(
                    text,
                    style = ltype(if (trailingMono) LType.Mono else LType.Meta),
                    color = p.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
    )
}

@Composable
internal fun LoadMoreRow(shownCount: Int, total: Int, onMore: () -> Unit) {
    val p = Orcha.palette
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onMore)
            .padding(horizontal = LSpace.m, vertical = LSpace.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Text("Load more", style = ltype(LType.BodyEmph), color = p.accent)
        Text("$shownCount of $total", style = ltype(LType.Meta), color = p.muted)
    }
}
