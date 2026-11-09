package io.openorcha.mobile.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.CommentExpansion
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

const val COMMENT_TEXT_TAG = "comment-text"
const val COMMENT_TOGGLE_TAG = "comment-toggle"

private val TOP_EDGE = Rect(0f, 0f, 1f, 1f)

/** Where Show less scrolls back to. Put [commentRevealTarget] on the whole comment (author line included). */
@Stable
class CommentReveal internal constructor() {
    @OptIn(ExperimentalFoundationApi::class)
    internal val requester = BringIntoViewRequester()
}

@Composable
fun rememberCommentReveal(): CommentReveal = remember { CommentReveal() }

@OptIn(ExperimentalFoundationApi::class)
fun Modifier.commentRevealTarget(reveal: CommentReveal): Modifier = bringIntoViewRequester(reveal.requester)

/**
 * GH #378: renders [text] (already formatted: links, code, task links) collapsed to [collapsedLines] lines.
 * The Show more control appears only when the laid-out text really overflows (never a character
 * count), and expansion state is owned by the caller per comment id ([expanded] / [onExpandedChange]),
 * so recycled rows never inherit it. Collapsing scrolls the comment's top edge back into view when it
 * has scrolled away (and does nothing when it is still on screen), so you keep your place in the thread.
 * Pass [reveal] when it is attached to the whole comment (author line included) so that line comes back
 * too; otherwise the text's own top edge is used.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ExpandableCommentText(
    text: AnnotatedString,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    style: TextStyle = ltype(LType.Body),
    color: Color = Orcha.palette.text2,
    collapsedLines: Int = CommentExpansion.COLLAPSED_LINES,
    reveal: CommentReveal? = null,
    /** The text is a known shortened copy (Home's 140-character summary): Show more appears even when it
     *  fits, and the caller fetches the complete comment before expanding. */
    knownCut: Boolean = false,
    /** Show more is fetching the complete comment: the control reads "Loading…" and ignores taps. */
    loading: Boolean = false,
) {
    val p = Orcha.palette
    var overflowed by remember(text, collapsedLines) { mutableStateOf(false) }
    var collapseRequests by remember { mutableStateOf(0) }
    val ownReveal = rememberCommentReveal()
    val target = (reveal ?: ownReveal).requester
    // Only the top edge: the whole (still shrinking) comment is often taller than the screen, and asking
    // for all of it scrolls nowhere or lines up its bottom instead of bringing the author line back.
    LaunchedEffect(collapseRequests) { if (collapseRequests > 0) target.bringIntoView(TOP_EDGE) }
    Column(modifier.commentRevealTarget(ownReveal).animateContentSize()) {
        Text(
            text,
            style = style.copy(color = color),
            maxLines = if (expanded) Int.MAX_VALUE else collapsedLines,
            overflow = if (expanded) TextOverflow.Clip else TextOverflow.Ellipsis,
            onTextLayout = { if (!expanded) overflowed = it.hasVisualOverflow },
            modifier = Modifier.fillMaxWidth().testTag(COMMENT_TEXT_TAG),
        )
        if (CommentExpansion.showsControl(overflowed || knownCut, expanded)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable(enabled = !loading, role = Role.Button, onClickLabel = CommentExpansion.actionLabel(expanded)) {
                        if (expanded) collapseRequests++
                        onExpandedChange(!expanded)
                    }
                    .semantics { stateDescription = CommentExpansion.stateDescription(expanded) }
                    .testTag(COMMENT_TOGGLE_TAG),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    if (loading) CommentExpansion.LOADING_LABEL else CommentExpansion.controlLabel(expanded),
                    style = ltype(LType.Meta),
                    color = p.accent,
                )
                if (!loading) {
                    Icon(OrchaIcons.ExpandMore, null, tint = p.accent, modifier = Modifier.size(16.dp).rotate(if (expanded) 180f else 0f))
                }
            }
        }
    }
}

/**
 * Any capped display text that people need to read in full (GH #378: "everywhere", not only comments):
 * the same measured Show more / Show less as [ExpandableCommentText], with its own open/closed state.
 * The state is saveable, so it survives rotation and, inside a keyed lazy list, scrolling the row away.
 * Short text that fits never gets a control, so screens look the same until something is cut off.
 */
@Composable
fun ExpandableText(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    style: TextStyle = ltype(LType.Body),
    color: Color = Orcha.palette.text2,
    collapsedLines: Int = CommentExpansion.COLLAPSED_LINES,
    reveal: CommentReveal? = null,
) {
    var expanded by rememberSaveable(text.text) { mutableStateOf(false) }
    ExpandableCommentText(text, expanded, { expanded = it }, modifier, style, color, collapsedLines, reveal)
}

/** Plain-string form of [ExpandableText]. */
@Composable
fun ExpandableText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = ltype(LType.Body),
    color: Color = Orcha.palette.text2,
    collapsedLines: Int = CommentExpansion.COLLAPSED_LINES,
    reveal: CommentReveal? = null,
) = ExpandableText(AnnotatedString(text), modifier, style, color, collapsedLines, reveal)
