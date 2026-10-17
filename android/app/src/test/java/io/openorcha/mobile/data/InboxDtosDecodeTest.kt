package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Decoding cover for the Inbox slice DTOs against real (sanitised) portal payloads. */
class InboxDtosDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    private fun fixture(name: String): String =
        requireNotNull(javaClass.classLoader?.getResource("inbox/$name")) { "missing fixture $name" }.readText()

    @Test
    fun `notification prefs payload decodes catalog, locks, availability and defaults`() {
        val p = json.decodeFromString(NotifPrefsPayload.serializer(), fixture("notification_prefs.json"))
        assertEquals(9, p.catalog.categories.size)
        assertEquals(listOf("in_app", "desktop", "push", "slack"), p.catalog.channels.map { it.key })
        assertEquals("budget", p.catalog.locks.single().category)
        assertFalse(p.channels.getValue("push").available)
        assertEquals("mine", p.defaults.rules.getValue("tasks").scope)
        assertNull(p.defaults.pause)
        assertFalse(p.project.muted)
        assertTrue(p.editable)
    }

    @Test
    fun `pause distinguishes off, until-turned-back-on and a time`() {
        fun pause(raw: String) = json.decodeFromString(NotifDefaults.serializer(), """{"rules":{},"pause":$raw}""").pause
        assertNull(pause("null"))
        assertEquals(NotifPause(null), pause("""{"until":null}"""))
        assertEquals(1_800_000_000.0, pause("""{"until":1800000000}""")?.until)
    }

    @Test
    fun `routines list decodes schedule text, last run and string detail`() {
        val body = """
            {"routines":[{"id":"r1","container_id":"c","title":"Weekly digest {date}","title_preview":"Weekly digest Oct 5",
              "definition_of_done":"Posted","priority":100,"cron":"0 9 * * 1","timezone":"Africa/Nairobi",
              "schedule_text":"Every Monday at 9:00 AM","enabled":true,"skip_if_open":true,
              "next_run_at":"2026-10-05T06:00:00+00:00","last_run_at":null,
              "last_run":{"run_id":"x","outcome":"skipped","trigger":"scheduled","detail":"previous task still open",
                          "created_at":"2026-09-28T06:00:01+00:00","task_id":null,"task_status":null,"task_title":null,"missed_count":0}}],
             "scheduler":{"last_tick_at":"2026-10-02T14:21:20.821427+00:00"}}
        """.trimIndent()
        val r = json.decodeFromString(InboxRoutinesResponse.serializer(), body)
        val routine = r.routines.single()
        assertEquals("Weekly digest Oct 5", routine.displayTitle)
        assertEquals("Every Monday at 9:00 AM", routine.scheduleText)
        assertEquals("previous task still open", routine.lastRun?.detailText)
        assertNotNull(r.scheduler.lastTickAt)
    }

    @Test
    fun `members, repos and binding decode`() {
        val m = json.decodeFromString(
            InboxMembersResponse.serializer(),
            """{"members":[{"agent_id":"a1","alias":"alex","github_login":null,"member_role":"owner","grants":[],"pending":false}],"restricted":false}""",
        )
        assertEquals("owner", m.members.single().memberRole)
        val repos = json.decodeFromString(
            InboxGithubReposResponse.serializer(),
            """{"available":true,"repos":[{"full_name":"o/r","private":true,"description":null,"html_url":"https://github.com/o/r"}]}""",
        )
        assertTrue(repos.available)
        assertTrue(repos.repos.single().isPrivate)
        assertFalse(json.decodeFromString(InboxGithubReposResponse.serializer(), """{"available":false}""").available)
        assertNull(json.decodeFromString(InboxGithubBindingResponse.serializer(), """{"repo":null}""").repo)
    }
}
