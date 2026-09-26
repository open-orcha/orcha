package io.openorcha.mobile.ui.screens

/** PR detail — Android parity of iOS `GitHubPullDetailScreen.swift`, PLUS Android's own
 *  diff viewer (the #177 gap iOS doesn't have): expanding a changed file renders its
 *  unified-diff patch via [io.openorcha.mobile.ui.components.DiffViewer]. Sectioned:
 *  description (raw markdown text), checks (per-run glyphs), changed files (+/- counts,
 *  expandable diff, truncated note), and an open-on-GitHub link. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubPullDetail
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.domain.GitHubPullDetailPhase
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.CheckRunGlyph
import io.openorcha.mobile.ui.components.ChecksChip
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.MergeStateChip
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitHubPullDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onStart: (agentId: String?) -> Unit,
) {
    val p = Orcha.palette
    val number = state.githubPullNumber ?: 0
    var showStartSheet by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text("PR #$number") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
                actions = {
                    if (state.githubPullDetailPhase is GitHubPullDetailPhase.Loaded) {
                        TextButton(onClick = { showStartSheet = true }, enabled = !state.actionInFlight) { Text("Start") }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (val phase = state.githubPullDetailPhase) {
                is GitHubPullDetailPhase.Loading -> GitHubPullLoading()
                is GitHubPullDetailPhase.Unavailable -> PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh) {
                    GitHubUnavailableState(phase.reason, phase.detail)
                }
                is GitHubPullDetailPhase.Failed -> PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh) {
                    GitHubFailedState(phase.message, onRefresh)
                }
                is GitHubPullDetailPhase.Loaded -> PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh) {
                    PullDetailBody(phase.pull)
                }
            }
        }
    }

    if (showStartSheet) {
        GitHubStartSheet(
            kind = GitHubHubKind.Pulls,
            number = number,
            agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null },
            busy = state.actionInFlight,
            onDismiss = { showStartSheet = false },
            onConfirm = { agentId -> showStartSheet = false; onStart(agentId) },
        )
    }
}

@Composable
private fun GitHubPullLoading() {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Skeleton(height = 60.dp)
        Skeleton(height = 160.dp)
        Skeleton(height = 120.dp)
    }
}

@Composable
private fun PullDetailBody(pull: GitHubPullDetail) {
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { PullHeader(pull) }
        if (pull.bodyMarkdown.isNotBlank()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionH("Description")
                    OrchaCard { MarkdownText(pull.bodyMarkdown) }
                }
            }
        }
        item { ChecksSection(pull.checks) }
        item { FilesSection(pull.files, pull.htmlUrl) }
        pull.htmlUrl?.let { url -> item { OpenOnGitHubLink(url) } }
    }
}

@Composable
private fun PullHeader(pull: GitHubPullDetail) {
    val p = Orcha.palette
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(pull.title, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.W700), color = p.text)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusPill(if (pull.draft) "draft" else pull.state, StatusDomain.Task)
            ChecksChip(pull.checks)
            MergeStateChip(pull.mergeableState)
        }
        // base ← head, mirroring GitHub's own "into base from head" framing.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(pull.base, style = branchStyle, color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(OrchaIcons.ArrowBack, contentDescription = null, tint = p.muted, modifier = Modifier.size(14.dp))
            Text(pull.head, style = branchStyle, color = p.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            pull.authorLogin?.let { author ->
                Avatar(author, human = true, size = AvatarSize.Sm)
                Text(author, style = MaterialTheme.typography.bodyMedium, color = p.text2)
            }
            // The reviewers tag is the flexible member — unbounded it squeezed the
            // "updated" text to zero width (one character per line, stretching the row).
            if (pull.requestedReviewers.isNotEmpty()) {
                MetaTag(
                    "reviewers: ${pull.requestedReviewers.joinToString(", ")}",
                    modifier = Modifier.weight(1f, fill = false),
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            Text(
                MobileUx.agoLabel(pull.updatedAt)?.let { "updated $it" } ?: "",
                style = MaterialTheme.typography.labelMedium, color = p.faint,
                maxLines = 1, softWrap = false,
            )
        }
    }
}

private val branchStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W600, fontSize = 12.sp)

@Composable
private fun ChecksSection(checks: GitHubChecks) {
    val p = Orcha.palette
    val summary = GitHubHubUx.checksSummary(checks)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionH("Checks · ${summary.label}")
        OrchaCard {
            if (checks.runs.isEmpty()) {
                Text(
                    if (summary.hasChecks) "No per-run detail reported." else "No checks are configured on this repository.",
                    color = p.muted,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    checks.runs.forEach { run ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CheckRunGlyph(run)
                            Text(
                                run.name.ifEmpty { "(unnamed check)" }, color = p.text, maxLines = 1,
                                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                            )
                            run.conclusion?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = p.muted) }
                        }
                    }
                }
            }
        }
    }
}

