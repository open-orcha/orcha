package io.openorcha.mobile.domain

import io.openorcha.mobile.data.ContainerDto
import io.openorcha.mobile.data.ProjectIconApi
import io.openorcha.mobile.ui.icons.ProjectGlyphs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProjectIconsTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }
    private fun container(icon: String?) = json.decodeFromString<ContainerDto>(
        """{"id":"c1","name":"Demo","status":"active"${icon?.let { ",\"icon\":$it" } ?: ""}}""",
    )

    @Test
    fun `decodes every icon shape off the container`() {
        assertNull(container(null).projectIcon)
        assertNull(container("null").projectIcon)
        assertEquals(ProjectIconValue.Emoji("🚀"), container("""{"kind":"emoji","value":"🚀"}""").projectIcon)
        assertEquals(ProjectIconValue.Glyph("rocket", 3), container("""{"kind":"glyph","value":"rocket","color":3}""").projectIcon)
        assertEquals(ProjectIconValue.Glyph("bot", null), container("""{"kind":"glyph","value":"bot","color":null}""").projectIcon)
        assertEquals(ProjectIconValue.Glyph("bot", null), container("""{"kind":"glyph","value":"bot"}""").projectIcon)
    }

    @Test
    fun `malformed icons decode as unset, never crash`() {
        listOf(
            "\"🚀\"", "42", "[]", """{"kind":"emoji","value":"hi"}""", """{"kind":"glyph","value":"nope"}""",
            """{"kind":"sticker","value":"x"}""", """{"kind":"emoji"}""",
        ).forEach { assertNull(container(it).projectIcon, it) }
        // out-of-range / non-int colour drops to neutral, the glyph survives
        assertEquals(ProjectIconValue.Glyph("star", null), container("""{"kind":"glyph","value":"star","color":10}""").projectIcon)
        assertEquals(ProjectIconValue.Glyph("star", null), container("""{"kind":"glyph","value":"star","color":"2"}""").projectIcon)
    }

    @Test
    fun `emoji validation mirrors the backend is_emoji`() {
        listOf("🚀", "❤️", "🇰🇪", "1️⃣", "👩‍💻", "✨", "☁️", "🛠️").forEach { assertTrue(ProjectIcons.isEmoji(it), it) }
        listOf(null, "", "a", "hi🚀", "<🚀>", "🚀&", "12", "—", "🚀".repeat(9)).forEach {
            assertFalse(ProjectIcons.isEmoji(it), it.toString())
        }
    }

    @Test
    fun `every backend glyph name has vector path data, in order`() {
        assertEquals(ProjectIcons.GLYPH_NAMES, ProjectGlyphs.PATHS.keys.toList())
        ProjectIcons.GLYPH_NAMES.forEach { assertTrue(ProjectGlyphs.PATHS.getValue(it).isNotEmpty(), it) }
        ProjectIcons.QUICK_EMOJI.forEach { assertTrue(ProjectIcons.isEmoji(it), it) }
    }

    @Test
    fun `glyph search matches names and extra words`() {
        assertEquals(ProjectIcons.GLYPH_NAMES, ProjectIcons.searchGlyphs("  ", ProjectGlyphs.WORDS))
        assertEquals(listOf("bot"), ProjectIcons.searchGlyphs("robot", ProjectGlyphs.WORDS))
        assertTrue("smartphone" in ProjectIcons.searchGlyphs("Mobile app", ProjectGlyphs.WORDS))
        assertTrue(ProjectIcons.searchGlyphs("zzz", ProjectGlyphs.WORDS).isEmpty())
    }

    @Test
    fun `PUT body sends an explicit null to clear, and the full glyph shape`() {
        val clear = ProjectIconApi.body(null, "h1")
        assertEquals(JsonNull, clear["icon"])
        assertEquals("h1", clear["actor_agent_id"]!!.jsonPrimitive.content)
        val glyph = ProjectIconApi.body(ProjectIconValue.Glyph("rocket", null), null)["icon"]!!.jsonObject
        assertEquals("glyph", glyph["kind"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, glyph["color"])
        assertEquals(JsonNull, ProjectIconApi.body(null, null)["actor_agent_id"])
        assertEquals(ProjectIconValue.Emoji("🚀"), ProjectIcons.parse(ProjectIconValue.Emoji("🚀").toJson()))
        assertEquals(ProjectIconValue.Glyph("leaf", 4), ProjectIcons.parse(ProjectIconValue.Glyph("leaf", 4).toJson()))
    }
}
