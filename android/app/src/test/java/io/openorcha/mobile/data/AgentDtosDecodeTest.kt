package io.openorcha.mobile.data

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Agent slice payloads decode from the real server shapes (captured from a live stack). */
class AgentDtosDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun agentBudgetDecodesNoneState() {
        val raw = """{"period":"2026-10","starts_at":"2026-10-01T00:00:00+00:00","resets_at":"2026-11-01T00:00:00+00:00",
            "limits":{"usd":null,"tokens":null},"usage":{"spend_usd":0.0,"metered_runs":0,"unmetered_runs":0,
            "unmetered_tokens":0,"tokens":0,"cache_tokens":0,"runs":0,"in_flight_runs":0},"state":"none",
            "usd_ratio":null,"token_ratio":null,"limits_reached":[],"paused":false,
            "override":{"active":false,"granted_by":null,"granted_at":null,"note":null},"updated_at":null,
            "agent_id":"94c06e92-5a42-49e4-b6e4-69176fea3188","alias":"atlas","blocked_by":null,"reason":null,
            "project":{"state":"none"}}"""
        val b = json.decodeFromString<AgentBudgetDto>(raw)
        assertEquals("none", b.state)
        assertEquals("2026-10", b.period)
        assertNull(b.limits.usd)
        assertFalse(b.paused)
        assertEquals("atlas", b.alias)
    }

    @Test
    fun agentBudgetDecodesPausedWithLimits() {
        val raw = """{"limits":{"usd":50.0,"tokens":1000000},"usage":{"spend_usd":51.2,"metered_runs":4,"tokens":120000},
            "state":"exceeded","usd_ratio":1.024,"paused":true,"blocked_by":"agent",
            "reason":"Monthly budget reached (${'$'}51.20 of ${'$'}50.00)","override":{"active":false}}"""
        val b = json.decodeFromString<AgentBudgetDto>(raw)
        assertEquals(50.0, b.limits.usd)
        assertEquals(1_000_000L, b.limits.tokens)
        assertTrue(b.paused)
        assertEquals("agent", b.blockedBy)
        assertEquals(4, b.usage.meteredRuns)
    }

    @Test
    fun overrideBodyOmitsLimitsSoTheServerKeepsThem() {
        val body = json.encodeToString(BudgetOverrideBody("h1", "grant", null))
        assertEquals("""{"actor_agent_id":"h1","override":"grant"}""", body)
    }

    @Test
    fun containerBudgetsDecodeAgentsList() {
        val raw = """{"period":"2026-10","agents":[{"agent_id":"a1","paused":true},{"agent_id":"a2"}]}"""
        val c = json.decodeFromString<ContainerBudgetsDto>(raw)
        assertEquals(listOf("a1", "a2"), c.agents.map { it.agentId })
        assertTrue(c.agents[0].paused)
    }

    @Test
    fun reportsToDecodesChain() {
        val raw = """{"agent_id":"a","reports_to_agent_id":"m","reports_to_alias":"lead",
            "chain":[{"id":"m","alias":"lead","kind":"ai","member_role":null,"terminated":false},
                     {"id":"h","alias":"hussein","kind":"human","member_role":"owner","terminated":false}]}"""
        val r = json.decodeFromString<ReportsToDto>(raw)
        assertEquals("lead", r.reportsToAlias)
        assertEquals(listOf("lead", "hussein"), r.chain.map { it.alias })
        assertEquals("human", r.chain[1].kind)
    }

    @Test
    fun runChangesDecodeFullAndUnchanged() {
        val full = """{"available":true,"running":true,"run_status":"running","source":"live","root":"worktree",
            "branch":"agent/x","base":{"kind":"merge_base","ref":"origin/main","sha":"abc"},"shared_checkout":false,
            "files":[{"path":"src/a.kt","status":"M","additions":3,"deletions":1},
                     {"path":"img/logo.png","status":"A","additions":0,"deletions":0,"binary":true}],
            "summary":{"files":2,"additions":3,"deletions":1},"truncated":false,"version":"v1","as_of":"t"}"""
        val c = json.decodeFromString<RunChangesDto>(full)
        assertEquals(2, c.files.size)
        assertTrue(c.files[1].binary)
        assertEquals("v1", c.version)
        assertFalse(c.unchanged)
        val same = json.decodeFromString<RunChangesDto>("""{"unchanged":true,"version":"v1","running":true,"as_of":"t"}""")
        assertTrue(same.unchanged)
        assertTrue(same.files.isEmpty())
    }

    @Test
    fun runChangesUnavailableAndDiff() {
        val c = json.decodeFromString<RunChangesDto>("""{"available":false,"reason":"git_error","detail":"x"}""")
        assertFalse(c.available)
        val d = json.decodeFromString<RunChangeDiffDto>("""{"available":true,"path":"a","diff":"@@","binary":false,"truncated":false,"source":"live"}""")
        assertEquals("@@", d.diff)
    }

    @Test
    fun chatRunMatchesConversationByIdThenLane() {
        val byId = ChatRunDto(runId = "r", status = "running", conversationId = "c1")
        assertTrue(byId.answers("c1"))
        assertFalse(byId.answers("c2"))
        assertTrue(ChatRunDto(runId = "r", wakeEvent = "conversation_turn").answers(null))
        assertTrue(ChatRunDto(runId = "r", lane = "conversation").answers("c1"))
        assertFalse(ChatRunDto(runId = "r", wakeEvent = "task_assigned").answers("c1"))
    }
}
