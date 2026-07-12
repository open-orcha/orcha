package io.openorcha.mobile.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Issue 3: the SSE frame parser against the server's actual emissions
 * (GET /api/agents/{aid}/runs/{run_id}/stream — per-line data frames, comment
 * heartbeats, terminal done frame, 30-min stream_timeout).
 */
class RunStreamTest {
    @Test
    fun parsesDataLineFrame() {
        val e = RunStream.parse("""data: {"seq": 7, "line": "{\"type\":\"assistant\"}"}""")
        assertTrue(e is RunStreamEvent.Line)
        assertEquals(7, e.seq)
        assertEquals("""{"type":"assistant"}""", (e as RunStreamEvent.Line).line)
    }

    @Test
    fun parsesTerminalDoneFrameWithStatus() {
        val e = RunStream.parse("""data: {"seq": 42, "done": true, "status": "exited"}""")
        assertTrue(e is RunStreamEvent.Done)
        assertEquals(42, e.seq)
        assertEquals("exited", (e as RunStreamEvent.Done).status)
    }

    @Test
    fun parsesStreamTimeoutDoneFrame() {
        // the server's 30-min cap — the collector must reopen, not mark finished
        val e = RunStream.parse("""data: {"seq": 900, "done": true, "status": "stream_timeout"}""")
        assertEquals("stream_timeout", (e as RunStreamEvent.Done).status)
    }

    @Test
    fun skipsHeartbeatCommentsAndBlankLines() {
        assertNull(RunStream.parse(": heartbeat"))
        assertNull(RunStream.parse(""))
        assertNull(RunStream.parse("data: "))
    }

    @Test
    fun skipsNonJsonAndNonObjectPayloadsWithoutThrowing() {
        assertNull(RunStream.parse("data: not-json"))
        assertNull(RunStream.parse("data: [1,2,3]"))
        assertNull(RunStream.parse("""data: {"seq": 1}""")) // no line, no done
    }

    @Test
    fun missingSeqDefaultsToZero() {
        val e = RunStream.parse("""data: {"line": "hello"}""")
        assertEquals(0, (e as RunStreamEvent.Line).seq)
    }
}
