package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Decoding of the task-detail parity payloads (real shapes captured from a live portal). */
class TaskInsightsDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun evidencePackDecodes() {
        val raw = """
        {"version":2,"task_id":"t1","task_status":"needs_verification","built_at":"2026-10-02T14:21:26.848210+00:00",
         "round_started_at":null,
         "runs":[{"run_id":"r1","agent_alias":"Atlas","status":"exited","exit_code":0,"lane":"work"}],
         "tests":{"status":"none","passed":0,"failed":0,"skipped":0,"errors":0,"suites":0,"invocations":0,"latest":[],"earlier":0},
         "changes":{"files":2,"additions":6,"deletions":2,"categories":{"ci":1},"summary":"Changed 2 files (+6 −2).","ui_touching":false,
           "flags":[],"list":[{"path":".github/workflows/ci.yml","status":"M","additions":5,"deletions":1,"binary":null,"run_id":"r1"}],
           "truncated_list":false,"unavailable_runs":[]},
         "flags":[{"kind":"ci","label":"CI / infrastructure","detail":"1 CI file(s).","severity":"warn","files":[".github/workflows/ci.yml"],"count":1}],
         "branch":"orcha/task-x","pr_urls":["https://github.com/o/r/pull/130"],"preview_urls":[],
         "links":[{"kind":"pr","label":"PR #130","href":"https://github.com/o/r/pull/130"},{"kind":"runs","label":"Runs (3)","href":"/tasks?task=t1&tab=runs"}],
         "claim":{"text":"done","truncated":false},"dod_text":"a\nb",
         "dod":{"items":[{"index":0,"text":"a","status":"not_proven","basis":"changes","evidence":"Not among the changed files"},
                         {"index":1,"text":"b","status":"needs_human","basis":"none","evidence":null,"claim":"I did b"}],
                "total":2,"proven":0,"not_proven":1,"needs_human":1},
         "verdikt":null,
         "summary":{"dod":{"total":2,"proven":0,"not_proven":1,"needs_human":1},"tests":{"status":"none","passed":0,"failed":0,"skipped":0,"errors":0,"suites":0},
                    "risk_flags":1,"verdikt":null,"line":"0/2 DoD items evidenced · no tests ran · 1 risk flag","autofix":null}}
        """
        val pack = json.decodeFromString<EvidencePackDto>(raw)
        assertEquals("t1", pack.taskId)
        assertEquals(2, pack.dod.items.size)
        assertEquals("not_proven", pack.dod.items[0].status)
        assertEquals("I did b", pack.dod.items[1].claim)
        assertEquals("CI / infrastructure", pack.flags.single().label)
        assertEquals(1, pack.summary.riskFlags)
        assertEquals(2, pack.changes.files)
        assertNull(pack.verdikt)
    }

    @Test
    fun goalChainDecodes() {
        val raw = """{"task_id":"t1","goal_chain":[
            {"kind":"objective","id":"root","title":"fleet-mate","text":null,"source":null,"status":null,"via":null},
            {"kind":"parent","id":"p1","title":"Parent","status":"in_progress","via":"task_request"},
            {"kind":"task","id":"t1","title":"Me","status":"needs_verification"}],"truncated":false,"cycle":false}"""
        val chain = json.decodeFromString<GoalChainDto>(raw)
        assertEquals(listOf("objective", "parent", "task"), chain.goalChain.map { it.kind })
        assertEquals("task_request", chain.goalChain[1].via)
    }

    @Test
    fun verdiktRunsDecodeWithSettingsOnly() {
        val raw = """{"task_id":"t1","settings":{"configured":false,"enabled":false,"base_url":null,"target_kind":"web","trigger_mode":"manual"},
            "runs":[],"autofix":{"override":"inherit"}}"""
        val r = json.decodeFromString<VerdiktRunsResponse>(raw)
        assertFalse(r.settings!!.enabled)
        assertTrue(r.runs.isEmpty())
    }

    @Test
    fun taskCarriesReviewFields() {
        val raw = """{"id":"t1","title":"x","status":"needs_verification",
            "reviewer_agent_id":"h1","reviewer":{"agent_id":"h1","alias":"maya"},
            "review_routing":{"routed_via":"reports_to","manager_depth":1,"assignee_alias":"Atlas","reviewer_alias":"maya"},
            "manager_review":{"status":"approved","manager_alias":"Forge","recommendation":"approve","reasons":"looks good"}}"""
        val t = json.decodeFromString<TaskDto>(raw)
        assertEquals("h1", t.reviewerAgentId)
        assertEquals("reports_to", t.reviewRouting?.routedVia)
        assertEquals("approved", t.managerReview?.status)
    }

    @Test
    fun routineBodyEncodesSnakeCase() {
        val body = RoutineCreateBody("h1", "T", null, "dod", "a1", 100, "0 9 * * 1-5", "Africa/Nairobi", true, true, "t1")
        val s = Json.encodeToString(RoutineCreateBody.serializer(), body)
        assertTrue("\"origin_task_id\":\"t1\"" in s)
        assertTrue("\"skip_if_open\":true" in s)
        assertTrue("\"actor_agent_id\":\"h1\"" in s)
    }
}
