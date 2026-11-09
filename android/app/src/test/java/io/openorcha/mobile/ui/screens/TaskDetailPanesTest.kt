package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.ui.components.COMMENT_TEXT_TAG
import io.openorcha.mobile.ui.components.ExpandableCommentText
import io.openorcha.mobile.ui.components.commentRevealTarget
import io.openorcha.mobile.ui.components.rememberCommentReveal
import io.openorcha.mobile.ui.theme.OrchaTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** GH #378 review fixes: scroll-back inside a lazy list, open comments surviving Runs, and task links in comments. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TaskDetailPanesTest {
    @get:Rule val rule = createComposeRule()

    private val long = "This is a long comment with enough words to scroll down and read. ".repeat(60)
    private val linked = TaskDto(id = "1a2b3c4d-0000-4000-8000-000000000001", title = "Linked task")
    private val task = TaskDto(id = "9f8e7d6c-0000-4000-8000-000000000002", title = "This task")

    @Test fun collapseInLazyListBringsTheAuthorLineBack() {
        var expanded by mutableStateOf(false)
        rule.setContent {
            OrchaTheme {
                LazyColumn(Modifier.width(320.dp).height(400.dp)) {
                    item { Spacer(Modifier.height(150.dp)) }
                    item {
                        val reveal = rememberCommentReveal()
                        Column(Modifier.commentRevealTarget(reveal)) {
                            Text("Author header", Modifier.testTag("header"))
                            ExpandableCommentText(AnnotatedString(long), expanded, { expanded = it }, reveal = reveal)
                        }
                    }
                    item { Spacer(Modifier.height(3000.dp)) }
                }
            }
        }
        rule.onNodeWithText("Show more").performScrollTo().performClick()
        rule.onNodeWithText("Show less").performScrollTo()
        rule.waitForIdle()
        val before = rule.onNodeWithTag("header").fetchSemanticsNode().positionInRoot.y
        assertTrue("precondition: the author line scrolled away (y=$before)", before < 0)
        rule.onNodeWithText("Show less").performClick()
        rule.waitForIdle()
        assertEquals(false, expanded)
        val after = rule.onNodeWithTag("header").fetchSemanticsNode().positionInRoot.y
        assertTrue("the author line is back on screen after Show less (y=$after)", after >= -1f)
        rule.onNodeWithText("Show more").assertExists()
    }

    @Test fun openCommentStaysOpenAfterVisitingRuns() {
        var pane by mutableStateOf(DetailPane.Activity)
        val message = TaskMessageDto(messageId = "comment", authorAlias = "Reviewer", body = long)
        rule.setContent {
            OrchaTheme {
                Column(Modifier.width(320.dp)) {
                    TaskDetailPanes(
                        task = task, messages = listOf(message), runs = emptyList(), agents = emptyList(),
                        tasks = listOf(task, linked), pane = pane, onSelectPane = { pane = it },
                        onOpenThread = {}, onOpenTask = {}, onOpenRun = {},
                    )
                }
            }
        }
        rule.onNodeWithText("Show more").performClick()
        rule.onNodeWithText("Show less").assertExists()
        rule.onNodeWithText("Runs 0").performClick()
        rule.waitForIdle()
        assertEquals(DetailPane.Runs, pane)
        rule.onNodeWithText("Activity", substring = true).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Show less").assertExists()
    }

    @Test fun taskReferenceIsATappableLinkCollapsedAndExpanded() {
        val opened = mutableListOf<String>()
        val message = TaskMessageDto(messageId = "comment", authorAlias = "Reviewer", body = "Blocked on 1a2b3c4d first. $long")
        rule.setContent {
            OrchaTheme {
                Column(Modifier.width(320.dp)) {
                    TaskDetailPanes(
                        task = task, messages = listOf(message), runs = emptyList(), agents = emptyList(),
                        tasks = listOf(task, linked), pane = DetailPane.Activity, onSelectPane = {},
                        onOpenThread = {}, onOpenTask = { opened += it }, onOpenRun = {},
                    )
                }
            }
        }
        fun tapTaskLink() {
            val text = rule.onNodeWithTag(COMMENT_TEXT_TAG, useUnmergedTree = true)
                .fetchSemanticsNode().config[SemanticsProperties.Text].single()
            val link = text.getLinkAnnotations(0, text.length).map { it.item }
                .filterIsInstance<LinkAnnotation.Clickable>().single { it.tag.startsWith("task-") }
            rule.runOnIdle { link.linkInteractionListener!!.onClick(link) }
        }
        tapTaskLink()
        rule.onNodeWithText("Show more").performClick()
        rule.onNodeWithText("Show less").assertExists()
        tapTaskLink()
        assertEquals(listOf(linked.id, linked.id), opened)
    }

}
