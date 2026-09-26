package io.openorcha.mobile.ui.screens

/** The GitHub hub list — Android parity of iOS `GitHubHubScreen.swift`. Segmented
 *  Issues | Pull requests tabs, Open / Mine filters, compact rows (type icon, number,
 *  title, labels/reviewers, checks summary, merge state, relative time), and a Start
 *  affordance per row (tap → unassigned; long-press / menu → agent picker). The whole
 *  surface degrades to a friendly "connect a repo" state on `available:false` / 404. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.GitHubIssueRow
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.domain.GitHubHubFilter
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.domain.GitHubIssuesPhase
import io.openorcha.mobile.domain.GitHubPullsPhase
import io.openorcha.mobile.domain.PullsInvolvement
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.SegControl
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitHubHubScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onSelectKind: (GitHubHubKind) -> Unit,
    onSelectFilter: (GitHubHubFilter) -> Unit,
    onRefresh: () -> Unit,
    onOpenIssue: (Int) -> Unit,
    onOpenPull: (Int) -> Unit,
    onStartIssue: (GitHubIssueRow, agentId: String?) -> Unit,
    onStartPull: (GitHubPullRow, agentId: String?) -> Unit,
    onPullsAuthorChange: (String) -> Unit,
    onPullsQueryChange: (String) -> Unit,
    onSelectPullsInvolvement: (PullsInvolvement) -> Unit,
    onLoadMorePulls: () -> Unit,
) {
    val p = Orcha.palette
    var startTarget by remember { mutableStateOf<GitHubStartTarget?>(null) }
    val boundRepo = when (state.githubHubKind) {
        GitHubHubKind.Pulls -> (state.githubPullsPhase as? GitHubPullsPhase.Loaded)?.repo
        GitHubHubKind.Issues -> (state.githubIssuesPhase as? GitHubIssuesPhase.Loaded)?.repo
    } ?: state.snapshot?.container?.githubRepo

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text("GitHub") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SegControl(
                    options = GitHubHubKind.entries.map { it.title },
                    selected = GitHubHubKind.entries.indexOf(state.githubHubKind),
                    onSelect = { onSelectKind(GitHubHubKind.entries[it]) },
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GitHubHubFilter.entries.forEach { f ->
                        GitHubFilterChip(label = f.label, on = state.githubHubFilter == f) { onSelectFilter(f) }
                    }
                    Spacer(Modifier.weight(1f))
                    if (boundRepo != null) {
                        Text(
                            boundRepo, style = MaterialTheme.typography.labelSmall, color = p.faint,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (state.githubHubKind == GitHubHubKind.Pulls) {
                    val loaded = state.githubPullsPhase as? GitHubPullsPhase.Loaded
                    GitHubPullsFilterRow(
                        filter = state.githubPullsFilter,
                        login = githubLoginOf(state),
                        identityDetail = loaded?.identityDetail,
                        // Author picker options: the logins visible in the loaded page —
                        // no extra endpoint, and it grows as the user pages/loosens filters.
                        authorOptions = loaded?.pulls.orEmpty()
                            .mapNotNull { it.authorLogin }.distinct().sorted(),
                        onAuthorChange = onPullsAuthorChange,
                        onQueryChange = onPullsQueryChange,
                        onSelectInvolvement = onSelectPullsInvolvement,
                    )
                }
            }
            PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh, modifier = Modifier.weight(1f, fill = true)) {
                when (state.githubHubKind) {
                    GitHubHubKind.Pulls -> PullsList(state, onOpenPull, onRefresh, onLoadMorePulls) { pull -> startTarget = GitHubStartTarget.ForPull(pull) }
                    GitHubHubKind.Issues -> IssuesList(state, onOpenIssue, onRefresh) { issue -> startTarget = GitHubStartTarget.ForIssue(issue) }
                }
            }
        }
    }

    startTarget?.let { target ->
        GitHubStartSheet(
            kind = target.kind,
            number = target.number,
            agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null },
            busy = state.actionInFlight,
            onDismiss = { startTarget = null },
            onConfirm = { agentId ->
                startTarget = null
                when (target) {
                    is GitHubStartTarget.ForPull -> onStartPull(target.pull, agentId)
                    is GitHubStartTarget.ForIssue -> onStartIssue(target.issue, agentId)
                }
            },
        )
    }
}

private sealed class GitHubStartTarget {
    abstract val kind: GitHubHubKind
    abstract val number: Int
    data class ForPull(val pull: GitHubPullRow) : GitHubStartTarget() {
        override val kind = GitHubHubKind.Pulls
        override val number = pull.number
    }
    data class ForIssue(val issue: GitHubIssueRow) : GitHubStartTarget() {
        override val kind = GitHubHubKind.Issues
        override val number = issue.number
    }
}

@Composable
private fun PullsList(state: OrchaUiState, onOpen: (Int) -> Unit, onRefresh: () -> Unit, onLoadMore: () -> Unit, onStart: (GitHubPullRow) -> Unit) {
    when (val phase = state.githubPullsPhase) {
        is GitHubPullsPhase.Idle, is GitHubPullsPhase.Loading -> GitHubLoadingList()
        is GitHubPullsPhase.Unavailable -> GitHubUnavailableState(phase.reason, phase.detail)
        is GitHubPullsPhase.Failed -> GitHubFailedState(phase.message, onRefresh)
        is GitHubPullsPhase.Loaded -> {
            val visible = GitHubHubUx.filterPulls(phase.pulls, state.githubHubFilter, githubLoginOf(state))
            ListScroll(isEmpty = visible.isEmpty(), emptyNoun = "pull requests", mine = state.githubHubFilter == GitHubHubFilter.Mine) {
                items(visible, key = { it.number }) { pull ->
                    GitHubPullRowCard(pull = pull, onClick = { onOpen(pull.number) }, onStart = { onStart(pull) })
                }
                if (visible.isNotEmpty() && phase.hasMore) {
                    item {
                        GitHubLoadMoreFooter(
                            shown = phase.pulls.size, totalCount = phase.totalCount,
                            hasMore = phase.hasMore, loading = phase.loadingMore, onLoadMore = onLoadMore,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun IssuesList(state: OrchaUiState, onOpen: (Int) -> Unit, onRefresh: () -> Unit, onStart: (GitHubIssueRow) -> Unit) {
    when (val phase = state.githubIssuesPhase) {
        is GitHubIssuesPhase.Idle, is GitHubIssuesPhase.Loading -> GitHubLoadingList()
        is GitHubIssuesPhase.Unavailable -> GitHubUnavailableState(phase.reason, phase.detail)
        is GitHubIssuesPhase.Failed -> GitHubFailedState(phase.message, onRefresh)
        is GitHubIssuesPhase.Loaded -> {
            val visible = GitHubHubUx.filterIssues(phase.issues, state.githubHubFilter, githubLoginOf(state))
            ListScroll(isEmpty = visible.isEmpty(), emptyNoun = "issues", mine = state.githubHubFilter == GitHubHubFilter.Mine) {
                items(visible, key = { it.number }) { issue ->
                    GitHubIssueRowCard(issue = issue, onClick = { onOpen(issue.number) }, onStart = { onStart(issue) })
                }
            }
        }
    }
}
