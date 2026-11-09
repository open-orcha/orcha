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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
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

/**
 * GH #378: renders [text] (already formatted: links, code, task links) collapsed to [collapsedLines] lines.
 * The Show more control appears only when the laid-out text really overflows (never a character
 * count), and expansion state is owned by the caller per comment id ([expanded] / [onExpandedChange]),
 * so recycled rows never inherit it. Collapsing scrolls the comment back into view when its top has
 * scrolled away, so you keep your place in the thread.
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
) {
    val p = Orcha.palette
    var overflowed by remember(text, collapsedLines) { mutableStateOf(false) }
    var collapseRequests by remember { mutableStateOf(0) }
    val bringIntoView = remember { BringIntoViewRequester() }
    LaunchedEffect(collapseRequests) { if (collapseRequests > 0) bringIntoView.bringIntoView() }
    Column(modifier.bringIntoViewRequester(bringIntoView).animateContentSize()) {
        Text(
            text,
            style = style.copy(color = color),
            maxLines = if (expanded) Int.MAX_VALUE else collapsedLines,
            overflow = if (expanded) TextOverflow.Clip else TextOverflow.Ellipsis,
            onTextLayout = { if (!expanded) overflowed = it.hasVisualOverflow },
            modifier = Modifier.fillMaxWidth().testTag(COMMENT_TEXT_TAG),
        )
        if (CommentExpansion.showsControl(overflowed, expanded)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClickLabel = CommentExpansion.actionLabel(expanded)) {
                        if (expanded) collapseRequests++
                        onExpandedChange(!expanded)
                    }
                    .semantics { stateDescription = CommentExpansion.stateDescription(expanded) }
                    .testTag(COMMENT_TOGGLE_TAG),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(CommentExpansion.controlLabel(expanded), style = ltype(LType.Meta), color = p.accent)
                Icon(OrchaIcons.ExpandMore, null, tint = p.accent, modifier = Modifier.size(16.dp).rotate(if (expanded) 180f else 0f))
            }
        }
    }
}
