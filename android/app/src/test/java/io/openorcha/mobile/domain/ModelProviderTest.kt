package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ModelProviderTest {
    @Test
    fun `claude family ids and the claude runtime map to Claude`() {
        listOf(
            "claude-opus-4-1", "claude-sonnet-4-5", "opus", "sonnet", "haiku", "Fable-1",
            "claude", "us.anthropic.claude-3-7", "CLAUDE-HAIKU-4",
        ).forEach { assertEquals(ModelProvider.Claude, providerFor(it), it) }
    }

    @Test
    fun `gpt, codex and o-series ids and the codex runtime map to OpenAI`() {
        listOf(
            "gpt-5", "gpt-4o", "gpt-5-codex", "codex", "codex-mini-latest", "o1", "o3", "o3-mini",
            "o4-mini-high", "openai/gpt-oss-120b",
        ).forEach { assertEquals(ModelProvider.OpenAI, providerFor(it), it) }
    }

    @Test
    fun `unknown, blank and lookalike ids have no provider`() {
        listOf(null, "", "  ", "default", "gemini-2.5-pro", "llama3", "foo3", "v10.3", "o10", "pro1").forEach {
            assertNull(providerFor(it), it.toString())
        }
    }

    @Test
    fun `labels are the user-facing names`() {
        assertEquals("Claude", ModelProvider.Claude.label)
        assertEquals("OpenAI", ModelProvider.OpenAI.label)
    }
}
