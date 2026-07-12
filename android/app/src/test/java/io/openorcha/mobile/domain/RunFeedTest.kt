package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A2: the Kotlin port of the portal's run-line classifier (app.js classifyLine /
 * classifyCodex, 1288-1439) against captured real stream-json lines — narration,
 * thinking, tool calls, orcha self-actions, results, system frames, codex events,
 * and the non-JSON fallback.
 */
class RunFeedTest {
    @Test
    fun assistantTextBecomesNarration() {
        val rows = RunFeed.classifyLine(
            """{"type":"assistant","message":{"content":[{"type":"text","text":"Investigating the four issues now."}]}}""",
        )
        assertEquals(1, rows.size)
        assertEquals("narrate", rows[0].type)
        assertEquals("narration", rows[0].label)
        assertEquals("Investigating the four issues now.", rows[0].text)
    }

    @Test
    fun assistantThinkingCollapsesWithDetail() {
        val rows = RunFeed.classifyLine(
            """{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"secret chain of thought"}]}}""",
        )
        assertEquals("think", rows[0].type)
        assertEquals("(thinking)", rows[0].text)
        assertEquals("secret chain of thought", rows[0].detail)
    }

    @Test
    fun toolUseShowsNameWithInputAsDetail() {
        val rows = RunFeed.classifyLine(
            """{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}""",
        )
        assertEquals("tool", rows[0].type)
        assertEquals("Bash", rows[0].text)
        assertTrue(rows[0].detail!!.contains("ls -la"))
    }

    @Test
    fun orchaSelfActionToolCallIsADecisionRow() {
        // web selfAction: input hitting an orcha skill/API path flips tool → orcha-action
        val rows = RunFeed.classifyLine(
            """{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"curl /api/tasks/123/done"}}]}}""",
        )
        assertEquals("decision", rows[0].type)
        assertEquals("orcha-action", rows[0].label)
    }

    @Test
    fun toolResultRowAndDecisionResultRow() {
        val plain = RunFeed.classifyLine(
            """{"type":"user","message":{"content":[{"type":"tool_result","content":"total 12"}]}}""",
        )
        assertEquals("result", plain[0].type)
        assertEquals("total 12", plain[0].detail)

        val decision = RunFeed.classifyLine(
            """{"type":"user","message":{"content":[{"type":"tool_result","content":"{\"decision_id\":\"abc\"}"}]}}""",
        )
        assertEquals("decision", decision[0].type)
    }

    @Test
    fun systemInitIsBootAndResultIsDone() {
        val boot = RunFeed.classifyLine("""{"type":"system","subtype":"init","cwd":"/repo"}""")
        assertEquals("boot", boot[0].type)
        assertTrue(boot[0].text.contains("/repo"))

        val done = RunFeed.classifyLine("""{"type":"result","subtype":"success","result":"all four fixed"}""")
        assertEquals("done", done[0].type)
    }

    @Test
    fun codexReasoningAndExecMap() {
        val reasoning = RunFeed.classifyLine(
            """{"msg":{"type":"agent_reasoning_section_break"},"id":"1"}""",
        )
        assertEquals("think", reasoning[0].type)

        val exec = RunFeed.classifyLine(
            """{"msg":{"type":"exec_command_begin","command":["bash","-lc","ls"]},"id":"2"}""",
        )
        assertEquals("tool", exec[0].type)
        assertEquals("exec", exec[0].text)
    }

    @Test
    fun nonJsonLineFallsBackToPlainLogRow() {
        val rows = RunFeed.classifyLine("plain progress text from a legacy worker")
        assertEquals(1, rows.size)
        assertEquals("narrate", rows[0].type)
        assertEquals("log", rows[0].label)
    }

    @Test
    fun blankLineYieldsNothing() {
        assertTrue(RunFeed.classifyLine("   ").isEmpty())
    }

    @Test
    fun multiBlockAssistantMessageYieldsOneRowPerBlock() {
        val rows = RunFeed.classifyLine(
            """{"type":"assistant","message":{"content":[
                {"type":"text","text":"Running tests."},
                {"type":"tool_use","name":"Bash","input":{"command":"./gradlew test"}}
            ]}}""".trimIndent(),
        )
        assertEquals(2, rows.size)
        assertEquals("narrate", rows[0].type)
        assertEquals("tool", rows[1].type)
    }
}
