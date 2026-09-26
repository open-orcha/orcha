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
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

internal fun githubLoginOf(state: OrchaUiState): String? =
    state.snapshot?.agents?.firstOrNull { it.id == state.selectedContainer?.humanAgentId }?.githubLogin

@Composable
internal fun ListScroll(isEmpty: Boolean, emptyNoun: String, mine: Boolean, content: LazyListScope.() -> Unit) {
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (isEmpty) {
            item {
                OrchaCard {
                    Text(
                        if (mine) "Nothing here is assigned to you right now." else "No open $emptyNoun in this repository.",
                        color = p.muted,
                    )
                }
            }
        } else {
            content()
        }
    }
}

@Composable
internal fun GitHubLoadingList() {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(4) { Skeleton(height = 92.dp) }
    }
}

@Composable
internal fun GitHubUnavailableState(reason: String?, detail: String?) {
    StateLayout(
        title = if (reason == "not_found") "Not on GitHub" else "GitHub isn't connected",
        sub = GitHubHubUx.unavailableCopy(reason, detail),
    )
}

@Composable
internal fun GitHubFailedState(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Banner(BannerKind.Danger, message)
        NeutralButton("Try again", onRetry)
    }
}

/** `.chip` filter pill (Open / Mine, and the PR list's involvement toggles) — small
 *  toggle, accent when active. [disabled] (no known GitHub login) dims the chip and
 *  drops its click entirely — the caller renders the reason as a caption nearby (see
 *  [GitHubInvolvementRow]) rather than requiring a tap to discover it. */
@Composable
internal fun GitHubFilterChip(label: String, on: Boolean, disabled: Boolean = false, onClick: () -> Unit) {
    val p = Orcha.palette
    val fill = if (on) p.accentSoft else p.surface2
    val line = if (on) p.accentLine else p.border2
    Text(
        label,
        modifier = Modifier
            .alpha(if (disabled) 0.5f else 1f)
            .background(fill, RoundedCornerShape(999.dp))
            .border(BorderStroke(1.dp, line), RoundedCornerShape(999.dp))
            .clickable(enabled = !disabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        style = MaterialTheme.typography.labelMedium,
        color = if (on) p.accent else p.muted,
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
            Text(caption, style = MaterialTheme.typography.labelSmall, color = p.faint)
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
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            totalCount?.let { "$shown of ~$it" } ?: "$shown so far",
            style = MaterialTheme.typography.labelMedium, color = p.faint,
        )
        NeutralButton(if (loading) "Loading…" else "Load more", onLoadMore, enabled = !loading)
    }
}

/** Shared "open on GitHub" row — launches the browser (iOS parity: a `Link` styled as a
 *  tonal action). Detail screens for both issues and PRs use this. */
@Composable
internal fun OpenOnGitHubLink(url: String) {
    val p = Orcha.palette
    val context = LocalContext.current
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.surface2, RoundedCornerShape(12.dp))
            .border(BorderStroke(1.dp, p.border2), RoundedCornerShape(12.dp))
            .clickable { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Open on GitHub", style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.W600), color = p.text)
        Spacer(Modifier.weight(1f))
        Icon(OrchaIcons.OpenInNew, contentDescription = null, tint = p.text, modifier = Modifier.size(18.dp))
    }
}
