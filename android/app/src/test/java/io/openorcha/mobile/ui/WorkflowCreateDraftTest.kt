package io.openorcha.mobile.ui

import io.openorcha.mobile.data.WorkflowCreateBody
import io.openorcha.mobile.data.WorkflowPreviewDto
import io.openorcha.mobile.data.WorkflowWrites
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The W10 draft builds the live `/openapi.json` WorkflowCreate body (semantics v2, routes by list). */
class WorkflowCreateDraftTest {
    private val wire = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    private fun draft() = WorkflowCreateDraft("c1:h1").apply {
        title = " Ship it "
        goal = "Android workflows"
        steps[0] = steps[0].copy(title = "Build", done = "Compiles", assigneeId = "a1")
        val review = newStep().copy(
            title = "Review", dependsOn = listOf("s1"),
            outcomes = listOf("Pass", "Changes requested"),
            routes = listOf(
                WorkflowCreateDraft.Route("Pass", "exit_group"),
                WorkflowCreateDraft.Route("Changes requested", "step", "s1"),
                WorkflowCreateDraft.Route("Dropped outcome", "stop"),
            ),
        )
        steps.add(review)
        group = WorkflowCreateDraft.Group(name = "Loop", members = listOf("s1", review.clientKey), reviewTask = review.clientKey, exitOutcome = "Pass")
    }

    private fun encode(body: WorkflowCreateBody): JsonObject =
        wire.parseToJsonElement(wire.encodeToString(WorkflowCreateBody.serializer(), body)).jsonObject

    @Test fun createBodyUsesSnakeCaseAndSemanticsTwo() {
        val d = draft()
        val json = encode(d.createBody("digest-1"))
        assertEquals("Ship it", json["title"]!!.jsonPrimitive.content)
        assertEquals("2", json["semantics_version"]!!.jsonPrimitive.content)
        assertEquals("digest-1", json["preview_digest"]!!.jsonPrimitive.content)
        assertEquals(d.idempotencyKey, json["idempotency_key"]!!.jsonPrimitive.content)
        assertEquals("serial", json["execution_mode"]!!.jsonPrimitive.content)
        assertFalse("objectives" in json, "empty objectives are omitted")
    }

    @Test fun routesKeepOnlyDeclaredOutcomesAndStepTargets() {
        val tasks = encode(draft().createBody(null))["tasks"]!!.jsonArray
        val review = tasks[1].jsonObject
        val routes = review["routes"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("Pass", "Changes requested"), routes.map { it["outcome"]!!.jsonPrimitive.content })
        assertFalse("destination_task" in routes[0], "exit_group carries no destination task")
        assertEquals("s1", routes[1]["destination_task"]!!.jsonPrimitive.content)
        assertEquals(listOf("s1"), review["depends_on"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertFalse("routes" in tasks[0].jsonObject)
    }

    @Test fun repeatGroupTravelsInTheCreateBody() {
        val groups = encode(draft().createBody(null))["repeat_groups"]!!.jsonArray
        val g = groups.single().jsonObject
        assertEquals("s2", g["review_task"]!!.jsonPrimitive.content)
        assertEquals("Pass", g["exit_outcome"]!!.jsonPrimitive.content)
        assertEquals("5", g["max_rounds"]!!.jsonPrimitive.content)
        assertEquals(2, g["member_tasks"]!!.jsonArray.size)
    }

    @Test fun groupWithoutReviewStepIsNotSent() {
        val d = draft().apply { group = group!!.copy(reviewTask = null) }
        assertNull(d.draftBody().repeatGroups)
    }

    @Test fun saveNeedsACleanReviewOfThisExactDraft() {
        val d = draft()
        assertFalse(d.reviewedClean)
        d.preview = WorkflowPreviewDto(previewDigest = "x")
        d.previewedFor = d.draftBody()
        assertTrue(d.reviewedClean)
        d.goal = "changed"
        assertFalse(d.reviewedClean, "editing after review needs a new review")
    }

    @Test fun dependentsBlockRemoval() {
        val d = draft()
        assertEquals(listOf("s2"), d.dependents("s1").map { it.clientKey })
        assertTrue(d.dependents("s2").isEmpty())
    }

    @Test fun createWriteTargetsTheCollectionWithCreateReceipt() {
        val d = draft()
        val w = WorkflowWrites.create("c1", d.createBody(null))
        assertEquals("/api/containers/c1/workflows", w.path)
        assertEquals("create", w.operation)
        assertEquals(d.idempotencyKey, w.idempotencyKey)
    }
}
