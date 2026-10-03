package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.min
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Scaffold chrome shared by WorkspaceScreen (iOS WorkspaceScreen/RootView parity):
   the compact Linear top bar (back · project switcher · Running/Paused capsule · overflow),
   the compact bottom nav with badges, and the first-load skeleton. */

/** Presence state of the open project, as the title dot reads it. */
internal fun workspaceDotState(hasSnapshot: Boolean, loading: Boolean, containerPaused: Boolean): String = when {
    !hasSnapshot -> if (loading) "probing" else "unreachable"
    containerPaused -> "paused"
    else -> "polling"
}

@Composable
internal fun dotColorFor(state: String): Color {
    val p = Orcha.palette
    return when (state) {
        "polling", "live", "active" -> p.ok
        "paused" -> p.warn
        "unreachable" -> p.danger
        "signin" -> p.warn
        else -> p.idle
    }
}

@Composable
internal fun StatusDot(color: Color, modifier: Modifier = Modifier, size: Int = 7) {
    Box(modifier.size(size.dp).background(color, CircleShape))
}

@Composable
internal fun WorkspaceTopBar(
    projectName: String,
    containers: List<StoredContainer>,
    selectedId: String?,
    dotState: String,
    showExecution: Boolean,
    running: Boolean,
    showCreate: Boolean,
    onBack: () -> Unit,
    onSwitchProject: ((String) -> Unit)?,
    onAllProjects: () -> Unit,
    onControls: () -> Unit,
    onCreateTask: () -> Unit,
    onSettings: () -> Unit,
    onDisconnect: () -> Unit,
    /** D14 project icons by container id (null / absent = the default glyph). */
    icons: Map<String, io.openorcha.mobile.domain.ProjectIconValue?> = emptyMap(),
    /** Opens Metrics & usage (hosted by WorkspaceScreen so the Home usage card shares it). */
    onOpenMetrics: () -> Unit = {},
) {
    val p = Orcha.palette
    var switcherOpen by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(p.bg).statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = LSpace.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "All projects", tint = p.text2) }
            // Project switcher: presence dot + name + chevron; lists every paired project.
            // Takes all the free width (no spacer splitting it in half), so the
            // name only truncates when the trailing actions genuinely need the room.
            Box(Modifier.weight(1f)) {
                Row(
                    Modifier
                        .heightIn(min = 48.dp)
                        .clickable(role = Role.Button, onClickLabel = "Switch project") { switcherOpen = true }
                        .padding(horizontal = LSpace.s)
                        .semantics(mergeDescendants = true) {
                            contentDescription = "$projectName, $dotState"
                        },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    StatusDot(dotColorFor(dotState))
                    io.openorcha.mobile.ui.components.ProjectIconMark(selectedId?.let { icons[it] }, size = 18.dp)
                    Text(
                        projectName,
                        style = ltype(LType.Headline),
                        color = p.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Icon(OrchaIcons.ExpandMore, null, tint = p.muted, modifier = Modifier.size(16.dp))
                }
                DropdownMenu(
                    expanded = switcherOpen,
                    onDismissRequest = { switcherOpen = false },
                    containerColor = p.raised,
                ) {
                    if (onSwitchProject != null && containers.size > 1) {
                        Text(
                            "Switch project",
                            style = ltype(LType.Micro),
                            color = p.muted,
                            modifier = Modifier.padding(horizontal = LSpace.l, vertical = LSpace.xs),
                        )
                        containers.forEach { c ->
                            DropdownMenuItem(
                                text = { Text(c.displayName, style = ltype(LType.Body), color = p.text) },
                                leadingIcon = { io.openorcha.mobile.ui.components.ProjectIconMark(icons[c.id], size = 18.dp) },
                                trailingIcon = if (c.id == selectedId) {
                                    { Icon(OrchaIcons.Check, "Current", tint = p.accent, modifier = Modifier.size(16.dp)) }
                                } else null,
                                onClick = {
                                    switcherOpen = false
                                    if (c.id != selectedId) onSwitchProject(c.id)
                                },
                            )
                        }
                    }
                    DropdownMenuItem(
                        text = { Text("All projects", style = ltype(LType.Body), color = p.text) },
                        leadingIcon = { Icon(OrchaIcons.Home, null, tint = p.muted, modifier = Modifier.size(16.dp)) },
                        onClick = { switcherOpen = false; onAllProjects() },
                    )
                }
            }
            if (showExecution) ExecutionChip(running, onControls)
            // The + slot is always reserved (an empty 48dp box off Home/Tasks) so the
            // Running capsule doesn't jump sideways when switching tabs.
            if (showCreate) {
                IconButton(onClick = onCreateTask) { Icon(OrchaIcons.Add, "Create task", tint = p.accent) }
            } else {
                Spacer(Modifier.size(48.dp))
            }
            Box {
                IconButton(onClick = { menuOpen = true }) { Icon(OrchaIcons.MoreVert, "More", tint = p.text2) }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = p.raised) {
                    DropdownMenuItem(
                        text = { Text("Settings", style = ltype(LType.Body), color = p.text) },
                        leadingIcon = { Icon(OrchaIcons.Settings, null, tint = p.muted, modifier = Modifier.size(16.dp)) },
                        onClick = { menuOpen = false; onSettings() },
                    )
                    if (selectedId != null) {
                        DropdownMenuItem(
                            text = { Text("Metrics & usage", style = ltype(LType.Body), color = p.text) },
                            leadingIcon = { Icon(OrchaIcons.Verified, null, tint = p.muted, modifier = Modifier.size(16.dp)) },
                            onClick = { menuOpen = false; onOpenMetrics() },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("All projects", style = ltype(LType.Body), color = p.text) },
                        leadingIcon = { Icon(OrchaIcons.Home, null, tint = p.muted, modifier = Modifier.size(16.dp)) },
                        onClick = { menuOpen = false; onAllProjects() },
                    )
                    DropdownMenuItem(
                        text = { Text("Disconnect", style = ltype(LType.Body), color = p.danger) },
                        leadingIcon = { Icon(OrchaIcons.Close, null, tint = p.danger, modifier = Modifier.size(16.dp)) },
                        onClick = { menuOpen = false; onDisconnect() },
                    )
                }
            }
        }
        LDivider()
    }
}

/** Compact Running / Paused capsule — opens the Autonomy & Notifier sheet. */
@Composable
private fun ExecutionChip(running: Boolean, onClick: () -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(999.dp)
    Box(
        Modifier
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = "Open autonomy and notifier") { onClick() }
            .semantics(mergeDescendants = true) {
                contentDescription = "Autonomy & Notifier"
                stateDescription = if (running) "Running" else "Paused"
            }
            .padding(horizontal = LSpace.xs),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .background(if (running) p.surface2 else p.warnSoft, shape)
                .border(1.dp, if (running) p.border else p.warnLine, shape)
                .padding(horizontal = LSpace.s, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            StatusDot(if (running) p.ok else p.warn, size = 6)
            Text(
                if (running) "Running" else "Paused",
                style = ltype(LType.Micro),
                color = if (running) p.text2 else p.warn,
                maxLines = 1,
            )
        }
    }
}

/** One compact bottom-nav destination. */
internal data class WorkspaceNavDest(val tab: WorkspaceTab, val label: String, val icon: ImageVector, val badge: Int)

@Composable
internal fun WorkspaceBottomBar(selected: WorkspaceTab, dests: List<WorkspaceNavDest>, onTab: (WorkspaceTab) -> Unit) {
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth().background(p.bg)) {
        LDivider()
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = LSpace.xs, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            dests.forEach { d -> WorkspaceNavItem(selected == d.tab, d, onTab) }
        }
    }
}

@Composable
private fun RowScope.WorkspaceNavItem(isSelected: Boolean, dest: WorkspaceNavDest, onTab: (WorkspaceTab) -> Unit) {
    val p = Orcha.palette
    val tint = if (isSelected) p.accent else p.muted
    Column(
        Modifier
            .weight(1f)
            .heightIn(min = 52.dp)
            .clickable(role = Role.Tab) { onTab(dest.tab) }
            .semantics(mergeDescendants = true) {
                selected = isSelected
                if (dest.badge > 0) stateDescription = "${dest.badge} new"
            }
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
    ) {
        Box {
            Box(
                Modifier
                    .background(if (isSelected) p.surface2 else Color.Transparent, RoundedCornerShape(8.dp))
                    .padding(horizontal = 12.dp, vertical = 3.dp),
            ) {
                Icon(dest.icon, null, tint = tint, modifier = Modifier.size(20.dp))
            }
            if (dest.badge > 0) {
                NavCountBadge(dest.badge, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-4).dp))
            }
        }
        Text(dest.label, style = ltype(LType.Micro), color = if (isSelected) p.text else p.muted, maxLines = 1)
    }
}

/** Max font scale a nav badge honours — beyond this the count would grow into the icon. */
private const val NAV_BADGE_MAX_FONT_SCALE = 1.15f

/**
 * Bottom-nav count badge that stays the same footprint at large font scales: fixed 16dp
 * height, text font scale capped at [NAV_BADGE_MAX_FONT_SCALE], anchored to the icon's
 * top-end by the caller. The full count stays available to TalkBack via stateDescription.
 */
@Composable
private fun NavCountBadge(n: Int, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val density = LocalDensity.current
    val capped = Density(density.density, fontScale = min(density.fontScale, NAV_BADGE_MAX_FONT_SCALE))
    CompositionLocalProvider(LocalDensity provides capped) {
        Box(
            modifier
                .height(16.dp)
                .widthIn(min = 16.dp)
                .background(p.surface3, CircleShape)
                .padding(horizontal = 4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (n > 99) "99+" else "$n",
                style = ltype(LType.Micro).copy(fontWeight = FontWeight.SemiBold, fontSize = 10.sp, lineHeight = 12.sp),
                color = p.text2,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

@Composable
internal fun WorkspaceSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(LSpace.l), verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
        Skeleton(22.dp, Modifier.width(160.dp))
        Skeleton(14.dp, Modifier.widthIn(max = 280.dp).fillMaxWidth())
        Skeleton(14.dp, Modifier.width(200.dp))
        Spacer(Modifier.heightIn(min = LSpace.s))
        Skeleton(52.dp)
        Skeleton(52.dp)
        Skeleton(52.dp)
        Skeleton(52.dp)
    }
}
