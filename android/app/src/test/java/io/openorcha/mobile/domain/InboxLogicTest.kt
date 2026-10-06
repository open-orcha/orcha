package io.openorcha.mobile.domain

import io.openorcha.mobile.data.InboxGithubRepoDto
import io.openorcha.mobile.data.InboxRoutineRunDto
import io.openorcha.mobile.data.NotifCatalog
import io.openorcha.mobile.data.NotifCategory
import io.openorcha.mobile.data.NotifChannel
import io.openorcha.mobile.data.NotifChannelAvailability
import io.openorcha.mobile.data.NotifDefaults
import io.openorcha.mobile.data.NotifLock
import io.openorcha.mobile.data.NotifPartialRule
import io.openorcha.mobile.data.NotifPause
import io.openorcha.mobile.data.NotifPrefsPayload
import io.openorcha.mobile.data.NotifProject
import io.openorcha.mobile.data.NotifRule
import io.openorcha.mobile.data.TaskDto
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class InboxLogicTest {

    // ── requests ──

    @Test
    fun `legacy code-thread payload drops the agent-only blocks`() {
        val payload = "[code thread — teach] local@8cf5234 deploy/docker-compose.yml:1-1\n" +
            "How does this compose file start the portal?" +
            "\n\nanswer as a short lesson in markdown with <lesson title>" +
            "\n\nreply via POST /api/code/threads/0f6c1e2a-1111-2222-3333-444455556666/messages {body}"
        val h = RequestHumanText.humanize(payload, null)
        assertEquals("How does this compose file start the portal?", h.body)
        assertNull(h.title)
    }

    @Test
    fun `display title from detail wins and plain payloads pass through`() {
        val detail = Json.parseToJsonElement("""{"display_title":"Why · retries — api.ts L4–9","code_thread":{"path":"api.ts"}}""")
        val h = RequestHumanText.humanize("Why does this retry?", detail)
        assertEquals("Why · retries — api.ts L4–9", h.title)
        assertEquals("Why does this retry?", h.body)
        assertEquals("Plain question", RequestHumanText.humanize("Plain question", null).body)
    }

    @Test
    fun `auto-resolved wording matches the web`() {
        assertEquals(
            "Resolved automatically — the code thread was resolved",
            RequestHumanText.autoResolvedText(Json.parseToJsonElement("""{"auto_resolved":"thread_resolved"}""")),
        )
        assertEquals(
            "Resolved automatically — answered in the code thread",
            RequestHumanText.autoResolvedText(Json.parseToJsonElement("""{"auto_resolved":"thread_answered"}""")),
        )
        assertNull(RequestHumanText.autoResolvedText(null))
    }

    // ── portal links ──

    private val task = TaskDto(id = "1234abcd-0000-4000-8000-000000000000", title = "Ship the login page")

    @Test
    fun `bare portal paths become labelled chips with in-app targets`() {
        val text = "See /tasks?task=1234abcd-0000-4000-8000-000000000000, then /requests?req=99887766aa and /code?path=src/a.ts&thread=t1."
        val m = PortalLinks.find(text, null, listOf(task))
        assertEquals(listOf("Open task · Ship the login page", "Open request 99887766", "Open thread in Code"), m.map { it.label })
        assertEquals(PortalTarget.Task(task.id), m[0].target)
        assertEquals(PortalTarget.Request("99887766aa"), m[1].target)
        assertIs<PortalTarget.Page>(m[2].target)
        // trailing punctuation stays outside the chip
        assertEquals("/code?path=src/a.ts&thread=t1", m[2].path)
    }

    @Test
    fun `full URLs only chip on the paired server`() {
        val text = "Open http://127.0.0.1:8001/agents?agent=builder or https://example.com/tasks?task=x"
        val m = PortalLinks.find(text, "http://127.0.0.1:8001", emptyList())
        assertEquals(1, m.size)
        assertEquals(PortalTarget.Agent("builder"), m.single().target)
        assertEquals("Open agent builder", m.single().label)
        assertTrue(PortalLinks.find("/codex and /code/foo", null).isEmpty())
    }

    // ── notification prefs ──

    private fun payload(project: NotifProject = NotifProject(), pause: NotifPause? = null) = NotifPrefsPayload(
        catalog = NotifCatalog(
            categories = listOf(NotifCategory("budget", "Budget alerts"), NotifCategory("tasks", "Tasks")),
            channels = listOf(NotifChannel("in_app", "In-app"), NotifChannel("push", "Mobile push"), NotifChannel("slack", "Slack")),
            locks = listOf(NotifLock("budget", "in_app", "Budget hard stops always show in the app.")),
        ),
        channels = mapOf(
            "in_app" to NotifChannelAvailability(true),
            "push" to NotifChannelAvailability(false),
            "slack" to NotifChannelAvailability(false),
        ),
        defaults = NotifDefaults(
            rules = mapOf(
                "budget" to NotifRule("all", mapOf("in_app" to false, "push" to true)),
                "tasks" to NotifRule("mine", mapOf("in_app" to true, "push" to false)),
            ),
            pause = pause,
        ),
        project = project,
    )

    @Test
    fun `effective rules merge the override and force locks on`() {
        val p = payload(NotifProject(rules = mapOf("tasks" to NotifPartialRule(scope = "off"))))
        val eff = NotifPrefsLogic.effectiveRules(p)
        assertEquals(true, eff.getValue("budget").channels["in_app"])
        assertEquals("off", eff.getValue("tasks").scope)
        assertEquals(true, eff.getValue("tasks").channels["in_app"])
        assertEquals("Budget hard stops always show in the app.", NotifPrefsLogic.lockReason(p, "budget", "in_app"))
        assertTrue(NotifPrefsLogic.isOverridden(p, "tasks"))
    }

    @Test
    fun `project override edits keep the other categories and can drop one`() {
        val p = payload(NotifProject(rules = mapOf("tasks" to NotifPartialRule(scope = "off"))))
        val next = NotifPrefsLogic.projectOverrideWith(p, "budget", NotifRule("mine", mapOf("push" to false)))
        assertEquals(setOf("tasks", "budget"), next.keys)
        assertEquals("off", next.getValue("tasks").scope)
        assertEquals(emptySet(), NotifPrefsLogic.projectOverrideWithout(p, "tasks").keys)
        assertEquals(2, NotifPrefsLogic.defaultsWith(p, "tasks", NotifRule("all")).size)
    }

    @Test
    fun `pause choices and text`() {
        val zone = ZoneId.of("Europe/London")
        val now = ZonedDateTime.of(2026, 10, 2, 15, 0, 0, 0, zone)
        assertNull(NotifPrefsLogic.pauseUntil(NotifPrefsLogic.PauseChoice.Forever, now))
        assertEquals(now.toEpochSecond() + 3600, NotifPrefsLogic.pauseUntil(NotifPrefsLogic.PauseChoice.OneHour, now))
        val tomorrow = NotifPrefsLogic.pauseUntil(NotifPrefsLogic.PauseChoice.Tomorrow, now)!!
        assertEquals("Paused until tomorrow, 8:00 AM", NotifPrefsLogic.pauseText(NotifPause(tomorrow.toDouble()), now))
        assertEquals("Paused until you turn them back on", NotifPrefsLogic.pauseText(NotifPause(null), now))
        assertNull(NotifPrefsLogic.pauseText(null, now))
        assertFalse(NotifPrefsLogic.isPaused(NotifPause(1.0)))
    }

    @Test
    fun `hidden channels and error copy`() {
        assertEquals("Mobile push and Slack aren't set up here.", NotifPrefsLogic.hiddenChannelsNote(payload()))
        assertEquals("Embodent couldn't be reached", NotifPrefsLogic.errorText(null))
        assertEquals("that setting isn't valid", NotifPrefsLogic.errorText(422))
        assertEquals("Embodent hit an error — try again", NotifPrefsLogic.errorText(503))
    }

    // ── routines ──

    @Test
    fun `routine copy mirrors the web`() {
        assertEquals("Never run", RoutineCopy.lastResult(null))
        assertEquals("In progress", RoutineCopy.lastResult(InboxRoutineRunDto(outcome = "created", taskId = "t", taskStatus = "in_progress")))
        assertEquals("Task removed", RoutineCopy.lastResult(InboxRoutineRunDto(outcome = "created")))
        assertEquals("Skipped", RoutineCopy.lastResult(InboxRoutineRunDto(outcome = "skipped")))
        assertEquals("Run now by alex", RoutineCopy.trigger(InboxRoutineRunDto(trigger = "manual", actorAlias = "alex")))
        assertEquals("Catch-up (3 missed)", RoutineCopy.trigger(InboxRoutineRunDto(trigger = "catch_up", missedCount = 3)))
        val now = java.time.Instant.parse("2026-10-02T12:00:00Z").toEpochMilli()
        assertEquals("Next run in 3h", RoutineCopy.nextRun(true, "2026-10-02T15:00:00+00:00", now))
        assertEquals("Paused", RoutineCopy.nextRun(false, "2026-10-02T15:00:00+00:00", now))
        assertEquals("No upcoming run", RoutineCopy.nextRun(true, null, now))
    }

    // ── synced prefs & repos ──

    @Test
    fun `prefs sync resolves known values and keeps unmanaged keys`() {
        val bag = Json.parseToJsonElement("""{"theme":"system","skin":"swiss","sidebar":"collapsed"}""").jsonObject
        assertEquals("auto", PrefsSyncLogic.resolveTheme(bag))
        assertEquals("swiss", PrefsSyncLogic.resolveSkin(bag))
        assertNull(PrefsSyncLogic.resolveTheme(JsonObject(mapOf("theme" to JsonPrimitive("neon")))))
        val merged = PrefsSyncLogic.mergedBag(bag, "dark", "classic")
        assertEquals(JsonPrimitive("collapsed"), merged["sidebar"])
        assertEquals(JsonPrimitive("dark"), merged["theme"])
    }

    @Test
    fun `repo filter matches name and description`() {
        val repos = listOf(InboxGithubRepoDto("acme/api", description = "Backend"), InboxGithubRepoDto("acme/web"))
        assertEquals(listOf("acme/api"), RepoConnectLogic.filter(repos, "backend").map { it.fullName })
        assertEquals(2, RepoConnectLogic.filter(repos, " ").size)
    }
}
