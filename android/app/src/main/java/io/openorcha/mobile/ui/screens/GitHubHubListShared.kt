package io.openorcha.mobile.ui.screens

/** Shared list chrome for the GitHub hub's Issues/Pulls segments: loading skeletons, the
 *  "connect a repo" off-state, the transport-failure retry panel, the empty-list card, and
 *  the Open/Mine filter pill. Split out of GitHubHubScreen.kt to keep that file lean. */

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.domain.GitHubPullsFilterState
import io.openorcha.mobile.domain.PullsInvolvement
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

internal fun githubLoginOf(state: OrchaUiState): String? =
    state.snapshot?.agents?.firstOrNull { it.id == state.selectedContainer?.humanAgentId }?.githubLogin

@Composable
internal fun ListScroll(isEmpty: Boolean, emptyNoun: String, mine: Boolean, content: LazyListScope.() -> Unit) {
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(vertical = LSpace.xs),
    ) {
        if (isEmpty) {
            item {
                LEmptyState(
                    icon = OrchaIcons.GitHub,
                    title = if (mine) "Nothing assigned to you" else "No open $emptyNoun",
                    message = if (mine) "Nothing here is assigned to you right now." else "No open $emptyNoun in this repository.",
                    modifier = Modifier.padding(top = 40.dp),
                )
            }
        } else {
            content()
        }
    }
}

@Composable
internal fun GitHubLoadingList() {
    Column(Modifier.fillMaxWidth().padding(LSpace.l), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
        repeat(6) { Skeleton(height = 56.dp) }
    }
}

@Composable
internal fun GitHubUnavailableState(reason: String?, detail: String?) {
    val (title, message) = githubUnavailableCopy(reason, detail)
    LEmptyState(
        icon = OrchaIcons.GitHub,
        title = title,
        message = message,
        modifier = Modifier.padding(top = 40.dp),
    )
}

internal const val GITHUB_APP_MISSING_TITLE = "GitHub isn't connected on this server"
internal const val GITHUB_APP_MISSING_MESSAGE = "An admin can install the Embodent GitHub App from the portal under Settings › GitHub."

/** True when the server can't talk to GitHub at all (no GitHub App installed / no
 *  credential) — as opposed to a repo not being bound, rate limits, etc. */
internal fun isGitHubAppMissing(reason: String?, detail: String?): Boolean {
    if (reason == "no_token" || reason == "app_not_installed" || reason == "not_configured") return true
    if (reason in setOf("repo_not_connected", "rate_limited", "not_found", "unreachable")) return false
    val d = detail?.lowercase() ?: return false
    return listOf("installation", "token", "github app", "wired", "not configured").any { it in d }
}

/** Title + message for an `available:false` state — friendly, no server jargon. */
internal fun githubUnavailableCopy(reason: String?, detail: String?): Pair<String, String> = when {
    isGitHubAppMissing(reason, detail) -> GITHUB_APP_MISSING_TITLE to GITHUB_APP_MISSING_MESSAGE
    reason == "not_found" -> "Not on GitHub" to GitHubHubUx.unavailableCopy(reason, detail)
    reason == "repo_not_connected" -> "No repository connected" to
        "No GitHub repository is connected to this project yet. Connect one from the Home tab to see its issues and pull requests here."
    else -> "GitHub isn't available" to GitHubHubUx.unavailableCopy(reason, detail).replace("this Embodent", "this server")
}

@Composable
internal fun GitHubFailedState(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(LSpace.l), verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
        Banner(BannerKind.Danger, message)
        LButton("Try again", onRetry, icon = OrchaIcons.Refresh, kind = LButtonKind.Secondary, size = LSize.Small)
    }
}

/** `.chip` filter pill (Open / Mine, and the PR list's involvement toggles) — small
 *  toggle, accent when active. [disabled] (no known GitHub login) dims the chip and
 *  drops its click entirely — the caller renders the reason as a caption nearby (see
 *  [GitHubInvolvementRow]) rather than requiring a tap to discover it. */
@Composable
internal fun GitHubFilterChip(label: String, on: Boolean, disabled: Boolean = false, onClick: () -> Unit) {
    LChip(
        label,
        modifier = Modifier.alpha(if (disabled) 0.5f else 1f),
        selected = on,
        onClick = if (disabled) null else onClick,
    )
}

/** The Pulls segment's compact filter row: an author picker (dropdown over the logins
 *  seen in the loaded list, free text still committed on IME search) + search text
 *  (both server-side, committed on submit so typing never spams a request per
 *  keystroke) and the mutually-exclusive "Assigned to me" / "My reviews" involvement
 *  chips. The chips disable themselves (dimmed, non-clickable) with a caption
 *  explaining why when [login] is unknown — the server can't resolve "me" without a
 *  `github_login` on file. */
@Composable
internal fun GitHubPullsFilterRow(
    filter: GitHubPullsFilterState,
    login: String?,
    identityDetail: String?,
    authorOptions: List<String> = emptyList(),
    onAuthorChange: (String) -> Unit,
    onQueryChange: (String) -> Unit,
    onSelectInvolvement: (PullsInvolvement) -> Unit,
) {
    val p = Orcha.palette
    var author by remember(filter.author) { mutableStateOf(filter.author) }
    var query by remember(filter.q) { mutableStateOf(filter.q) }
    var authorMenuOpen by remember { mutableStateOf(false) }
    val disabled = GitHubHubUx.involvementDisabled(login)

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) {
                GitHubCompactField(
                    author, { author = it },
                    placeholder = "Author", onSearch = { onAuthorChange(author) },
                    trailing = {
                        Icon(
                            OrchaIcons.ExpandMore, "Pick author",
                            tint = p.muted,
                            modifier = Modifier.size(16.dp).clickable { authorMenuOpen = !authorMenuOpen },
                        )
                    },
                )
                DropdownMenu(expanded = authorMenuOpen, onDismissRequest = { authorMenuOpen = false }) {
                    if (author.isNotBlank() || filter.author.isNotBlank()) {
                        DropdownMenuItem(
                            text = { Text("Anyone", color = p.muted) },
                            onClick = { authorMenuOpen = false; author = ""; onAuthorChange("") },
                        )
                    }
                    authorOptions.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option) },
                            onClick = { authorMenuOpen = false; author = option; onAuthorChange(option) },
                        )
                    }
                    if (authorOptions.isEmpty()) {
                        DropdownMenuItem(text = { Text("No authors in view yet", color = p.faint) }, onClick = { authorMenuOpen = false })
                    }
                }
            }
            GitHubCompactField(
                query, { query = it }, modifier = Modifier.weight(1f),
                placeholder = "Search", onSearch = { onQueryChange(query) },
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PullsInvolvement.entries.filter { it != PullsInvolvement.None }.forEach { involvement ->
                GitHubFilterChip(
                    label = involvement.label,
                    on = filter.involvement == involvement,
                    onClick = { onSelectInvolvement(involvement) },
                    disabled = disabled,
                )
            }
        }
        val caption = identityDetail ?: if (disabled) "Connect a GitHub login to use these filters." else null
        if (caption != null) {
            Text(caption, style = ltype(LType.Micro), color = p.faint)
        }
    }
}

/** Compact single-line filter field — the stock OutlinedTextField's 56dp minimum
 *  dwarfed the filter row ("author and search are big"); this is a 36dp-tall
 *  BasicTextField with the house surface/border treatment and IME-search commit. */
@Composable
internal fun GitHubCompactField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    onSearch: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val p = Orcha.palette
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = p.text),
        cursorBrush = SolidColor(p.accent),
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch?.invoke() }),
        decorationBox = { inner ->
            Row(
                Modifier
                    .background(p.surface2, RoundedCornerShape(8.dp))
                    .border(BorderStroke(1.dp, p.border), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty() && placeholder != null) {
                        Text(placeholder, style = MaterialTheme.typography.bodyMedium, color = p.faint, maxLines = 1)
                    }
                    inner()
                }
                trailing?.invoke()
            }
        },
    )
}

/** The PR list's "N of ~total" / "N so far" load-more footer — a tap fetches the next
 *  page and appends it. Renders nothing once [hasMore] is false (the list is exhausted
 *  or was never paginated). */
@Composable
internal fun GitHubLoadMoreFooter(shown: Int, totalCount: Int?, hasMore: Boolean, loading: Boolean, onLoadMore: () -> Unit) {
    if (!hasMore) return
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth().padding(LSpace.l), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            totalCount?.let { "$shown of ~$it" } ?: "$shown so far",
            style = ltype(LType.Micro), color = p.faint,
        )
        LButton(if (loading) "Loading…" else "Load more", onLoadMore, kind = LButtonKind.Secondary, size = LSize.Small, enabled = !loading)
    }
}

/** Shared "open on GitHub" row — launches the browser (iOS parity: a `Link` styled as a
 *  tonal action). Detail screens for both issues and PRs use this. */
@Composable
internal fun OpenOnGitHubLink(url: String) {
    val context = LocalContext.current
    LButton(
        "Open on GitHub",
        { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
        modifier = Modifier.fillMaxWidth(),
        icon = OrchaIcons.OpenInNew,
        kind = LButtonKind.Secondary,
    )
}
