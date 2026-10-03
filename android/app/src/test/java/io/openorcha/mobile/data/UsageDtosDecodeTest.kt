package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Decoding cover for the Usage slice DTOs against real (trimmed) portal payloads. */
class UsageDtosDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `metrics summary decodes`() {
        val raw = """{"container_id":"c","days":7,"totals":{"runs":67,"sandbox_seconds":0.0,"est_cost_usd":53.62863,
            "tokens_in":1566,"tokens_out":346650,"runs_with_cost":58,"runs_with_tokens":58,"tasks_completed":1,"tasks_verified":1},
            "per_agent":[{"agent_id":"a1","alias":"Atlas","model":"claude-opus-5-5","runs":56,"ok_runs":54,"failed_runs":1,
            "sandbox_seconds":0.0,"est_cost_usd":43.531696,"tokens_in":1176,"tokens_out":273686,"runs_with_tokens":49,
            "last_active":"2026-10-02T02:47:55+00:00"},{"agent_id":"a2","alias":"Ferry","model":null,"runs":6,"ok_runs":6,
            "failed_runs":0,"sandbox_seconds":0.0,"est_cost_usd":5.96,"tokens_in":228,"tokens_out":45524,"runs_with_tokens":5}],
            "daily":[{"date":"2026-09-26","runs":0,"est_cost_usd":0.0,"sandbox_seconds":0.0}]}"""
        val d = json.decodeFromString<MetricsSummaryResponse>(raw)
        assertEquals(67, d.totals.runs)
        assertEquals(58, d.totals.runsWithCost)
        assertEquals(346650L, d.totals.tokensOut)
        assertEquals("claude-opus-5-5", d.perAgent[0].model)
        assertNull(d.perAgent[1].model)
        assertEquals(54, d.perAgent[0].okRuns)
        assertEquals("2026-09-26", d.daily.single().date)
    }

    @Test
    fun `token usage decodes windows, agents and last wake`() {
        val raw = """{"container_id":"c","windows":{"5h":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,
            "cache_creation_input_tokens":0,"total_tokens":0,"total_cost_usd":0.0,"runs":0,"quota_tokens":null,"pct_of_quota":null},
            "7d":{"input_tokens":1566,"output_tokens":346650,"cache_read_input_tokens":35049893,"cache_creation_input_tokens":2056240,
            "total_tokens":37454349,"total_cost_usd":53.62863,"runs":58,"quota_tokens":50000000,"pct_of_quota":74.9}},
            "per_agent":[{"agent_id":"a1","alias":"Atlas","runs":49,"total_tokens":28483709,"total_cost_usd":43.53}],
            "last_wake":{"run_id":"r1","agent_alias":"Atlas","ended_at":"2026-10-02T02:47:55+00:00","total_tokens":233945,"total_cost_usd":0.33}}"""
        val d = json.decodeFromString<TokenUsageResponse>(raw)
        assertNull(d.windows["5h"]!!.quotaTokens)
        assertEquals(35049893L, d.windows["7d"]!!.cacheReadInputTokens)
        assertEquals(50_000_000L, d.windows["7d"]!!.quotaTokens)
        assertEquals("Atlas", d.perAgent.single().alias)
        assertEquals("r1", d.lastWake?.runId)
    }

    @Test
    fun `token usage tolerates a null last wake`() {
        val d = json.decodeFromString<TokenUsageResponse>("""{"windows":{},"per_agent":[],"last_wake":null}""")
        assertNull(d.lastWake)
    }

    @Test
    fun `agent spend and insights decode`() {
        val spend = json.decodeFromString<AgentSpendResponse>(
            """{"agent":{"id":"a1","alias":"Atlas","model":"claude-opus-5-5","reasoning_effort":null},"window":"7d",
            "totals":{"input_tokens":1176,"output_tokens":273686,"cache_read_input_tokens":26554948,"cache_creation_input_tokens":1653899,
            "total_tokens":28483709,"total_cost_usd":43.531696,"runs":49,"runs_with_cost":49},
            "tasks":[{"task_id":null,"title":null,"status":null,"runs":31,"total_tokens":100,"total_cost_usd":23.07,"runs_with_cost":31},
            {"task_id":"t1","title":"Weekly Audit","status":"needs_verification","runs":3,"total_tokens":3860211,"total_cost_usd":4.31,"runs_with_cost":3}]}""",
        )
        assertEquals(49, spend.totals.runsWithCost)
        assertNull(spend.tasks[0].taskId)
        assertEquals("needs_verification", spend.tasks[1].status)
        val ins = json.decodeFromString<SpendInsightsResponse>(
            """{"window":"7d","insights":[{"id":"concentration:__none__","severity":"info","title":"T","detail":"D",
            "evidence":{"task_id":null,"task_cost_usd":23.07,"fraction":0.4303},"action":"A"}]}""",
        )
        assertEquals("info", ins.insights.single().severity)
        assertEquals(3, ins.insights.single().evidence.size)
    }
}
