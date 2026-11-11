package io.openorcha.mobile.ui.screens

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import io.openorcha.mobile.data.ContainerDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.MessageSummaryDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.CommentExpansion
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.COMMENT_TOGGLE_TAG
import io.openorcha.mobile.ui.theme.OrchaTheme
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * GH #378: Home's Updates carry only the first 140 characters of a task's latest comment, so Show more
 * fetches the complete comment first. Promoted from Code Reviewer's round-6 checks: the fetch lifecycle,
 * not just the matching rule.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeUpdateCommentTest {
    @get:Rule val rule = createComposeRule()

    private val at = "2026-11-09T12:00:00Z"
    private val prefix = "A careful review checks every part of the change. ".repeat(4).take(140)
    private val full = "$prefix COMPLETE ORIGINAL END"
    private var opened = 0
    private var loads = 0

    private fun comment(body: String, time: String = at, by: String = "Original author") =
        TaskMessageDto(authorAlias = by, body = body, createdAt = time)

    private fun task(last: TaskMessageDto = comment(prefix)) = TaskDto(
        id = "fixture-task", title = "Fixture task", status = "completed",
        messageSummary = MessageSummaryDto(1, last),
    )

    private fun mount(taskState: MutableState<TaskDto> = mutableStateOf(task()), loader: suspend (String) -> TaskMessageDto?) {
        rule.setContent {
            OrchaTheme {
                HomeTab(
                    OrchaUiState(snapshot = ContainerSnapshot(ContainerDto("fixture", "Review project"), tasks = listOf(taskState.value))),
                    emptyList(), emptyList(), emptyList(),
                    onOpenTask = { opened++ }, onOpenRequest = {}, onOpenAgent = {}, onTab = {},
                    onPlanSheet = {}, onVerifySheet = {},
                    loadNewestComment = { loads++; loader(it) },
                )
            }
        }
        rule.onNode(hasScrollAction()).performScrollToNode(hasText("Show more"))
    }

    private fun toggle() = rule.onNodeWithTag(COMMENT_TOGGLE_TAG)

    private fun waitForText(text: String) =
        rule.waitUntil(3_000) { rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test fun showMoreLoadsTheCompleteCommentWithoutOpeningTheTask() {
        mount { comment(full) }
        toggle().performTouchInput { click() }
        waitForText("Show less")
        rule.onNodeWithText(full, substring = true).assertExists()
        assertEquals(1, loads)
        assertEquals(0, opened)
        toggle().performClick()
        rule.onNodeWithText("Show more").assertExists()
        toggle().performClick()
        assertEquals(1, loads) // the complete comment is kept, not fetched again
        rule.onNodeWithText("Original author", substring = true).performClick()
        assertEquals(1, opened)
    }

    @Test fun loadingIsDisabledAndAFailureCanBeRetried() {
        val reply = CompletableDeferred<TaskMessageDto?>()
        mount { if (loads == 1) reply.await() else comment(full) }
        toggle().performClick()
        rule.onNodeWithText(CommentExpansion.LOADING_LABEL).assertIsNotEnabled()
        toggle().performTouchInput { click() }
        assertEquals(1, loads)
        assertEquals(0, opened)
        reply.complete(null)
        waitForText(CommentExpansion.LOAD_FAILED_NOTE)
        rule.onNodeWithText("Show more").assertIsEnabled().performClick()
        waitForText("Show less")
        assertEquals(2, loads)
        assertEquals(0, opened)
    }

    @Test fun aNewerCommentArrivingDuringTheLoadResetsTheRow() {
        val state = mutableStateOf(task())
        val reply = CompletableDeferred<TaskMessageDto?>()
        mount(state) { reply.await() }
        toggle().performClick()
        rule.onNodeWithText(CommentExpansion.LOADING_LABEL).assertExists()
        rule.runOnIdle { state.value = task(comment("NEW COMMENT FROM ANOTHER PERSON", "2026-11-09T12:01:00Z", "Someone else")) }
        reply.complete(comment(full))
        rule.waitForIdle()
        rule.onNodeWithText("NEW COMMENT FROM ANOTHER PERSON", substring = true).assertExists()
        rule.onAllNodesWithText("Show less").assertCountEquals(0)
        rule.onAllNodesWithText("COMPLETE ORIGINAL END", substring = true).assertCountEquals(0)
    }

    /** Review round 6: a newer comment that opens with the same 140 characters never shows under the old author. */
    @Test fun aNewerCommentWithTheSameOpeningDoesNotExpandUnderTheOldAuthor() {
        mount { comment("$prefix NEWER COMMENT END", "2026-11-09T12:01:00Z") } // same author, a later report
        toggle().performClick()
        rule.waitForIdle()
        rule.onNodeWithText(CommentExpansion.LOAD_FAILED_NOTE).assertExists()
        rule.onAllNodesWithText("NEWER COMMENT END", substring = true).assertCountEquals(0)
    }
}
