package io.openorcha.mobile.ui.screens

/**
 * Agent "History" — config revisions (web `AgentConfigHistory` / iOS
 * `AgentConfigHistoryScreen` parity): who changed which setting when, each revision's
 * before → after, and "Restore this version" (confirm with the diff first; a restore
 * creates a NEW revision, history is never rewritten). Presented full screen over agent
 * detail, so no extra route is needed.
 */

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.openorcha.mobile.data.ConfigFieldChangeDto
import io.openorcha.mobile.data.ConfigRevisionDetailDto
import io.openorcha.mobile.data.ConfigRevisionDto
import io.openorcha.mobile.data.getConfigRevision
import io.openorcha.mobile.data.getConfigRevisions
import io.openorcha.mobile.data.restoreConfigRevision
import io.openorcha.mobile.domain.AgentConfigHistoryUx
import io.openorcha.mobile.domain.ConnectionErrorCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.AgentSliceStore
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

/**
 * @param actorId the paired human (null = can't write).
 * @param canRestore owner-or-grant gate (manage_agents or manage_autonomy).
 * @param onRestored refresh agent detail after a successful restore.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentConfigHistorySheet(
    baseUrl: String,
    agentId: String,
    alias: String,
    actorId: String?,
    canRestore: Boolean,
    onDismiss: () -> Unit,
    onRestored: () -> Unit,
) {
    val p = Orcha.palette
    val revisions = remember(agentId) { mutableStateListOf<ConfigRevisionDto>() }
    var latest by remember(agentId) { mutableStateOf<Int?>(null) }
    var nextBefore by remember(agentId) { mutableStateOf<Int?>(null) }
    var loaded by remember(agentId) { mutableStateOf(false) }
    var error by remember(agentId) { mutableStateOf<String?>(null) }
    var notice by remember(agentId) { mutableStateOf<String?>(null) }
    var expanded by remember(agentId) { mutableStateOf<Int?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    suspend fun loadPage(before: Int?) {
        runCatching { AgentSliceStore.api.getConfigRevisions(baseUrl, agentId, before) }
            .onSuccess { page ->
                if (before == null) revisions.clear()
                revisions.addAll(page.revisions)
                latest = page.latestRevisionNo ?: latest
                nextBefore = page.nextBefore
                error = null
            }
            .onFailure { error = ConnectionErrorCopy.friendly(it) }
        loaded = true
    }

    LaunchedEffect(baseUrl, agentId, reloadKey) { loadPage(null) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            containerColor = p.bg,
            topBar = {
                Column {
                    CenterAlignedTopAppBar(
                        colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg, titleContentColor = p.text),
                        title = { Text("History", style = ltype(LType.Headline)) },
                        navigationIcon = { IconButton(onClick = onDismiss) { Icon(OrchaIcons.Close, "Close history", tint = p.text2) } },
                        actions = {
                            IconButton(onClick = { reloadKey++ }) { Icon(OrchaIcons.Refresh, "Refresh history", tint = p.text2) }
                        },
                    )
                    LDivider()
                }
            },
        ) { padding ->
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(LSpace.l),
                verticalArrangement = Arrangement.spacedBy(LSpace.s),
            ) {
                notice?.let { n -> item(key = "notice") { Banner(BannerKind.Info, n) } }
                error?.let { e ->
                    item(key = "error") { Banner(BannerKind.Danger, e, action = "Retry", onAction = { reloadKey++ }) }
                }
                if (!loaded && error == null) {
                    item(key = "loading") {
                        Box(Modifier.fillMaxWidth().heightIn(min = 120.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(
                                color = p.accent,
                                modifier = Modifier.size(24.dp).semantics { contentDescription = "Loading history" },
                            )
                        }
                    }
                } else if (loaded && revisions.isEmpty() && error == null) {
                    item(key = "empty") {
                        LEmptyState(icon = OrchaIcons.Schedule, title = "No history yet", message = "Changes to $alias's settings show up here.")
                    }
                }
                items(revisions, key = { it.revisionNo }) { rev ->
                    ConfigRevisionCard(
                        baseUrl = baseUrl,
                        agentId = agentId,
                        revision = rev,
                        isLatest = rev.revisionNo == latest,
                        expanded = expanded == rev.revisionNo,
                        actorId = actorId,
                        canRestore = canRestore,
                        onToggle = { expanded = if (expanded == rev.revisionNo) null else rev.revisionNo },
                        onRestored = { msg ->
                            notice = msg
                            expanded = null
                            reloadKey++
                            onRestored()
                        },
                        onFailed = { notice = it },
                    )
                }
                nextBefore?.let { before ->
                    item(key = "older") {
                        LButton(
                            "Load older changes",
                            { scope.launch { loadPage(before) } },
                            Modifier.fillMaxWidth(),
                            kind = LButtonKind.Ghost,
                            size = LSize.Small,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ConfigRevisionCard(
    baseUrl: String,
    agentId: String,
    revision: ConfigRevisionDto,
    isLatest: Boolean,
    expanded: Boolean,
    actorId: String?,
    canRestore: Boolean,
    onToggle: () -> Unit,
    onRestored: (String) -> Unit,
    onFailed: (String) -> Unit,
) {
    val p = Orcha.palette
    var detail by remember(revision.revisionNo) { mutableStateOf<ConfigRevisionDetailDto?>(null) }
    var detailFailed by remember(revision.revisionNo) { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var restoring by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val expandable = revision.kind != "initial" || !isLatest

    if (expanded && !isLatest) {
        LaunchedEffect(revision.revisionNo) {
            if (detail == null) {
                runCatching { AgentSliceStore.api.getConfigRevision(baseUrl, agentId, revision.revisionNo) }
                    .onSuccess { detail = it }
                    .onFailure { detailFailed = true }
            }
        }
    }

    LCard(padding = 0.dp) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(enabled = expandable, role = Role.Button, onClick = onToggle)
                .semantics { if (expandable) stateDescription = if (expanded) "Expanded" else "Collapsed" }
                .padding(LSpace.m),
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(AgentConfigHistoryUx.sentence(revision), style = ltype(LType.Body), color = p.text)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("#${revision.revisionNo}", style = ltype(LType.Mono), color = p.faint)
                    MobileUx.agoLabel(revision.createdAt)?.let { Text(it, style = ltype(LType.Micro), color = p.faint) }
                    if (isLatest) LTag("Current")
                }
            }
            if (expandable) {
                Icon(
                    OrchaIcons.ChevronRight, contentDescription = null, tint = p.faint,
                    modifier = Modifier.size(16.dp).rotate(if (expanded) 90f else 0f),
                )
            }
        }
        if (expanded) {
            LDivider()
            Column(Modifier.fillMaxWidth().padding(LSpace.m), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                revision.reason?.takeIf { it.isNotBlank() }?.let { Text("“$it”", style = ltype(LType.Meta), color = p.text2) }
                revision.changes.forEach { ChangeRow(it) }
                if (!isLatest) {
                    val d = detail
                    when {
                        d != null && d.restoreBlocked.isNotEmpty() -> Text(
                            "Can't restore: " + d.restoreBlocked.joinToString("; ") { "${AgentConfigHistoryUx.fieldLabel(it.field)} ${it.reason}" } + ".",
                            style = ltype(LType.Micro), color = p.muted,
                        )
                        d != null && d.restorePreview.isEmpty() -> Text(
                            "The current configuration matches this version.", style = ltype(LType.Micro), color = p.muted,
                        )
                        d != null -> {
                            Text(
                                "Restoring changes " + d.restorePreview.joinToString(", ") { AgentConfigHistoryUx.fieldLabel(it.field).lowercase() },
                                style = ltype(LType.Micro), color = p.muted,
                            )
                            if (canRestore && actorId != null) {
                                LButton(
                                    "Restore this version", { confirming = true },
                                    icon = OrchaIcons.Refresh, size = LSize.Small, enabled = !restoring,
                                )
                            } else {
                                Text("Needs the 'manage agents' permission", style = ltype(LType.Micro), color = p.faint)
                            }
                        }
                        detailFailed -> Text("Couldn't compare with the current configuration.", style = ltype(LType.Micro), color = p.muted)
                        else -> Text("Checking against the current configuration…", style = ltype(LType.Micro), color = p.faint)
                    }
                }
            }
        }
    }

    val d = detail
    if (confirming && d != null && actorId != null) {
        AlertDialog(
            onDismissRequest = { if (!restoring) confirming = false },
            title = { Text("Restore revision #${revision.revisionNo}?", style = ltype(LType.Headline), color = p.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(LSpace.xs)) {
                    d.restorePreview.forEach {
                        val field = AgentConfigHistoryUx.fieldLabel(it.field)
                        val before = AgentConfigHistoryUx.value(it.field, it.current)
                        val after = AgentConfigHistoryUx.value(it.field, it.target)
                        Text(
                            if (it.field == "system_prompt") "$field: replaced with this version's prompt" else "$field: $before → $after",
                            style = ltype(LType.Meta), color = p.text2,
                        )
                    }
                }
            },
            confirmButton = {
                LButton(
                    "Restore",
                    {
                        restoring = true
                        scope.launch {
                            runCatching { AgentSliceStore.api.restoreConfigRevision(baseUrl, agentId, revision.revisionNo, actorId, null) }
                                .onSuccess { r ->
                                    val from = r.restoredFrom ?: revision.revisionNo
                                    onRestored(if (r.applied.isEmpty()) "Already matches #$from" else "Restored from #$from")
                                }
                                .onFailure { onFailed("Restore failed — " + ConnectionErrorCopy.friendly(it)) }
                            restoring = false
                            confirming = false
                        }
                    },
                    kind = LButtonKind.Primary,
                    enabled = !restoring,
                )
            },
            dismissButton = { LButton("Cancel", { confirming = false }, kind = LButtonKind.Ghost, enabled = !restoring) },
            containerColor = p.surface,
        )
    }
}

@Composable
private fun ChangeRow(change: ConfigFieldChangeDto) {
    val p = Orcha.palette
    val label = AgentConfigHistoryUx.fieldLabel(change.field)
    val before = AgentConfigHistoryUx.value(change.field, change.before)
    val after = AgentConfigHistoryUx.value(change.field, change.after)
    val long = change.field == "system_prompt"
    Column(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            contentDescription = if (long) "$label changed" else "$label: $before to $after"
        },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label, style = ltype(LType.Micro), color = p.muted)
        if (long) {
            Text(after, style = ltype(LType.Meta), color = p.text2, maxLines = 4)
        } else {
            Text("$before → $after", style = ltype(LType.Meta), color = p.text)
        }
    }
}
