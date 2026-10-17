package io.openorcha.mobile.domain

/* D14 project icons — the one shape the portal, desktop and backend share
   (portal_backend/project_icons.py, frontend cloud/projects/projectIcons.ts):
     {"kind":"emoji","value":"🚀"}
     {"kind":"glyph","value":<one of GLYPH_NAMES>,"color":0-9 | null}
   null = unset → the neutral cube glyph (never initials). Pure, so it is unit-tested. */

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

sealed interface ProjectIconValue {
    data class Emoji(val value: String) : ProjectIconValue
    data class Glyph(val name: String, val color: Int? = null) : ProjectIconValue

    fun toJson(): JsonElement = when (this) {
        is Emoji -> buildJsonObject { put("kind", "emoji"); put("value", value) }
        is Glyph -> buildJsonObject {
            put("kind", "glyph"); put("value", name); put("color", color?.let { JsonPrimitive(it) } ?: JsonNull)
        }
    }
}

object ProjectIcons {
    /** Backend PROJECT_ICON_GLYPHS, in the picker's order. */
    val GLYPH_NAMES = listOf(
        "box", "folder", "code", "terminal", "rocket", "globe", "smartphone", "server",
        "database", "cloud", "cpu", "bot", "zap", "flask", "shield", "book", "briefcase",
        "cart", "gamepad", "music", "camera", "palette", "heart", "star", "leaf", "wrench",
        "chart", "mail",
    )

    /** The shared avatar palette's hues (portal `AVATAR_HUES`, D13) — a glyph colour is a slot. */
    val AVATAR_HUES = listOf(4, 30, 50, 95, 145, 178, 208, 238, 272, 318)
    val HUE_NAMES = listOf("Red", "Orange", "Amber", "Lime", "Green", "Teal", "Sky", "Blue", "Violet", "Pink")

    /** One-tap emoji row on the Emoji tab (any emoji can still be typed or pasted). */
    val QUICK_EMOJI = listOf(
        "🚀", "✨", "🔥", "💡", "🧪", "🛠️", "📦", "📱", "🌐", "🤖", "🎯", "📈",
        "🧠", "⚡", "🎨", "🎮", "📚", "🔒", "🌱", "☁️", "🐛", "💬", "🏠", "⭐",
    )

    private const val EMOJI_MAX_UTF16 = 16

    /** Mirror of the backend's `is_emoji`: short text with at least one pictographic code
     *  point (flags = regional indicators, keycaps = U+20E3) — never a word, never markup. */
    fun isEmoji(value: String?): Boolean {
        if (value.isNullOrEmpty() || value.length > EMOJI_MAX_UTF16) return false
        if (value.any { it.code < 128 && it.isLetter() }) return false
        if (value.any { it in "<>&\"'" }) return false
        if ('️' in value) return true
        var i = 0
        while (i < value.length) {
            val cp = value.codePointAt(i)
            if (cp in 0x1F1E6..0x1F1FF || cp == 0x20E3) return true
            if (Character.getType(cp) == Character.OTHER_SYMBOL.toInt() && cp >= 0x2000) return true
            i += Character.charCount(cp)
        }
        return false
    }

    /** Tolerant read of a stored icon; anything malformed is treated as unset (portal parity). */
    fun parse(raw: JsonElement?): ProjectIconValue? {
        val o = raw as? JsonObject ?: return null
        val kind = (o["kind"] as? JsonPrimitive)?.contentOrNull
        val value = (o["value"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return when (kind) {
            "emoji" -> value?.takeIf(::isEmoji)?.let { ProjectIconValue.Emoji(it) }
            "glyph" -> value?.takeIf { it in GLYPH_NAMES }?.let { name ->
                val c = (o["color"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
                ProjectIconValue.Glyph(name, c?.takeIf { it in AVATAR_HUES.indices })
            }
            else -> null
        }
    }

    /** Glyph search: every query word must hit the name or its extra words (portal GLYPH_WORDS). */
    fun searchGlyphs(query: String, words: Map<String, String>): List<String> {
        val q = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (q.isEmpty()) return GLYPH_NAMES
        return GLYPH_NAMES.filter { n -> val hay = "$n ${words[n].orEmpty()}".lowercase(); q.all { it in hay } }
    }
}
