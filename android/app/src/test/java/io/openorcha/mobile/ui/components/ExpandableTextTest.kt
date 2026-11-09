package io.openorcha.mobile.ui.components

import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.theme.OrchaTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * GH #378 round 2: any cut-off text opens in place, not only comments. [ExpandableText] owns its own state,
 * and inside a tappable row its control expands the text without opening the row.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExpandableTextTest {
    @get:Rule val rule = createComposeRule()

    private val long = List(6) { "The routine skipped this run because the previous task was still open." }.joinToString(" ")

    @Test fun shortTextLooksTheSameAsBefore() {
        rule.setContent { OrchaTheme { ExpandableText("Every Monday at 09:00", Modifier.width(320.dp), collapsedLines = 1) } }
        rule.onAllNodesWithTag(COMMENT_TOGGLE_TAG).assertCountEquals(0)
    }

    @Test fun cutTextOpensAndClosesOnItsOwn() {
        rule.setContent { OrchaTheme { ExpandableText(long, Modifier.width(320.dp), collapsedLines = 2) } }
        rule.onNodeWithText("Show more").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Show less").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Show more")
    }

    @Test fun showMoreInATappableRowDoesNotOpenTheRow() {
        var opened = 0
        rule.setContent {
            OrchaTheme {
                LRow(title = "Incoming open", subtitle = "“$long”", onClick = { opened++ }, modifier = Modifier.width(320.dp))
            }
        }
        rule.onNodeWithText("Show more").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Show less")
        assertEquals(0, opened)
    }

    @Test fun rowWithoutATapTargetLetsItsTitleOpenToo() {
        rule.setContent { OrchaTheme { LRow(title = long, modifier = Modifier.width(320.dp)) } }
        rule.onNodeWithText("Show more").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Show less")
    }
}
