package io.openorcha.mobile.ui.screens

/* Connect repository (iOS ConnectRepoSheet.swift / portal home-github.js): loading →
   the graceful "GitHub isn't connected" off state, or a searchable repo list with the
   current binding checked and an Unbind row. Picking a row PUTs the binding. */

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.InboxApi
import io.openorcha.mobile.data.InboxGithubRepoDto
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.domain.RepoConnectLogic
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSearchField
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

private sealed class RepoPhase {
    data object Loading : RepoPhase()
    data object Unavailable : RepoPhase()
    data class Failed(val message: String) : RepoPhase()
    data class Ready(val repos: List<InboxGithubRepoDto>) : RepoPhase()
}

/**
 * [onSaved] receives the new binding (null = unbound) after a successful PUT; the caller
 * shows the toast ("Repo connected — owner/name" / "Repo unbound") and refreshes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxConnectRepoSheet(
    container: StoredContainer,
    boundRepo: String?,
    onDismiss: () -> Unit,
    onSaved: (String?) -> Unit,
) {
    val p = Orcha.palette
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var phase by remember { mutableStateOf<RepoPhase>(RepoPhase.Loading) }
    var query by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        phase = RepoPhase.Loading
        phase = runCatching { InboxApi.githubRepos(container.baseUrl, container.id) }
            .fold(
                onSuccess = { if (it.available) RepoPhase.Ready(it.repos) else RepoPhase.Unavailable },
                onFailure = { RepoPhase.Failed("Embodent couldn't be reached. Check the connection and try again.") },
            )
    }

    fun save(repo: String?) {
        if (saving) return
        saving = true
        error = null
        scope.launch {
            runCatching { InboxApi.setGithubRepo(container.baseUrl, container.id, repo) }
                .onSuccess { onSaved(it.repo) }
                .onFailure { error = "Couldn't save the repository — " + routineErrorText(it) + "." }
            saving = false
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = p.bg) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = LSpace.l).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            Text("Connect repository", style = ltype(LType.Headline), color = p.text)
            when (val ph = phase) {
                RepoPhase.Loading -> Text("Loading repositories…", style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(vertical = LSpace.xl))
                RepoPhase.Unavailable -> LEmptyState(
                    icon = OrchaIcons.GitHub,
                    title = "GitHub isn't connected on this server",
                    message = "An admin can install the Embodent GitHub App from the portal under Settings › GitHub.",
                )
                is RepoPhase.Failed -> LEmptyState(
                    icon = OrchaIcons.GitHub,
                    title = "Couldn't load repositories",
                    message = ph.message,
                    actionTitle = "Try again",
                    onAction = { reloadKey++ },
                )
                is RepoPhase.Ready -> {
                    Text(
                        "Bind this workspace to a repository the Embodent GitHub App is installed on.",
                        style = ltype(LType.Meta), color = p.muted,
                    )
                    if (ph.repos.isEmpty()) {
                        LEmptyState(icon = OrchaIcons.GitHub, title = "No repositories yet", message = "The App is installed, but on no repositories yet.")
                    } else {
                        LSearchField(query, { query = it }, "Search repositories")
                        val visible = RepoConnectLogic.filter(ph.repos, query)
                        if (visible.isEmpty()) {
                            Text("No repository matches “$query”.", style = ltype(LType.Meta), color = p.muted)
                        } else {
                            LCard(padding = 0.dp) {
                                LazyColumn(Modifier.heightIn(max = 380.dp)) {
                                    itemsIndexed(visible, key = { _, r -> r.fullName }) { i, repo ->
                                        if (i > 0) LDivider()
                                        RepoRow(repo, bound = repo.fullName == boundRepo, enabled = !saving) { save(repo.fullName) }
                                    }
                                }
                            }
                        }
                    }
                    if (boundRepo != null) {
                        LCard {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
                                Text(
                                    boundRepo, style = ltype(LType.Mono), color = p.text2, maxLines = 1,
                                    overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                                )
                                LButton(
                                    "Unbind", { save(null) },
                                    modifier = Modifier.semantics { contentDescription = "Unbind $boundRepo" },
                                    icon = OrchaIcons.Close, kind = LButtonKind.Danger, size = LSize.Small, enabled = !saving,
                                )
                            }
                        }
                    }
                }
            }
            error?.let { Banner(BannerKind.Danger, it) }
            LButton("Done", onDismiss, kind = LButtonKind.Secondary, modifier = Modifier.fillMaxWidth().padding(bottom = LSpace.l))
        }
    }
}

@Composable
private fun RepoRow(repo: InboxGithubRepoDto, bound: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val p = Orcha.palette
    val a11y = listOfNotNull(repo.fullName, "private".takeIf { repo.isPrivate }, "currently connected".takeIf { bound }).joinToString(", ")
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .background(if (bound) p.surface2 else Color.Transparent)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "Connect this repository", onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = a11y }
            .padding(LSpace.m),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        Icon(OrchaIcons.GitHub, null, tint = p.muted, modifier = Modifier.size(15.dp).padding(top = 2.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(repo.fullName, style = ltype(LType.Mono), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (repo.isPrivate) LTag("private", tint = p.warn)
            }
            repo.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = ltype(LType.Meta), color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (bound) Icon(OrchaIcons.Check, null, tint = p.accent, modifier = Modifier.size(16.dp))
    }
}

/** Just-saved bindings per project (cid → repo, "" = unbound), shown until the snapshot catches up. */
object InboxRepoBinding {
    private val saved = androidx.compose.runtime.mutableStateMapOf<String, String>()

    fun bound(cid: String, snapshotRepo: String?): String? =
        saved[cid]?.ifEmpty { null } ?: snapshotRepo?.takeIf { it.isNotBlank() && !saved.containsKey(cid) }

    fun record(cid: String, repo: String?) {
        saved[cid] = repo ?: ""
    }
}

/** Home's "Connect repo" chip host: the sheet, a toast via [onSaved], and the optimistic chip label. */
@Composable
fun InboxConnectRepoHost(state: io.openorcha.mobile.ui.OrchaUiState, onDismiss: () -> Unit, onSaved: (String?) -> Unit = {}) {
    val container = state.selectedContainer ?: return
    InboxConnectRepoSheet(
        container = container,
        boundRepo = InboxRepoBinding.bound(container.id, state.snapshot?.container?.githubRepo),
        onDismiss = onDismiss,
        onSaved = { repo ->
            InboxRepoBinding.record(container.id, repo)
            onDismiss()
            onSaved(repo)
        },
    )
}
