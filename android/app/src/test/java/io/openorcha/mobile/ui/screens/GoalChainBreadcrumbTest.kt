package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.GoalChainDto
import io.openorcha.mobile.data.GoalNodeDto
import io.openorcha.mobile.ui.theme.OrchaTheme
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * GH #378 review round 3: the project objective above a task opens in full whenever the screen cuts it
 * off, including a short objective that only overflows at a large text size, and stays plain text when
 * it fits.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GoalChainBreadcrumbTest {
    @get:Rule val rule = createComposeRule()

    private val objective = "Make every customer message readable on a phone"

    private fun show(fontScale: Float, objective: String = this.objective) {
        rule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, fontScale)) {
                OrchaTheme {
                    Box(Modifier.width(320.dp)) {
                        GoalChainBreadcrumb(GoalChainDto(goalChain = listOf(GoalNodeDto(kind = "objective", text = objective)))) {}
                    }
                }
            }
        }
    }

    private fun overflows(objective: String = this.objective): Boolean {
        val layouts = mutableListOf<TextLayoutResult>()
        rule.onNodeWithText(objective, useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.last().hasVisualOverflow
    }

    @Test fun shortObjectiveCutOffAtLargeTextOpensInFull() {
        show(fontScale = 2f)
        assertTrue("precondition: the objective is visibly cut off", overflows())
        rule.onNodeWithText(objective, useUnmergedTree = true)
            .assertHasClickAction()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
            .performClick()
        rule.waitForIdle()
        assertFalse("open, the whole objective shows", overflows())
        rule.onNodeWithText(objective, useUnmergedTree = true)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
    }

    @Test fun objectiveThatFitsStaysPlainText() {
        val short = "Ship the beta"
        show(fontScale = 1f, objective = short)
        assertFalse("precondition: the objective fits", overflows(short))
        rule.onNodeWithText(short, useUnmergedTree = true).assertHasNoClickAction()
    }
}
