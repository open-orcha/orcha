package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.theme.Orcha

/* Small scaffold pieces shared by WorkspaceScreen: the bottom-nav item (with badge)
   and the loading skeleton shown before the first snapshot arrives. */

@Composable
internal fun RowScope.WorkspaceNavItem(
    state: OrchaUiState,
    tab: WorkspaceTab,
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    badge: Int,
    onTab: (WorkspaceTab) -> Unit,
) {
    NavigationBarItem(
        selected = state.selectedTab == tab,
        onClick = { onTab(tab) },
        icon = {
            BadgedBox(badge = { if (badge > 0) Badge(containerColor = Orcha.palette.danger) { Text("$badge") } }) {
                Icon(icon, label)
            }
        },
        label = { Text(label, style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.5.sp)) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = Orcha.palette.accent,
            selectedTextColor = Orcha.palette.text,
            indicatorColor = Orcha.palette.accentSoft,
            unselectedIconColor = Orcha.palette.text2,
            unselectedTextColor = Orcha.palette.text2,
        ),
    )
}

@Composable
internal fun WorkspaceSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Skeleton(14.dp, Modifier.width(120.dp))
        Skeleton(96.dp)
        Skeleton(96.dp)
        Skeleton(14.dp, Modifier.width(90.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Skeleton(74.dp, Modifier.weight(1f)); Skeleton(74.dp, Modifier.weight(1f))
            Skeleton(74.dp, Modifier.weight(1f)); Skeleton(74.dp, Modifier.weight(1f))
        }
        Skeleton(96.dp)
    }
}
