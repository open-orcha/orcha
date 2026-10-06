package io.openorcha.mobile.domain

import io.openorcha.mobile.data.MxAgentDto
import io.openorcha.mobile.data.MxTotalsDto
import io.openorcha.mobile.data.SpendInsightDto
import io.openorcha.mobile.data.TokenWindowDto
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UsageLogicTest {
    @Test
    fun `formatters match the web`() {
        assertEquals("$53.63", UsageFormat.usd(53.62863))
        assertEquals("$0.0050", UsageFormat.usd(0.005))
        assertEquals("$1,234", UsageFormat.usd(1234.4))
        assertEquals("37.5M", UsageFormat.tokens(37_454_349))
        assertEquals("346.7K", UsageFormat.tokens(346_650))
        assertEquals("1.6K", UsageFormat.tokens(1566))
        assertEquals("1K", UsageFormat.tokens(1000))
        assertEquals("999", UsageFormat.tokens(999))
        assertEquals("0s", UsageFormat.duration(0.0))
        assertEquals("2m 5s", UsageFormat.duration(125.0))
        assertEquals("1h 0m", UsageFormat.duration(3600.0))
        assertEquals("Sep 26", UsageFormat.day("2026-09-26"))
    }

    @Test
    fun `cost captions are honest`() {
        assertEquals("from 58 of 67 runs", UsageFormat.costCaptionShort(MxTotalsDto(runs = 67, runsWithCost = 58)))
        assertEquals("all runs reported", UsageFormat.costCaptionShort(MxTotalsDto(runs = 5, runsWithCost = 5)))
        assertEquals("see tokens", UsageFormat.costCaptionShort(MxTotalsDto(runs = 5, runsWithCost = 0)))
        assertEquals("no runs", UsageFormat.costCaptionShort(MxTotalsDto()))
        assertTrue(UsageFormat.costUnreported(MxTotalsDto(runs = 2, runsWithCost = 0)))
        assertEquals(UsageFormat.NOT_REPORTED, UsageFormat.usdOrNotReported(0.0, known = false))
        assertEquals("$0.00", UsageFormat.usdOrNotReported(0.0, known = true))
    }

    @Test
    fun `health follows the failed-run ratio`() {
        assertEquals(RunHealth.NoData, UsageFormat.health(MxAgentDto(runs = 0)))
        assertEquals(RunHealth.OnTrack, UsageFormat.health(MxAgentDto(runs = 56, okRuns = 54, failedRuns = 1)))
        assertEquals(RunHealth.AtRisk, UsageFormat.health(MxAgentDto(runs = 10, failedRuns = 1)))
        assertEquals(RunHealth.OffTrack, UsageFormat.health(MxAgentDto(runs = 10, failedRuns = 2)))
        assertEquals("54 of 56 runs succeeded · 1 failed", UsageFormat.healthDetail(MxAgentDto(runs = 56, okRuns = 54, failedRuns = 1)))
    }

    @Test
    fun `cost bars and sorting`() {
        assertNull(UsageFormat.costBarFraction(0.0, 10.0, known = false))
        assertNull(UsageFormat.costBarFraction(0.01, 10.0, known = true))
        assertEquals(0.5f, UsageFormat.costBarFraction(5.0, 10.0, known = true))
        val sorted = UsageFormat.sortAgents(
            listOf(MxAgentDto(alias = "B", estCostUsd = 1.0), MxAgentDto(alias = "A", estCostUsd = 9.0)), byTokens = false,
        )
        assertEquals("A", sorted.first().alias)
    }

    @Test
    fun `model names prefer the catalog then a readable id`() {
        assertEquals("Opus 5.5", UsageFormat.modelName("claude-opus-5-5", mapOf("claude-opus-5-5" to "Opus 5.5")))
        assertEquals("Haiku 4.5", UsageFormat.modelName("claude-haiku-4-5-20251001", emptyMap()))
        assertEquals("gpt-5-codex", UsageFormat.modelName("gpt-5-codex", emptyMap()))
        assertNull(UsageFormat.modelName(null, emptyMap()))
    }

    @Test
    fun `token mix and quota`() {
        val w = TokenWindowDto(inputTokens = 25, outputTokens = 25, cacheReadInputTokens = 50, totalTokens = 100, quotaTokens = 200, pctOfQuota = 50.0)
        val mix = UsageFormat.tokenMix(w)
        assertEquals(listOf("Input", "Output", "Cache read", "Cache write"), mix.map { it.label })
        assertEquals(0.5, mix[2].fraction)
        assertEquals("50%", UsageFormat.percent(mix[2].fraction))
        assertEquals(0.5, UsageFormat.quotaFraction(w))
        assertEquals(0.5, UsageFormat.quotaFraction(w.copy(pctOfQuota = null)))
        assertNull(UsageFormat.quotaFraction(TokenWindowDto()))
    }

    @Test
    fun `spend cost state`() {
        assertEquals("full", UsageFormat.spendCostState(3, 1.0, 3))
        assertEquals("partial", UsageFormat.spendCostState(3, 1.0, 1))
        assertEquals("none", UsageFormat.spendCostState(3, 0.0, 0))
        assertEquals("none", UsageFormat.spendCostState(3, 0.0, null))
        assertEquals("$1.00 · partial", UsageFormat.spendCostText(3, 1.0, 1))
        assertEquals("7d", UsageFormat.insightsWindowFor("5h"))
        assertEquals("all", UsageFormat.insightsWindowFor("30d"))
    }

    @Test
    fun `insights are scoped to one agent and evidence reads as chips`() {
        val agentRule = SpendInsightDto(id = "wake-churn:a1", evidence = JsonObject(mapOf("agent_alias" to JsonPrimitive("Atlas"))))
        val otherAgent = SpendInsightDto(id = "wake-churn:a2")
        val taskRule = SpendInsightDto(id = "context-bloat:t1")
        val windowRule = SpendInsightDto(id = "cache-write-churn")
        val got = UsageFormat.insightsForAgent(listOf(agentRule, otherAgent, taskRule, windowRule), "a1", "Atlas", listOf("t1", null))
        assertEquals(listOf("wake-churn:a1", "context-bloat:t1"), got.map { it.id })
        val chips = UsageFormat.evidenceChips(
            SpendInsightDto(
                evidence = JsonObject(
                    mapOf("task_id" to JsonNull, "task_cost_usd" to JsonPrimitive(23.078), "fraction" to JsonPrimitive(0.4303),
                        "cache_read_input_tokens" to JsonPrimitive(35_049_893)),
                ),
            ),
        )
        assertEquals(listOf("Task cost $23.08", "Share of spend 43%", "Cache reads 35M"), chips)
    }
}
