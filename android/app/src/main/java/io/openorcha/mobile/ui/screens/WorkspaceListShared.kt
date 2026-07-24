package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.theme.Orcha

/* Web "Load more · N of M" row (tasks.html:272 / requests.html:148), shared by
   WorkspaceTasksTab and WorkspaceRequestsTab. */

@Composable
internal fun LoadMoreRow(shownCount: Int, total: Int, onMore: () -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = onMore) {
        Text(
            "Load more · showing $shownCount of $total",
            style = MaterialTheme.typography.labelLarge,
            color = p.accent,
            modifier = Modifier.fillMaxWidth(),
            fontWeight = FontWeight.W700,
        )
    }
}
