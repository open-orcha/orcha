package io.openorcha.mobile.ui.screens

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.openorcha.mobile.data.ModelsResponse
import io.openorcha.mobile.domain.ModelProvider
import io.openorcha.mobile.domain.UsageFormat
import io.openorcha.mobile.domain.providerFor
import io.openorcha.mobile.ui.components.ModelTag
import io.openorcha.mobile.ui.theme.OrchaTheme
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * GH #432: the server drops Claude Fable 5.1 from `GET /api/models`. The agent model picker must offer
 * exactly the server's catalog — no private fallback list and no re-inserting an agent's saved model —
 * while history (an agent still saved on, or a run/usage row recorded with, `claude-fable-5-1`) stays
 * readable with its Claude mark and a "Fable 5.1" name.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ModelCatalogRemovalTest {
    @get:Rule val rule = createComposeRule()

    /** The live `/api/models` shape (extra `reasoning_efforts` and `default`) with Fable 5.1 removed. */
    private val catalogJson = """
        {"models":[
          {"id":"claude-fable-5-2","name":"Fable 5.2","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
          {"id":"claude-opus-5-5","name":"Opus 5.5","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
          {"id":"claude-sonnet-5-5","name":"Sonnet 5.5","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
          {"id":"claude-fable-5","name":"Fable 5","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
          {"id":"gpt-5.5","name":"GPT-5.5","runtime":"codex","reasoning_efforts":["low","medium","high","xhigh"]}
        ],"default":"claude-opus-5-5"}
    """.trimIndent()

    /** Same tolerant reader settings as `createOrchaHttpClient`. */
    private val wireJson = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }
    private val catalog = wireJson.decodeFromString(ModelsResponse.serializer(), catalogJson).models
    private val removed = "claude-fable-5-1"
    private var confirmed: String? = null

    private fun mountPicker(current: String?) {
        rule.setContent {
            OrchaTheme {
                ModelPickerSheet(models = catalog, current = current, busy = false, onDismiss = {}) { confirmed = it }
            }
        }
        rule.waitForIdle()
    }

    @Test fun pickerOffersOnlyTheServerCatalogWhenTheSavedModelWasRemoved() {
        mountPicker(current = removed)
        rule.onAllNodesWithText("Fable 5.1").assertCountEquals(0)
        rule.onAllNodesWithText(removed).assertCountEquals(0)
        rule.onAllNodesWithText("Current").assertCountEquals(0) // the saved id is not re-inserted as a row
        catalog.forEach { m -> rule.onNodeWithText(m.name!!).assertExists() }
        rule.onNodeWithText("Pick a different model").performScrollTo().assertIsNotEnabled()
        assertEquals(null, confirmed)
    }

    @Test fun fable52StaysSelectableFromAnAgentSavedOnTheRemovedModel() {
        mountPicker(current = removed)
        rule.onNodeWithText("Fable 5.2").performScrollTo().performClick()
        rule.onNodeWithText("Change to Fable 5.2").performScrollTo().assertIsEnabled().performClick()
        assertEquals("claude-fable-5-2", confirmed)
    }

    /** Control for the removal case: a saved model that IS offered still gets its Current tag. */
    @Test fun aSavedModelStillInTheCatalogIsMarkedCurrent() {
        mountPicker(current = "claude-fable-5-2")
        rule.onNodeWithText("Current").assertExists()
        rule.onNodeWithText("Pick a different model").performScrollTo().assertIsNotEnabled()
    }

    @Test fun historicalFable51KeepsItsClaudeMarkAndRawIdInAModelTag() {
        rule.setContent { OrchaTheme { ModelTag(removed) } }
        rule.onNodeWithText(removed).assertExists()
        rule.onNodeWithContentDescription(ModelProvider.Claude.label).assertExists()
    }

    @Test fun historicalFable51NameStaysReadableWithoutACatalogEntry() {
        val names = catalog.mapNotNull { m -> m.name?.let { m.id to it } }.toMap() // as ProjectMetricsScreen builds it
        assertFalse(removed in names)
        assertEquals("Fable 5.1", UsageFormat.modelName(removed, names))
        assertEquals(ModelProvider.Claude, providerFor(removed))
        assertEquals("Fable 5.2", UsageFormat.modelName("claude-fable-5-2", names))
        assertEquals(ModelProvider.Claude, providerFor("claude-fable-5-2"))
        assertTrue(catalog.any { it.id == "claude-fable-5-2" })
    }
}
