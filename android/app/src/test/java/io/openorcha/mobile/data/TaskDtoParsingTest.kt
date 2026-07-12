package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Regression cover for the "can't reach your laptop" bug: the server sends
 * tasks[].plan_decision as an OBJECT once a plan has been approved/rejected, but the app
 * first modelled it as a bare String, so snapshot parsing threw and was mislabelled as a
 * connection failure. [FlexiblePlanDecisionSerializer] must accept the object (and the
 * legacy string / null) and yield the verdict.
 */
class TaskDtoParsingTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `object-shaped plan_decision parses to the verdict`() {
        val body = """
            {"id":"t1","title":"Ship it","status":"in_progress",
             "plan_decision":{"decision":"approve","reason":null,"actor":"kedar","at":"2026-07-02T03:22:12+00:00"}}
        """.trimIndent()
        val task = json.decodeFromString(TaskDto.serializer(), body)
        assertEquals("approve", task.planDecision)
    }

    @Test
    fun `rejected plan_decision keeps its verdict`() {
        val body = """
            {"id":"t2","title":"Nope","status":"in_progress",
             "plan_decision":{"decision":"reject","reason":"not yet","actor":"kedar","at":"2026-07-02T03:22:12+00:00"}}
        """.trimIndent()
        val task = json.decodeFromString(TaskDto.serializer(), body)
        assertEquals("reject", task.planDecision)
    }

    @Test
    fun `absent plan_decision stays null`() {
        val body = """{"id":"t3","title":"Fresh","status":"in_progress"}"""
        val task = json.decodeFromString(TaskDto.serializer(), body)
        assertNull(task.planDecision)
    }

    @Test
    fun `legacy string plan_decision still parses`() {
        val body = """{"id":"t4","title":"Old row","status":"in_progress","plan_decision":"approve"}"""
        val task = json.decodeFromString(TaskDto.serializer(), body)
        assertEquals("approve", task.planDecision)
    }
}
