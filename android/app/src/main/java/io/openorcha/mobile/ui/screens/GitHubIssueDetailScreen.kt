package io.openorcha.mobile.ui.screens

/** Issue detail — Android parity of iOS `GitHubIssueDetailScreen.swift`. Title + state,
 *  labels + assignees, the raw markdown body, the recent comment thread (oldest-first),
 *  and an open-on-GitHub link. Start-from-detail lives in the top bar. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.CenterAlignedTopAppBar
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.GitHubComment
import io.openorcha.mobile.data.GitHubIssueDetail
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubIssueDetailPhase
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.GitHubLabelChip
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.GitHubStateTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitHubIssueDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onStart: (agentId: String?) -> Unit,
) {
    val p = Orcha.palette
    val number = state.githubIssueNumber ?: 0
    var showStartSheet by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg),
                    title = { Text("Issue #$number", style = ltype(LType.Headline), color = p.text) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back", tint = p.text2) } },
                    actions = {
                        if (state.githubIssueDetailPhase is GitHubIssueDetailPhase.Loaded) {
                            LButton(
                                "Start", { showStartSheet = true },
                                modifier = Modifier.padding(end = LSpace.s),
                                icon = OrchaIcons.PlayArrow, kind = LButtonKind.Primary, size = LSize.Small,
                                enabled = !state.actionInFlight,
                            )
                        }
                    },
                )
                LDivider()
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (val phase = state.githubIssueDetailPhase) {
                is GitHubIssueDetailPhase.Loading -> GitHubDetailLoading()
                is GitHubIssueDetailPhase.Unavailable -> PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh) {
                    GitHubUnavailableState(phase.reason, phase.detail)
                }
                is GitHubIssueDetailPhase.Failed -> PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh) {
                    GitHubFailedState(phase.message, onRefresh)
                }
                is GitHubIssueDetailPhase.Loaded -> PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh) {
                    IssueDetailBody(phase.issue)
                }
            }
        }
    }

    if (showStartSheet) {
        GitHubStartSheet(
            kind = GitHubHubKind.Issues,
            number = number,
            agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null },
            busy = state.actionInFlight,
            onDismiss = { showStartSheet = false },
            onConfirm = { agentId -> showStartSheet = false; onStart(agentId) },
        )
    }
}

@Composable
private fun GitHubDetailLoading() {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Skeleton(height = 60.dp)
        Skeleton(height = 160.dp)
    }
}

@Composable
private fun IssueDetailBody(issue: GitHubIssueDetail) {
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(LSpace.l),
        verticalArrangement = Arrangement.spacedBy(LSpace.xl),
    ) {
        item { IssueHeader(issue) }
        if (issue.bodyMarkdown.isNotBlank()) {
            item {
                LSection("Description") {
                    LCard { MarkdownText(issue.bodyMarkdown) }
                }
            }
        }
        item { SectionH("Comments", "${issue.commentsCount}") }
        if (issue.comments.isEmpty()) {
            item {
                LCard {
                    Text(
                        if (issue.commentsCount > 0) "The comment thread couldn't be loaded." else "No comments yet.",
                        color = p.muted,
                    )
                }
            }
        } else {
            if (issue.commentsCount > issue.comments.size) {
                item {
                    Text(
                        "Showing the most recent ${issue.comments.size} of ${issue.commentsCount} comments.",
                        style = ltype(LType.Micro), color = p.faint,
                    )
                }
            }
            items(issue.comments) { comment -> CommentCard(comment) }
        }
        issue.htmlUrl?.let { url -> item { OpenOnGitHubLink(url) } }
    }
}

@Composable
private fun IssueHeader(issue: GitHubIssueDetail) {
    val p = Orcha.palette
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(issue.title, style = ltype(LType.Title), color = p.text)
        GitHubStateTag(issue.state)
        if (issue.labels.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { issue.labels.forEach { GitHubLabelChip(it) } }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            issue.authorLogin?.let { author ->
                LAvatar(author, size = 20.dp)
                Text(author, style = ltype(LType.Meta), color = p.text2)
            }
            if (issue.assignees.isNotEmpty()) LTag("assigned: ${issue.assignees.joinToString(", ")}")
            Spacer(Modifier.weight(1f))
            Text(
                MobileUx.agoLabel(issue.updatedAt)?.let { "updated $it" } ?: "",
                style = ltype(LType.Micro), color = p.faint,
            )
        }
    }
}

@Composable
private fun CommentCard(comment: GitHubComment) {
    val p = Orcha.palette
    LCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LAvatar(comment.authorLogin ?: "?", size = 20.dp)
            Text(comment.authorLogin ?: "someone", style = ltype(LType.BodyEmph), color = p.text)
            Spacer(Modifier.weight(1f))
            Text(MobileUx.agoLabel(comment.createdAt) ?: "", style = ltype(LType.Micro), color = p.faint)
        }
        MarkdownText(comment.bodyMarkdown)
    }
}
