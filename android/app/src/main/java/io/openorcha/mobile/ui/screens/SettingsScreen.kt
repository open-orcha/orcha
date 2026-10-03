package io.openorcha.mobile.ui.screens

/* Settings, grouped like the web portal and the iOS redesign: PROJECT (General,
   Execution), ACCESS (Members, Devices and pairing) and PERSONAL (Appearance,
   Notifications, Interface), with a Embodent footer. Linear rows on panel cards. */

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import io.openorcha.mobile.data.InboxApi
import io.openorcha.mobile.data.InboxMembersResponse
import kotlinx.coroutines.launch
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.BuildConfig
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.BrandMark
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.SkinMode
import io.openorcha.mobile.ui.theme.ThemeMode

/** The user-facing autonomy label (Plan-only / Build to PR / Full). */
internal fun autonomyDisplayLabel(level: String?): String = when (level) {
    "pr" -> "Build to PR"
    "full" -> "Full"
    else -> "Plan-only"
}

/** The Execution row's trailing value: "Paused" when wakes are off, else the autonomy label. */
internal fun executionSummary(wakesEnabled: Boolean?, autonomyLevel: String?): String =
    if (wakesEnabled == false) "Paused" else autonomyDisplayLabel(autonomyLevel)

/** Theme segmented options — "System" for Auto, like iOS and the portal. */
internal val THEME_OPTIONS: List<Pair<ThemeMode, String>> = ThemeMode.entries.map {
    it to when (it) {
        ThemeMode.Auto -> "System"
        ThemeMode.Light -> "Light"
        ThemeMode.Dark -> "Dark"
    }
}

/** Interface skin options — Linear (Classic) first. */
internal val SKIN_OPTIONS: List<Pair<SkinMode, String>> =
    (listOf(SkinMode.Classic) + SkinMode.entries.filter { it != SkinMode.Classic }).map { it to it.label }

/** One paired server and the projects stored from it (shared token, remote, connection). */
internal data class ServerGroup(val primary: StoredContainer, val projects: List<StoredContainer>) {
    val ids: List<String> get() = projects.map { it.id }

    /** A lone project keeps its own name; a shared server shows its address. */
    val title: String get() = if (projects.size == 1) primary.displayName else primary.baseUrl

    val subtitle: String
        get() = if (projects.size == 1) primary.baseUrl else projects.joinToString(", ") { it.displayName }
}

/** Groups paired projects by server base URL, keeping first-seen order, so each server shows once. */
internal fun groupByServer(containers: List<StoredContainer>): List<ServerGroup> =
    containers.groupBy { it.baseUrl }.values.map { ServerGroup(it.first(), it) }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onTheme: (ThemeMode) -> Unit,
    onSkin: (SkinMode) -> Unit,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onAdd: () -> Unit,
    onSetRemoteUrl: (String, String?) -> Unit = { _, _ -> },
    // Device-token auth (cloud unification):
    onSetAccessToken: (String, String?) -> Unit = { _, _ -> },
    onSignInAgain: (String) -> Unit = {},
    // Execution (Notifier & autonomy) — the same human actions the workspace sheet uses.
    onSetWakes: ((Boolean) -> Unit)? = null,
    onSetAutonomy: ((String) -> Unit)? = null,
    // Routines history rows open the created task (optional).
    onOpenTask: ((String) -> Unit)? = null,
    // After Connect repo saves, so the caller can refresh the snapshot (optional).
    onRepoChanged: (String?) -> Unit = {},
    // After the project icon saves, so the caller can refresh the snapshot (optional).
    onIconChanged: () -> Unit = {},
) {
    val p = Orcha.palette
    val context = LocalContext.current
    var remoteDialogFor by remember { mutableStateOf<ServerGroup?>(null) }
    var tokenDialogFor by remember { mutableStateOf<ServerGroup?>(null) }
    var showExecution by remember { mutableStateOf(false) }
    var showConnectRepo by remember { mutableStateOf(false) }
    var showIconSheet by remember { mutableStateOf(false) }
    // Optimistic local copy so the row repaints before the snapshot refresh lands.
    var savedIcon by remember(state.selectedContainer?.id) { mutableStateOf<Pair<Boolean, io.openorcha.mobile.domain.ProjectIconValue?>>(false to null) }
    var subPage by rememberSaveable { mutableStateOf<String?>(null) }
    var showPlanUsage by remember { mutableStateOf(false) }
    if (showPlanUsage) {
        val planUsage = rememberPlanUsage(state.containers.map { it.baseUrl })
        PlanUsageSheet(planUsage, onDismiss = { showPlanUsage = false })
    }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val selected = state.selectedContainer
    val snapshot = state.snapshot
    // Synced prefs (iOS AppModel.syncPrefs): server theme/skin win when the server keeps prefs.
    val syncedTheme: (ThemeMode) -> Unit = { mode -> onTheme(mode); InboxPrefsSync.push(selected?.baseUrl, mode, state.skinMode) }
    val syncedSkin: (SkinMode) -> Unit = { skin -> onSkin(skin); InboxPrefsSync.push(selected?.baseUrl, state.themeMode, skin) }
    LaunchedEffect(selected?.baseUrl) {
        val base = selected?.baseUrl ?: return@LaunchedEffect
        InboxPrefsSync.pull(base, state.themeMode, state.skinMode, onTheme, onSkin)
    }
    var members by remember(selected?.id) { mutableStateOf<InboxMembersResponse?>(null) }
    LaunchedEffect(selected?.id) {
        val sel = selected ?: return@LaunchedEffect
        members = runCatching { InboxApi.members(sel.baseUrl, sel.id) }.getOrNull()
    }
    if (selected != null && subPage == "notifications") {
        InboxNotificationPrefsScreen(selected, onBack = { subPage = null })
        return
    }
    if (selected != null && subPage == "routines") {
        InboxRoutinesScreen(
            selected, onBack = { subPage = null }, onOpenTask = onOpenTask,
            agents = snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null }.map { RoutineAssignee(it.id, it.alias) },
        )
        return
    }
    if (selected != null && (subPage == "budgets" || subPage == "worktrees")) {
        ProjectBudgetsScreen(selected, worktrees = subPage == "worktrees", onBack = { subPage = null })
        return
    }

    Scaffold(
        containerColor = p.bg,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    title = { Text("Settings", style = ltype(LType.Headline), color = p.text) },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg),
                    navigationIcon = {
                        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text("Done", style = ltype(LType.BodyEmph), color = p.accent)
                        }
                    },
                )
                LDivider()
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.xl),
        ) {
            if (selected != null) {
                item { GroupHeader("Project") }
                item {
                    LSection("General") {
                        RowsCard {
                            val alias = selected.humanAlias ?: "Paired human"
                            LRow(
                                title = alias,
                                subtitle = "Self-hosted — acting as the paired human",
                                leading = { LAvatar(alias, size = 28.dp) },
                            )
                            LDivider()
                            val projectIcon = if (savedIcon.first) savedIcon.second else snapshot?.container?.projectIcon
                            LRow(
                                title = "Project",
                                leading = { io.openorcha.mobile.ui.components.ProjectIconTile(projectIcon, size = 28.dp) },
                                trailing = { TrailingValue(snapshot?.container?.name ?: selected.displayName) },
                            )
                            LDivider()
                            LRow(
                                title = "Icon",
                                subtitle = "An emoji or an icon for this project",
                                onClick = { showIconSheet = true },
                                leading = { RowIcon(io.openorcha.mobile.ui.icons.ProjectGlyphs.vector("palette")!!) },
                                trailing = { TrailingValue(projectIconSummary(projectIcon), chevron = true) },
                            )
                        }
                    }
                }
                if (snapshot != null) {
                    item {
                        LSection("Execution") {
                            RowsCard {
                                val wakes = snapshot.container.wakesEnabled
                                LRow(
                                    title = "Notifier & autonomy",
                                    subtitle = "Pause agent wakes, choose how far agents go",
                                    onClick = { showExecution = true },
                                    leading = { RowIcon(OrchaIcons.PlayArrow, tint = if (wakes == false) p.warn else p.ok) },
                                    trailing = {
                                        TrailingValue(executionSummary(wakes, snapshot.container.autonomyLevel), chevron = true)
                                    },
                                )
                                LDivider()
                                LRow(
                                    title = "Routines",
                                    subtitle = "Recurring work on a schedule",
                                    onClick = { subPage = "routines" },
                                    leading = { RowIcon(OrchaIcons.Schedule) },
                                    trailing = { TrailingValue("", chevron = true) },
                                )
                                LDivider()
                                LRow(
                                    title = "Budgets & limits",
                                    subtitle = "Monthly spend limits and how many agents can run",
                                    onClick = { subPage = "budgets" },
                                    leading = { RowIcon(OrchaIcons.WarningAmber) },
                                    trailing = { TrailingValue("", chevron = true) },
                                )
                                LDivider()
                                LRow(
                                    title = "Agent worktrees",
                                    subtitle = "Clean up finished agent checkouts",
                                    onClick = { subPage = "worktrees" },
                                    leading = { RowIcon(OrchaIcons.Terminal) },
                                    trailing = { TrailingValue("", chevron = true) },
                                )
                            }
                        }
                    }
                    item {
                        val bound = InboxRepoBinding.bound(selected.id, snapshot.container.githubRepo)
                        LSection("GitHub") {
                            RowsCard {
                                LRow(
                                    title = "Repository",
                                    subtitle = if (bound == null) "Connect a repo to start work from issues and PRs" else null,
                                    onClick = { showConnectRepo = true },
                                    leading = { RowIcon(OrchaIcons.GitHub, tint = if (bound != null) p.accent else null) },
                                    trailing = { TrailingValue(bound ?: "Connect repo", chevron = true, mono = bound != null) },
                                )
                            }
                        }
                    }
                }
                item { GroupHeader("Access") }
                val roster = members
                if (roster != null) {
                    item { InboxMembersSection(roster, selected.humanAgentId) }
                }
                val humans = if (roster != null) emptyList() else snapshot?.agents.orEmpty().filter { it.kind == "human" && it.terminatedAt == null }
                if (humans.isNotEmpty()) {
                    item {
                        LSection("Members", count = humans.size) {
                            RowsCard {
                                humans.forEachIndexed { i, h ->
                                    if (i > 0) LDivider()
                                    val you = h.id == selected.humanAgentId
                                    LRow(
                                        title = h.githubLogin?.let { "@$it" } ?: h.alias,
                                        subtitle = if (h.githubLogin != null && h.githubLogin != h.alias) h.alias else null,
                                        leading = { LAvatar(h.githubLogin ?: h.alias, size = 28.dp) },
                                        trailing = {
                                            LTag(
                                                if (you) "you" else (h.memberRole?.takeIf { it.isNotBlank() } ?: "member"),
                                                tint = if (you) p.violet else null,
                                                dot = you,
                                            )
                                        },
                                    )
                                }
                            }
                            androidx.compose.foundation.layout.Spacer(Modifier.size(LSpace.s))
                            Footnote("Invites and role changes are managed from the portal.")
                        }
                    }
                }
            } else {
                item { GroupHeader("Access") }
            }

            item {
                val groups = groupByServer(state.containers)
                LSection("Devices and pairing", count = groups.size) {
                  Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    groups.forEach { g ->
                        DeviceCard(
                            group = g,
                            onOpen = { onOpen(g.primary.id) },
                            onForget = { g.ids.forEach(onForget) },
                            onToken = { tokenDialogFor = g },
                            onRemote = { remoteDialogFor = g },
                        )
                    }
                    LButton(
                        "Add a server",
                        onAdd,
                        icon = OrchaIcons.Add,
                        kind = LButtonKind.Secondary,
                        size = LSize.Small,
                    )
                    Footnote(
                        "Cloud deployments authenticate every request with the team access token — update it here when your admin rotates it; it applies to every project on that server. " +
                            "The remote address is for self-hosted boxes: add the computer's Tailscale address and the app fails over to whichever answers.",
                    )
                  }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }

            item { GroupHeader("Personal") }
            item {
                // Plan usage (desktop Usage panel parity) — Claude and Codex plan limits.
                LSection("Plan usage") {
                    RowsCard {
                        LRow(
                            title = "Plan usage",
                            subtitle = "Claude and Codex limits from the Embodent desktop app",
                            onClick = { showPlanUsage = true },
                            leading = { RowIcon(OrchaIcons.Schedule) },
                            trailing = { TrailingValue("", chevron = true) },
                        )
                    }
                }
            }
            item {
                LSection("Appearance") {
                    LCard {
                        LSegmented(THEME_OPTIONS, state.themeMode, syncedTheme)
                        Text(
                            "System follows your phone's setting. Changes apply instantly.",
                            style = ltype(LType.Meta), color = p.muted,
                            modifier = Modifier.padding(top = LSpace.m),
                        )
                    }
                }
            }
            item {
                LSection("Notifications") {
                    RowsCard {
                        if (selected != null) {
                            LRow(
                                title = "Notification settings",
                                subtitle = "What reaches you, where — pause, mute and quiet hours",
                                onClick = { subPage = "notifications" },
                                leading = { RowIcon(OrchaIcons.Inbox) },
                                trailing = { TrailingValue("", chevron = true) },
                            )
                            LDivider()
                        }
                        LRow(
                            title = "System notification settings",
                            subtitle = "Sounds and banners for Embodent on this phone",
                            onClick = {
                                runCatching {
                                    context.startActivity(
                                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                    )
                                }
                            },
                            leading = { RowIcon(OrchaIcons.Settings) },
                            trailing = { Icon(OrchaIcons.OpenInNew, null, tint = p.faint, modifier = Modifier.size(16.dp)) },
                        )
                    }
                }
            }
            item {
                LSection("Interface") {
                    LCard {
                        LSegmented(SKIN_OPTIONS, state.skinMode, syncedSkin)
                        Text(
                            state.skinMode.blurb, style = ltype(LType.Meta), color = p.muted,
                            modifier = Modifier.padding(top = LSpace.m),
                        )
                    }
                }
            }
            item { AboutFooter() }
        }
    }

    // Sheets & dialogs are composed inside OrchaTheme's CompositionLocal scope, so they
    // re-read Orcha.palette / MaterialTheme on every theme switch (no stale scheme).
    if (showExecution && snapshot != null) {
        ContainerControlsSheet(
            wakesEnabled = snapshot.container.wakesEnabled ?: true,
            autonomyLevel = snapshot.container.autonomyLevel ?: "plan",
            containerActive = snapshot.container.status == "active",
            canAct = selected?.humanAgentId != null && onSetWakes != null,
            busy = state.actionInFlight,
            onDismiss = { showExecution = false },
            onSetWakes = { onSetWakes?.invoke(it) },
            onSetAutonomy = { onSetAutonomy?.invoke(it) },
        )
    }
    if (showIconSheet && selected != null) {
        ProjectIconSheet(
            container = selected,
            projectName = snapshot?.container?.name ?: selected.displayName,
            icon = if (savedIcon.first) savedIcon.second else snapshot?.container?.projectIcon,
            onDismiss = { showIconSheet = false },
            onSaved = { icon -> savedIcon = true to icon; onIconChanged() },
        )
    }
    if (showConnectRepo && selected != null) {
        InboxConnectRepoHost(
            state = state,
            onDismiss = { showConnectRepo = false },
            onSaved = { repo ->
                onRepoChanged(repo)
                scope.launch { snackbar.showSnackbar(repo?.let { "Repo connected — $it" } ?: "Repo unbound") }
            },
        )
    }
    remoteDialogFor?.let { g ->
        AddRemoteDialog(
            container = g.primary,
            onDismiss = { remoteDialogFor = null },
            onSave = { url -> g.ids.forEach { onSetRemoteUrl(it, url) }; remoteDialogFor = null },
        )
    }
    tokenDialogFor?.let { g ->
        AccessTokenDialog(
            container = g.primary,
            onDismiss = { tokenDialogFor = null },
            onSave = { token -> g.ids.forEach { onSetAccessToken(it, token) }; tokenDialogFor = null },
            onSignInAgain = { tokenDialogFor = null; onSignInAgain(g.primary.id) },
        )
    }
}

@Composable
private fun DeviceCard(
    group: ServerGroup,
    onOpen: () -> Unit,
    onForget: () -> Unit,
    onToken: () -> Unit,
    onRemote: () -> Unit,
) {
    val p = Orcha.palette
    val c = group.primary
    val hasToken = !c.accessToken.isNullOrBlank()
    val remote = c.remoteBaseUrl?.takeIf { it.isNotBlank() }
    RowsCard {
        LRow(
            title = group.title,
            subtitle = group.subtitle,
            onClick = onOpen.takeIf { group.projects.size == 1 },
            leading = { LAvatar(group.title, size = 28.dp) },
            trailing = {
                TextButton(onClick = onForget, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Disconnect", style = ltype(LType.Meta), fontWeight = FontWeight.Medium, color = p.danger)
                }
            },
        )
        LDivider()
        LRow(
            title = "Access token",
            onClick = onToken,
            leading = { RowIcon(OrchaIcons.Key, tint = if (hasToken) p.accent else null) },
            trailing = { TrailingValue(if (hasToken) "Set" else "Not set", chevron = true) },
        )
        LDivider()
        LRow(
            title = "Remote address",
            onClick = onRemote,
            leading = { RowIcon(OrchaIcons.Public, tint = if (remote != null) p.accent else null) },
            trailing = { TrailingValue(remote ?: "None", chevron = true, mono = remote != null) },
        )
    }
}

/** PROJECT / ACCESS / PERSONAL — the web's group label above its sections. */
@Composable
private fun GroupHeader(title: String) {
    Text(
        title.uppercase(),
        style = ltype(LType.Micro).copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
        color = Orcha.palette.faint,
        modifier = Modifier.padding(horizontal = 4.dp).semantics { heading() },
    )
}

/** Hairline-separated rows on one panel card. */
@Composable
private fun RowsCard(content: @Composable () -> Unit) {
    LCard(padding = 0.dp) { content() }
}

@Composable
private fun RowIcon(icon: ImageVector, tint: Color? = null) {
    val p = Orcha.palette
    Box(
        Modifier
            .size(26.dp)
            .background(p.surface2, RoundedCornerShape(7.dp))
            .border(1.dp, p.border, RoundedCornerShape(7.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint ?: p.text2, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun TrailingValue(text: String, chevron: Boolean = false, mono: Boolean = false) {
    val p = Orcha.palette
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text,
            style = ltype(if (mono) LType.Mono else LType.Meta),
            color = p.muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (chevron) Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun Footnote(text: String) {
    Text(
        text, style = ltype(LType.Micro), color = Orcha.palette.muted,
        modifier = Modifier.padding(horizontal = 4.dp),
    )
}

@Composable
private fun AboutFooter() {
    val p = Orcha.palette
    Column(
        Modifier.fillMaxWidth().padding(top = LSpace.s, bottom = LSpace.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BrandMark(size = 36.dp)
        Text("Embodent", style = ltype(LType.BodyEmph), color = p.text)
        Text("Version ${BuildConfig.VERSION_NAME}", style = ltype(LType.Meta), color = p.muted)
    }
}

/**
 * LAN↔remote failover: set/clear the container's second address. Validated via
 * `OrchaServerAddress.normalize` — blank clears it.
 */
@Composable
private fun AddRemoteDialog(container: StoredContainer, onDismiss: () -> Unit, onSave: (String?) -> Unit) {
    val p = Orcha.palette
    var text by remember { mutableStateOf(container.remoteBaseUrl.orEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Remote address", style = ltype(LType.Headline), color = p.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "A second address for ${container.displayName} (e.g. a Tailscale name). The app fails over to it when the local address doesn't answer. Leave blank to remove it.",
                    style = ltype(LType.Meta), color = p.muted,
                )
                OrchaField(
                    text, { text = it; error = null },
                    label = "Remote address",
                    placeholder = "my-mac.tailnet.ts.net:8001",
                )
                error?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val trimmed = text.trim()
                if (trimmed.isBlank()) {
                    onSave(null)
                    return@TextButton
                }
                runCatching { io.openorcha.mobile.data.OrchaServerAddress.normalize(trimmed) }
                    .onSuccess { onSave(it) }
                    .onFailure { error = it.message ?: "That doesn't look like an address." }
            }) { Text("Save", color = p.accent, fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = p.muted) } },
        containerColor = p.surface,
        titleContentColor = p.text,
        textContentColor = p.text2,
        shape = RoundedCornerShape(12.dp),
    )
}

/** Set (or clear, blank) one paired container's stored bearer token directly. */
@Composable
private fun AccessTokenDialog(
    container: StoredContainer,
    onDismiss: () -> Unit,
    onSave: (String?) -> Unit,
    onSignInAgain: () -> Unit,
) {
    val p = Orcha.palette
    var text by remember { mutableStateOf(container.accessToken.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Access token", style = ltype(LType.Headline), color = p.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Sent with every request to ${container.displayName}. \"Sign in again\" gets a fresh one through GitHub — paste one here only if your admin gave you a token. Leave blank to remove it.",
                    style = ltype(LType.Meta), color = p.muted,
                )
                OrchaField(text, { text = it }, label = "Access token", masked = true)
                LButton("Sign in again", onSignInAgain, icon = OrchaIcons.GitHub, kind = LButtonKind.Ghost, size = LSize.Small)
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text.trim().ifBlank { null }) }) {
                Text("Save", color = p.accent, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = p.muted) } },
        containerColor = p.surface,
        titleContentColor = p.text,
        textContentColor = p.text2,
        shape = RoundedCornerShape(12.dp),
    )
}

/** The Settings › Icon row's value: what the icon is, in words (never a raw shape). */
internal fun projectIconSummary(icon: io.openorcha.mobile.domain.ProjectIconValue?): String = when (icon) {
    null -> "Default"
    is io.openorcha.mobile.domain.ProjectIconValue.Emoji -> icon.value
    is io.openorcha.mobile.domain.ProjectIconValue.Glyph ->
        icon.name.replaceFirstChar { it.uppercase() } +
            (icon.color?.let { " · " + io.openorcha.mobile.domain.ProjectIcons.HUE_NAMES.getOrNull(it).orEmpty() } ?: "")
}
