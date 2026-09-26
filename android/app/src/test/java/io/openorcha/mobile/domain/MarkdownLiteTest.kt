package io.openorcha.mobile.domain

/** Rule-parity tests against the web's `mdText` (format.ts) — same forms, same order. */

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class MarkdownLiteTest {

    @Test
    fun fencedCodeBlockIsOpaque() {
        val blocks = MarkdownLite.parse("before\n```kotlin\nval **x** = 1\n```\nafter")
        assertEquals(3, blocks.size)
        assertIs<MdBlock.Para>(blocks[0])
        val code = assertIs<MdBlock.Code>(blocks[1])
        assertEquals("val **x** = 1", code.text)
        assertIs<MdBlock.Para>(blocks[2])
    }

    @Test
    fun headingUpToThreeHashes() {
        val blocks = MarkdownLite.parse("## Summary")
        val h = assertIs<MdBlock.Heading>(blocks.single())
        assertEquals("Summary", h.spans.single().text)
    }

    @Test
    fun fourHashesIsNotAHeading() {
        val blocks = MarkdownLite.parse("#### deep")
        assertIs<MdBlock.Para>(blocks.single())
    }

    @Test
    fun taskItemsBeforeBulletRule() {
        val blocks = MarkdownLite.parse("- [x] done thing\n- [ ] open thing\n- plain bullet")
        assertEquals(true, assertIs<MdBlock.Task>(blocks[0]).checked)
        assertEquals(false, assertIs<MdBlock.Task>(blocks[1]).checked)
        assertIs<MdBlock.Bullet>(blocks[2])
    }

    @Test
    fun orderedItemsDotAndParen() {
        val blocks = MarkdownLite.parse("1. first\n2) second")
        assertEquals("1", assertIs<MdBlock.Ordered>(blocks[0]).num)
        assertEquals("2", assertIs<MdBlock.Ordered>(blocks[1]).num)
    }

    @Test
    fun inlineCodeBoldAndItalics() {
        val spans = MarkdownLite.inline("run `orcha up` then **verify** the *result*")
        assertTrue(spans.any { it.code && it.text == "orcha up" })
        assertTrue(spans.any { it.bold && it.text == "verify" })
        assertTrue(spans.any { it.italic && it.text == "result" })
    }

    @Test
    fun boldWrappingCodeSpanStillBolds() {
        // The iOS/Android formatting difference: **`path` — words.** must bold the
        // whole run, code chip included (web stashes code behind placeholders first).
        val spans = MarkdownLite.inline("**`scripts/dev-stack.sh` — a real fix, not docs.**")
        val code = spans.first { it.code }
        assertEquals("scripts/dev-stack.sh", code.text)
        assertTrue(code.bold)
        assertTrue(spans.last().bold)
        assertTrue(spans.none { it.text.contains("**") })
    }

    @Test
    fun boldInsideCodeStaysLiteral() {
        val spans = MarkdownLite.inline("`**not bold**`")
        val code = spans.single()
        assertTrue(code.code)
        assertEquals("**not bold**", code.text)
    }

    @Test
    fun linkKeepsTrailingPunctuationOutside() {
        val spans = MarkdownLite.inline("see https://example.com/x).")
        val link = spans.first { it.link != null }
        assertEquals("https://example.com/x", link.link)
        assertTrue(spans.last().text.endsWith(")."))
    }

    @Test
    fun pipeTableParses() {
        val blocks = MarkdownLite.parse("| a | b |\n|---|---:|\n| 1 | 2 |\n| 3 | 4 |")
        val t = assertIs<MdBlock.Table>(blocks.single())
        assertEquals(listOf("a", "b"), t.header)
        assertEquals(listOf("", "right"), t.aligns)
        assertEquals(2, t.rows.size)
        assertEquals(listOf("3", "4"), t.rows[1])
    }

    @Test
    fun underscoreInsideWordIsNotItalics() {
        val spans = MarkdownLite.inline("api_image_digest stays literal")
        assertTrue(spans.none { it.italic })
        assertEquals("api_image_digest stays literal", spans.joinToString("") { it.text })
    }

    @Test
    fun blankLineSeparatesParagraphs() {
        val blocks = MarkdownLite.parse("first para\n\nsecond para")
        assertEquals(2, blocks.size)
        blocks.forEach { assertIs<MdBlock.Para>(it) }
    }
}
