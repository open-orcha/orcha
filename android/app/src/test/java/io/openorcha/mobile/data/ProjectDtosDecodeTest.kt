package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Decoding cover for the Project slice DTOs against real (sanitised) portal payloads. */
class ProjectDtosDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `limits decode`() {
        val l = json.decodeFromString(ProjectLimitsResponse.serializer(),
            """{"container_id":"c","max_auto_agents":12,"auto_agents_in_use":3,"min_max_auto_agents":1,"max_max_auto_agents":50}""")
        assertEquals(12, l.maxAutoAgents); assertEquals(3, l.autoAgentsInUse); assertEquals(50, l.maxMaxAutoAgents)
    }

    @Test
    fun `budgets decode with null limits and agents`() {
        val b = json.decodeFromString(ProjectBudgetsResponse.serializer(), """
            {"period":"2026-10","resets_at":"2026-11-01T00:00:00+00:00",
             "project":{"limits":{"usd":25.5,"tokens":null},"usage":{"spend_usd":1.2,"tokens":3400,"runs":2},"state":"ok","paused":false,
                        "override":{"active":false,"granted_by":null}},
             "agents":[{"limits":{"usd":null,"tokens":null},"usage":{"spend_usd":0.0,"tokens":0},"state":"none","paused":true,
                        "agent_id":"a1","alias":"atlas","blocked_by":null}]}
        """)
        assertEquals(25.5, b.project.limits.usd); assertNull(b.project.limits.tokens)
        assertEquals(3400L, b.project.usage.tokens)
        assertEquals("atlas", b.agents.single().alias); assertTrue(b.agents.single().paused)
    }

    @Test
    fun `performance decodes rates, medians and series`() {
        val p = json.decodeFromString(PerformanceResponse.serializer(), """
            {"range":"7d","since":"x","bucket_days":1,"min_sample":3,"generated_at":"x",
             "project":{"container_id":"c","name":"orcha-open","metrics":{"tasks_verified":4,
               "first_pass_rate":{"value":0.75,"numerator":3,"denominator":4,"enough":true},
               "rework":{"total":1,"human_rejections":1,"manager_send_backs":0},
               "median_time_to_verified_seconds":{"value":5400.0,"n":4,"enough":true},
               "cost_per_verified_task_usd":{"value":null,"metered_tasks":0,"unmetered_tasks":4,"total_metered_usd":null,"enough":false},
               "plan_approval_rate":{"value":null,"numerator":0,"denominator":0,"enough":false,"approved":0,"rejected":0},
               "escalations":2},
               "series":[{"start":"a","end":"b","verified":1,"rework":0},{"start":"b","end":"c","verified":3,"rework":1}]},
             "agents":[{"agent_id":"a1","alias":"atlas","model":"m","role":"r","retired":false,"metrics":{"tasks_verified":4},"series":[]}]}
        """)
        assertEquals(4, p.project.metrics.tasksVerified)
        assertEquals(0.75, p.project.metrics.firstPassRate.value)
        assertEquals(2, p.project.series.size)
        assertFalse(p.agents.single().metrics.firstPassRate.enough)
    }

    @Test
    fun `worktrees, preview and routine detail decode`() {
        val w = json.decodeFromString(AgentWorktreesResponse.serializer(), """
            {"container_id":"c","settings":{"auto_cleanup":false,"grace_days":14},
             "inventory":{"host":"h","items":[],"counts":{"clean":2,"in-use":1},"reclaimable_bytes":2048,"total_bytes":4096},"actions":[]}
        """)
        assertFalse(w.settings.autoCleanup); assertEquals(14, w.settings.graceDays); assertEquals(3, w.inventory!!.counts.values.sum())
        val pv = json.decodeFromString(SchedulePreviewResponse.serializer(),
            """{"valid":false,"error":"Bad cron","schedule_text":null,"next_runs":[]}""")
        assertFalse(pv.valid); assertEquals("Bad cron", pv.error)
        val r = json.decodeFromString(RoutineDetailDto.serializer(), """
            {"id":"r1","container_id":"c","title":"Audit","definition_of_done":"Done","assignee_agent_id":"a1","priority":20,
             "cron":"0 9 * * 1-5","timezone":"Africa/Nairobi","schedule_text":"Every weekday at 09:00 Nairobi time","enabled":true,"skip_if_open":false}
        """)
        assertEquals("a1", r.assigneeAgentId); assertEquals(20, r.priority); assertFalse(r.skipIfOpen)
    }

    @Test
    fun `members decode grants`() {
        val m = json.decodeFromString(ProjectMembersResponse.serializer(),
            """{"members":[{"agent_id":"h","alias":"x","member_role":"member","grants":["manage_autonomy"],"pending":false}],"restricted":true}""")
        assertEquals(listOf("manage_autonomy"), m.members.single().grants)
    }
}
