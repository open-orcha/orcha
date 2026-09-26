package io.openorcha.mobile.domain

import io.openorcha.mobile.data.CloseImplicationsResponse
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * PR #223 audit: the server's close-implications `summary` is an OBJECT of counts; the
 * old `summary: String?` DTO threw on every decode (swallowed by `runCatching`), so the
 * destructive close confirm never showed its blast radius. Decodes the REAL shape
 * `task_impact_routes.py` emits and checks the rendered lines.
 */
class CloseImplicationsUxTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private val real = """
        {"task_id":"t1","title":"Ship","status":"in_progress","is_root":false,
         "downstream_tasks":[{"task_id":"t2","title":"Docs","status":"blocked","would_unblock":true}],
         "in_flight_agents":[{"agent_id":"a1","alias":"Max","assignment_status":"working"}],
         "spawned_from_request":null,
         "open_requests_from_assignees":[],
         "summary":{"downstream_total":2,"would_unblock":1,"still_blocked":1,
                    "in_flight_agents":1,"open_requests":0,"completes_container":false}}
    """.trimIndent()

    @Test
    fun decodesTheServerShapeAndRendersTheBlastRadius() {
        val resp = json.decodeFromString<CloseImplicationsResponse>(real)
        assertEquals(2, resp.summary?.downstreamTotal)
        assertEquals(
            listOf(
                "2 downstream tasks depend on it: 1 would unblock, 1 stay blocked.",
                "1 agent is working on it right now.",
            ),
            CloseImplicationsUx.lines(resp),
        )
    }

    @Test
    fun rootTaskAndOrphanedRequestsGetTheirOwnLines() {
        val resp = json.decodeFromString<CloseImplicationsResponse>(
            """{"task_id":"r","is_root":true,"summary":{"downstream_total":0,"would_unblock":0,
                "still_blocked":0,"in_flight_agents":3,"open_requests":2,"completes_container":true}}""",
        )
        assertEquals(
            listOf(
                "This is the root task — closing it marks the whole project complete.",
                "3 agents are working on it right now.",
                "2 open requests from its assignees would be orphaned.",
            ),
            CloseImplicationsUx.lines(resp),
        )
    }

    @Test
    fun quietTaskYieldsNoLinesAndNullIsEmpty() {
        val resp = json.decodeFromString<CloseImplicationsResponse>(
            """{"task_id":"q","summary":{"downstream_total":0,"in_flight_agents":0,"open_requests":0}}""",
        )
        assertTrue(CloseImplicationsUx.lines(resp).isEmpty())
        assertTrue(CloseImplicationsUx.lines(null).isEmpty())
        // free-text implications from a server that offers copy are passed through
        val copy = json.decodeFromString<CloseImplicationsResponse>("""{"implications":["a"," ","b"]}""")
        assertEquals(listOf("a", "b"), CloseImplicationsUx.lines(copy))
    }
}
