package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.theme.OrchaTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * GH #378 QA round 2: at large text the Updates header squeezed "on <task>" to a cut-off sliver after the
 * shortened name. The task title now either keeps a readable width beside the name or moves to its own line.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeUpdateHeaderTest {
    @get:Rule val rule = createComposeRule()

    private val actor = "CodeCleanupAgent"
    private val title = "Mobile: make long comments expandable instead of permanently ellipsized"
    private val ago = "3h"
    private val width = 300.dp

    private fun show(fontScale: Float) {
        rule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, fontScale)) {
                OrchaTheme {
                    Box(Modifier.width(width).testTag("header")) { UpdateHeader(actor, title, ago) }
                }
            }
        }
    }

    private fun bounds(text: String): DpRect = rule.onNodeWithText(text, useUnmergedTree = true).getUnclippedBoundsInRoot()

    @Test fun normalTextKeepsNameTitleAndTimeOnOneLine() {
        show(fontScale = 1f)
        val name = bounds(actor)
        val task = bounds("on $title")
        val time = bounds(ago)
        assertTrue("title sits beside the name", task.top < name.bottom && task.left >= name.right)
        assertTrue("title keeps at least the minimum width, got ${task.right - task.left}", task.right - task.left >= UPDATE_TASK_TITLE_MIN.value.dp)
        assertTrue("time stays inside the row", time.right <= width && time.left >= task.right)
    }

    @Test fun largeTextMovesTheTitleToItsOwnLineInsteadOfASliver() {
        show(fontScale = 2f)
        val name = bounds(actor)
        val task = bounds("on $title")
        val time = bounds(ago)
        assertTrue("title is below the name, not squeezed beside it", task.top >= name.bottom)
        assertTrue("title takes the full width, got ${task.right - task.left}", task.right - task.left >= width - 1.dp)
        assertTrue("time stays inside the row and clear of the name", time.right <= width && time.left >= name.right)
        val header = rule.onNodeWithTag("header").getUnclippedBoundsInRoot()
        assertTrue("the header grows to hold both lines", header.bottom >= task.bottom)
    }
}
