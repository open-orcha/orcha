package io.openorcha.mobile.domain

/* Which vendor a model id or runtime belongs to, so the UI can show the provider's mark next
   to it (desktop parity: `terminal/brandMarks.tsx`). Pure, so it is unit-tested. */

enum class ModelProvider(val label: String) {
    Claude("Claude"),
    OpenAI("OpenAI"),
}

private val CLAUDE_HINTS = listOf("claude", "anthropic", "opus", "sonnet", "haiku", "fable")
private val OPENAI_HINTS = listOf("gpt", "codex", "openai", "chatgpt")
/** OpenAI's o-series ids (`o1`, `o3-mini`, `o4-mini-high`) — matched as a whole token so
 *  an id that merely contains "o3" somewhere (`foo3`, `v10.3`) isn't misread. */
private val O_SERIES = Regex("(^|[^a-z0-9])o[134]([^0-9]|$)")

/** The provider for a model id or runtime name (`claude`, `codex`), or null when unknown. */
fun providerFor(model: String?): ModelProvider? {
    val s = model?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    if (CLAUDE_HINTS.any { it in s }) return ModelProvider.Claude
    if (OPENAI_HINTS.any { it in s } || O_SERIES.containsMatchIn(s)) return ModelProvider.OpenAI
    return null
}
