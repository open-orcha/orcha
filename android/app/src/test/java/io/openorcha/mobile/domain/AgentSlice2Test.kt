package io.openorcha.mobile.domain

import io.openorcha.mobile.data.ConfigRevisionDetailDto
import io.openorcha.mobile.data.ConfigRevisionPageDto
import io.openorcha.mobile.data.MeDto
import io.openorcha.mobile.data.OrgSnapshotDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.RunsResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Agent slice 2: config history, org lines, budget limits, access gating, recent runs. Payloads captured live. */
class AgentSlice2Test {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun configRevisionsDecodeAndRead() {
        val raw = """{"agent_id":"2b81","latest_revision_no":2,"total":2,"revisions":[
            {"revision_no":2,"kind":"change","source":"model","changes":[{"after":"claude-opus-5-5","field":"model","before":"claude-opus-5"}],
             "actor":null,"restored_from":null,"reason":null,"redacted_fields":[],"created_at":"2026-10-02T01:08:44.800306+00:00"},
            {"revision_no":1,"kind":"initial","source":"backfill","changes":[],"actor":null,"restored_from":null,"reason":null,
             "redacted_fields":[],"created_at":"2026-09-29T22:52:36.595331+00:00"}],"next_before":null}"""
        val page = json.decodeFromString<ConfigRevisionPageDto>(raw)
        assertEquals(2, page.latestRevisionNo)
        assertEquals(2, page.revisions.size)
        val change = page.revisions[0]
        assertEquals("Unattributed changed model", AgentConfigHistoryUx.sentence(change))
        assertEquals("Initial configuration captured", AgentConfigHistoryUx.sentence(page.revisions[1]))
        val c = change.changes.single()
        assertEquals("claude-opus-5 → claude-opus-5-5", "${AgentConfigHistoryUx.value(c.field, c.before)} → ${AgentConfigHistoryUx.value(c.field, c.after)}")
    }

    @Test
    fun revisionDetailDecodesRestorePreview() {
        val raw = """{"revision_no":1,"kind":"initial","snapshot":{"model":"claude-opus-5"},
            "restore_preview":[{"field":"model","current":"claude-opus-5-5","target":"claude-opus-5","grant":"manage_agents"}],"restore_blocked":[]}"""
        val d = json.decodeFromString<ConfigRevisionDetailDto>(raw)
        assertEquals("model", d.restorePreview.single().field)
        assertEquals("claude-opus-5", AgentConfigHistoryUx.value("model", d.restorePreview.single().target))
        assertTrue(d.restoreBlocked.isEmpty())
    }

    @Test
    fun configValuesReadLikeTheWeb() {
        assertEquals("Hourly", AgentConfigHistoryUx.value("auto_wake_interval_secs", JsonPrimitive(3600)))
        assertEquals("Every 15 min", AgentConfigHistoryUx.value("auto_wake_interval_secs", JsonPrimitive(900)))
        assertEquals("Off", AgentConfigHistoryUx.value("auto_wake_interval_secs", JsonNull))
        assertEquals("Inherit project", AgentConfigHistoryUx.value("autonomy_override", null))
        assertEquals("PR", AgentConfigHistoryUx.value("autonomy_override", JsonPrimitive("pr")))
        assertEquals("High", AgentConfigHistoryUx.value("reasoning_effort", JsonPrimitive("high")))
        assertEquals("Not set", AgentConfigHistoryUx.value("role", JsonPrimitive("")))
        assertEquals("Reasoning effort", AgentConfigHistoryUx.fieldLabel("reasoning_effort"))
    }

    @Test
    fun orgFlattenIndentsReportsUnderManagers() {
        val raw = """{"agents":[{"id":"h","reports_to":null},{"id":"atlas","reports_to":"h"},{"id":"probe","reports_to":"atlas"},{"id":"ferry","reports_to":"atlas"}]}"""
        val org = json.decodeFromString<OrgSnapshotDto>(raw)
        val managerOf = org.agents.mapNotNull { r -> r.reportsTo?.let { r.id to it } }.toMap()
        val nodes = AgentOrgUx.flatten(listOf("h", "atlas", "probe", "ferry"), managerOf)
        assertEquals(listOf("h" to 0, "atlas" to 1, "probe" to 2, "ferry" to 2), nodes.map { it.id to it.depth })
    }

    @Test
    fun orgFlattenSurvivesALoop() {
        val nodes = AgentOrgUx.flatten(listOf("a", "b"), mapOf("a" to "b", "b" to "a"))
        assertEquals(setOf("a", "b"), nodes.map { it.id }.toSet())
    }

    @Test
    fun managerCandidatesExcludeSelfReportsAndRetired() {
        val people = listOf(
            AgentOrgUx.Person("atlas", false, false),
            AgentOrgUx.Person("probe", false, false),
            AgentOrgUx.Person("deep", false, false),
            AgentOrgUx.Person("old", false, true),
            AgentOrgUx.Person("h", true, false),
        )
        val managerOf = mapOf("probe" to "atlas", "deep" to "probe")
        assertEquals(listOf("h"), AgentOrgUx.managerCandidates("atlas", people, managerOf))
        assertEquals(listOf("h", "atlas"), AgentOrgUx.managerCandidates("probe", people, managerOf))
        assertEquals("Probe now reports to Atlas", AgentOrgUx.changedToast("Probe", "Atlas"))
        assertEquals("Probe has no manager", AgentOrgUx.changedToast("Probe", null))
    }

    @Test
    fun parseLimitAndBudgetBody() {
        assertEquals(AgentControlsUx.Limit.None, AgentControlsUx.parseLimit("  ", false))
        assertEquals(AgentControlsUx.Limit.Value(1250.5), AgentControlsUx.parseLimit("$1,250.50", false))
        assertEquals(AgentControlsUx.Limit.Value(2000000.0), AgentControlsUx.parseLimit("2000000", true))
        assertEquals(AgentControlsUx.Limit.Invalid, AgentControlsUx.parseLimit("-3", false))
        assertEquals(AgentControlsUx.Limit.Invalid, AgentControlsUx.parseLimit("abc", true))
        val body = AgentControlsUx.budgetLimitsJson("me", AgentControlsUx.Limit.Value(50.0), AgentControlsUx.Limit.None)
        assertEquals("50.0", body["monthly_limit_usd"]!!.jsonPrimitive.content)
        // a cleared limit is an explicit null, never left out (left out = unchanged)
        assertEquals(JsonNull, body["monthly_limit_tokens"])
        assertEquals("""{"actor_agent_id":"me","monthly_limit_usd":50.0,"monthly_limit_tokens":null}""", json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), body))
        assertEquals("revoke", AgentControlsUx.overrideJson("me", grant = false)["override"]!!.jsonPrimitive.content)
        assertEquals("12.50", AgentControlsUx.usdField(12.5))
    }

    @Test
    fun accessGatingMatchesTheServer() {
        val selfHost = json.decodeFromString<MeDto>("""{"identity":null,"trusted":false}""")
        assertTrue(AgentControlsUx.canManage(selfHost, "manage_agents"))
        assertTrue(AgentControlsUx.canManage(null, "manage_agents"))
        val notMember = json.decodeFromString<MeDto>("""{"identity":null,"trusted":true}""")
        assertFalse(AgentControlsUx.canManage(notMember, "manage_agents"))
        val member = json.decodeFromString<MeDto>("""{"trusted":true,"identity":{"agent_id":"x","member_role":"member","grants":["manage_autonomy"]}}""")
        assertTrue(AgentControlsUx.canManage(member, "manage_autonomy"))
        assertFalse(AgentControlsUx.canManage(member, "manage_agents"))
        val viewer = json.decodeFromString<MeDto>("""{"trusted":true,"identity":{"agent_id":"x","member_role":"viewer","grants":["manage_agents"]}}""")
        assertFalse(AgentControlsUx.canManage(viewer, "manage_agents"))
        val owner = json.decodeFromString<MeDto>("""{"trusted":true,"identity":{"agent_id":"x","member_role":"owner","grants":[]}}""")
        assertTrue(AgentControlsUx.canManage(owner, "manage_agents"))
    }

    @Test
    fun recentRunsDecodeHeavyRowsAndMerge() {
        // Probe's real rows: headless runs carry a ~200 KB `output` + pid/worktree extras.
        val big = "x".repeat(200_000)
        val raw = """{"agent_id":"p","runs":[
            {"run_id":"r3","agent_id":"p","task_id":null,"wake_kind":"ephemeral","wake_event":"request_created","lane":"work","status":"exited","exit_code":0,"pid":64749,"output":"$big","diff":"","started_at":"2026-10-01T10:00:00+00:00"},
            {"run_id":"r2","agent_id":"p","status":"orphaned","exit_code":null,"output":null,"diff":null,"started_at":"2026-09-30T13:07:17+00:00"},
            {"run_id":"r1","agent_id":"p","status":"exited","exit_code":0,"output":"$big","started_at":"2026-09-29T09:00:00+00:00"}]}"""
        val headless = json.decodeFromString<RunsResponse>(raw).runs
        assertEquals(3, headless.size)
        val resident = listOf(RunDto(runId = "r2", startedAt = "2026-09-30T13:07:17+00:00"), RunDto(runId = "rr", startedAt = "2026-10-02T00:00:00+00:00"))
        val merged = AgentControlsUx.mergeRuns(headless, resident)
        assertEquals(listOf("rr", "r3", "r2", "r1"), merged.map { it.runId })
    }
}
