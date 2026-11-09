package io.openorcha.mobile.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.CommentExpansion
import io.openorcha.mobile.ui.theme.OrchaTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** GH #378: real Compose layout (native graphics, so text is measured for real) for the five comment shapes the issue names. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExpandableCommentTextTest {
    @get:Rule val rule = createComposeRule()

    private val AUTHOR_TAG = "comment-author"

    private val short = "Pushed the fix. Tests are green on both platforms."
    private val long = List(8) { "I traced the stall to the notifier scan loop and moved the inventory to a background pass." }.joinToString(" ")
    private val formatted = "**Root cause:** the scan waits on `git worktree list`. See [PR 412](https://github.com/open-orcha/orcha/pull/412).\n" +
        List(8) { "- `notifier_policy.py:118` holds the timeout" }.joinToString("\n")
    private val huge = "word ".repeat(800)
    private val unbroken = "https://example.com/" + "a1b2c3d4e5".repeat(60)

    private fun show(text: String, expandedAtStart: Boolean = false): () -> Boolean {
        var expanded by mutableStateOf(expandedAtStart)
        rule.setContent {
            OrchaTheme {
                ExpandableCommentText(AnnotatedString(text), expanded, { expanded = it }, Modifier.width(320.dp))
            }
        }
        return { expanded }
    }

    private fun state(expanded: Boolean) =
        SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, CommentExpansion.stateDescription(expanded))

    @Test fun shortCommentHasNoControl() {
        show(short)
        rule.onAllNodesWithTag(COMMENT_TOGGLE_TAG).assertCountEquals(0)
    }

    @Test fun longCommentExpandsAndCollapsesInline() {
        val expanded = show(long)
        rule.onNodeWithText("Show more").assert(state(false)).performClick()
        rule.waitForIdle()
        assertTrue(expanded())
        rule.onNodeWithText("Show less").assert(state(true)).performClick()
        rule.waitForIdle()
        assertEquals(false, expanded())
        rule.onNodeWithText("Show more").assert(state(false))
    }

    @Test fun formattedCommentGetsTheControl() {
        show(formatted)
        rule.onNodeWithTag(COMMENT_TOGGLE_TAG).assert(state(false))
    }

    @Test fun extremelyLargeCommentShowsFullTextWhenExpanded() {
        show(huge, expandedAtStart = true)
        rule.onNodeWithText("Show less").assert(state(true))
        rule.onNodeWithTag(COMMENT_TEXT_TAG).assert(
            SemanticsMatcher("whole comment") { n -> n.config[SemanticsProperties.Text].joinToString("") { it.text } == huge },
        )
    }

    /** An Activity-style row (author line + comment) in a scrolling page [viewport] tall, with [above] of page before it and plenty after. */
    private fun showInPage(text: String, viewport: Dp, above: Dp = 0.dp, startScroll: Int = 0): ScrollState {
        var expanded by mutableStateOf(true)
        lateinit var scroll: ScrollState
        rule.setContent {
            OrchaTheme {
                scroll = rememberScrollState(startScroll)
                Column(Modifier.height(viewport).width(320.dp).verticalScroll(scroll)) {
                    Spacer(Modifier.height(above))
                    val reveal = rememberCommentReveal()
                    Column(Modifier.commentRevealTarget(reveal)) {
                        Text("Kedar · 2m", Modifier.testTag(AUTHOR_TAG))
                        ExpandableCommentText(AnnotatedString(text), expanded, { expanded = it }, reveal = reveal)
                    }
                    Spacer(Modifier.height(2000.dp))
                }
            }
        }
        return scroll
    }

    @Test fun collapsingBringsTheAuthorLineBackWhenItScrolledAway() {
        showInPage(huge, viewport = 240.dp)
        rule.onNodeWithText("Show less").performScrollTo()
        rule.onNodeWithTag(AUTHOR_TAG).assertIsNotDisplayed()
        rule.onNodeWithText("Show less").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag(AUTHOR_TAG).assertIsDisplayed()
        rule.onNodeWithText("Show more").assertIsDisplayed()
    }

    @Test fun collapsingDoesNotScrollWhenTheAuthorLineIsStillOnScreen() {
        val scroll = showInPage(long, viewport = 800.dp, above = 100.dp, startScroll = 50)
        rule.onNodeWithTag(AUTHOR_TAG).assertIsDisplayed()
        rule.onNodeWithText("Show less").performClick()
        rule.waitForIdle()
        assertEquals(50, scroll.value)
    }

    @Test fun unbrokenStringOverflowsWithoutWidening() {
        show(unbroken)
        rule.onNodeWithTag(COMMENT_TOGGLE_TAG).assert(state(false))
        val width = rule.onNodeWithTag(COMMENT_TEXT_TAG).fetchSemanticsNode().size.width
        val limit = with(rule.density) { 320.dp.roundToPx() }
        assertTrue("text width $width exceeds $limit", width <= limit)
    }
}
