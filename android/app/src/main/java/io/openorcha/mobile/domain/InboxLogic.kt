package io.openorcha.mobile.domain

/* Pure logic for the Inbox slice (unit-tested): the human view of a request (agent
   instructions never shown), auto-resolve wording, portal link chips, notification
   preference edits, routine copy, synced prefs and the repo filter. Web sources:
   lib/requestText.ts, lib/format.ts (portal chips), pages/settings/notifications/
   notificationPrefs.ts, pages/routines/RoutinesPage.tsx. */

import io.openorcha.mobile.data.InboxGithubRepoDto
import io.openorcha.mobile.data.NotifPause
import io.openorcha.mobile.data.NotifPrefsPayload
import io.openorcha.mobile.data.NotifRule
import io.openorcha.mobile.data.InboxRoutineRunDto
import io.openorcha.mobile.data.TaskDto
import java.net.URI
import java.net.URLDecoder
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// ── Requests: human text (agent_payload never reaches people) ──────────────────

/** What a person reads for a request: an optional display title plus the question. */
data class HumanRequestText(val title: String?, val body: String)

object RequestHumanText {
    private val LEGACY_HEAD = Regex("^\\[code thread — ([a-z]+)\\] \\S+@\\S+ (.+?):(\\d+)-(\\d+)\\n")
    private const val GUIDE_START = "\n\nanswer as a short lesson in markdown"
    private val REPLY = Regex("\\n\\nreply via POST /api/code/threads/[0-9a-fA-F-]+/messages[^\\n]*(?:\\nview/reply in the portal: \\S+)?")
    private val TRAILER = Regex("\\n\\n(?:answer as a short lesson|reply via POST )[\\s\\S]*$")

    /**
     * Mirrors web `humanizeRequest`: the stored `detail.display_title` when present, and for
     * a legacy combined code-thread payload the agent-only blocks (anchor header, lesson
     * guide, reply instructions) are stripped. `agent_payload` itself is never decoded for display.
     */
    fun humanize(payload: String, detail: JsonElement?): HumanRequestText {
        val obj = detail as? JsonObject
        val stored = (obj?.get("display_title") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        val head = LEGACY_HEAD.find(payload)
        val question = if (head == null || head.range.first != 0) {
            payload
        } else {
            val rest = payload.substring(head.value.length)
            val cuts = listOfNotNull(
                rest.indexOf(GUIDE_START).takeIf { it >= 0 },
                REPLY.find(rest)?.range?.first,
            )
            (if (cuts.isNotEmpty()) rest.substring(0, cuts.min()) else rest.replace(TRAILER, "")).trim()
        }
        return HumanRequestText(stored, question)
    }

    /** The web's auto-resolve line for a request the backend closed, or null. */
    fun autoResolvedText(detail: JsonElement?): String? {
        val v = ((detail as? JsonObject)?.get("auto_resolved") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
        return "Resolved automatically — " + if (v == "thread_resolved") "the code thread was resolved" else "answered in the code thread"
    }
}

// ── Portal link chips ──────────────────────────────────────────────────────────

/** Where a portal path leads in the app. */
sealed class PortalTarget {
    data class Task(val id: String) : PortalTarget()
    data class Request(val id: String) : PortalTarget()
    data class Agent(val alias: String) : PortalTarget()
    /** A portal page the app has no native screen for — opened in the browser. */
    data class Page(val path: String) : PortalTarget()
}

data class PortalLinkMatch(val range: IntRange, val path: String, val label: String, val target: PortalTarget)

object PortalLinks {
    private val SECTIONS = mapOf(
        "code" to "Code", "tasks" to "Tasks", "requests" to "Requests", "agents" to "Agents", "needs" to "Needs you",
        "activity" to "Activity", "routines" to "Routines", "github" to "GitHub", "metrics" to "Metrics",
        "members" to "Members", "settings" to "Settings",
    )
    private const val SECTION_ALT = "code|tasks|requests|agents|needs|activity|routines|github|metrics|members|settings"
    private val BARE = Regex("(^|[\\s(])(/(?:$SECTION_ALT)(?:\\?[^\\s<]*)?)(?=[\\s<).,;:!?]|$)", RegexOption.MULTILINE)
    private val URL = Regex("https?://[^\\s<]+")
    private val TRAILING_PUNCT = Regex("[)\\].,;:!?]+$")

    private fun query(path: String): Map<String, String> {
        val qi = path.indexOf('?')
        if (qi < 0) return emptyMap()
        return path.substring(qi + 1).split('&').mapNotNull { kv ->
            val i = kv.indexOf('=')
            if (i <= 0) return@mapNotNull null
            val v = runCatching { URLDecoder.decode(kv.substring(i + 1), "UTF-8") }.getOrDefault(kv.substring(i + 1))
            kv.substring(0, i) to v
        }.toMap()
    }

    private fun section(path: String): String = path.substringBefore('?').trimStart('/')

    private fun shortId(id: String): String = id.take(8)

    /** Web `portalLinkLabel`: what a portal path opens, in words. */
    fun label(path: String, tasks: List<TaskDto> = emptyList()): String {
        val s = section(path)
        val q = query(path)
        val name = SECTIONS[s] ?: s
        return when {
            s == "code" && q["thread"] != null -> "Open thread in Code"
            s == "code" && q["path"] != null -> "Open " + (q.getValue("path").trimEnd('/').substringAfterLast('/').ifEmpty { q.getValue("path") }) + " in Code"
            s == "code" -> "Open Code"
            s == "tasks" && q["task"] != null -> {
                val ref = q.getValue("task")
                val t = tasks.firstOrNull { it.id == ref || it.id.startsWith(ref) }
                if (t != null && t.title.isNotBlank()) "Open task · " + (if (t.title.length > 48) t.title.take(47) + "…" else t.title)
                else "Open task " + shortId(ref)
            }
            s == "requests" && q["req"] != null -> "Open request " + shortId(q.getValue("req"))
            s == "agents" && q["agent"] != null -> "Open agent " + q.getValue("agent")
            s == "github" && q["pr"] != null -> "Open PR #" + q.getValue("pr")
            s == "github" && q["issue"] != null -> "Open issue #" + q.getValue("issue")
            else -> "Open $name"
        }
    }

    fun target(path: String, tasks: List<TaskDto> = emptyList()): PortalTarget {
        val s = section(path)
        val q = query(path)
        return when {
            s == "tasks" && q["task"] != null -> {
                val ref = q.getValue("task")
                PortalTarget.Task(tasks.firstOrNull { it.id == ref || it.id.startsWith(ref) }?.id ?: ref)
            }
            s == "requests" && q["req"] != null -> PortalTarget.Request(q.getValue("req"))
            s == "agents" && q["agent"] != null -> PortalTarget.Agent(q.getValue("agent"))
            else -> PortalTarget.Page(path)
        }
    }

    private fun origin(url: String): String? = runCatching {
        val u = URI(url.trim())
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host?.lowercase() ?: return null
        val port = if (u.port == -1) (if (scheme == "https") 443 else 80) else u.port
        "$scheme://$host:$port"
    }.getOrNull()

    /**
     * Every portal link in [text]: bare portal paths (`/tasks?task=…`) and full URLs on the
     * paired [baseUrl]'s origin. Trailing punctuation stays outside the chip.
     */
    fun find(text: String, baseUrl: String?, tasks: List<TaskDto> = emptyList()): List<PortalLinkMatch> {
        val out = mutableListOf<PortalLinkMatch>()
        BARE.findAll(text).forEach { m ->
            val g = m.groups[2] ?: return@forEach
            var path = g.value
            var end = g.range.last
            TRAILING_PUNCT.find(path)?.takeIf { path.contains('?') }?.let { t ->
                path = path.substring(0, path.length - t.value.length)
                end -= t.value.length
            }
            out += PortalLinkMatch(g.range.first..end, path, label(path, tasks), target(path, tasks))
        }
        val base = baseUrl?.let(::origin)
        if (base != null) {
            URL.findAll(text).forEach { m ->
                var url = m.value
                TRAILING_PUNCT.find(url)?.let { url = url.substring(0, url.length - it.value.length) }
                if (origin(url) != base) return@forEach
                val path = runCatching {
                    val u = URI(url)
                    (u.rawPath ?: "") + (u.rawQuery?.let { "?$it" } ?: "")
                }.getOrNull() ?: return@forEach
                if (section(path) !in SECTIONS) return@forEach
                val range = m.range.first until m.range.first + url.length
                if (out.none { it.range.first <= range.last && range.first <= it.range.last }) {
                    out += PortalLinkMatch(range, path, label(path, tasks), target(path, tasks))
                }
            }
        }
        return out.sortedBy { it.range.first }
    }
}

// ── Notification preferences ───────────────────────────────────────────────────

enum class NotifEditScope { Project, AllProjects }

object NotifPrefsLogic {
    /** built-in ⊕ defaults ⊕ this project's override, locks forced on (web `effectiveRules`). */
    fun effectiveRules(p: NotifPrefsPayload): Map<String, NotifRule> {
        val out = linkedMapOf<String, NotifRule>()
        for (c in p.catalog.categories) {
            val base = p.defaults.rules[c.key] ?: continue
            val over = p.project.rules[c.key]
            out[c.key] = NotifRule(
                scope = over?.scope ?: base.scope,
                channels = base.channels + (over?.channels ?: emptyMap()),
            )
        }
        for (l in p.catalog.locks) {
            out[l.category]?.let { out[l.category] = it.copy(channels = it.channels + (l.channel to true)) }
        }
        return out
    }

    /** The rules shown for an edit scope: the defaults alone, or the project's effective rules. */
    fun rulesFor(p: NotifPrefsPayload, scope: NotifEditScope): Map<String, NotifRule> =
        if (scope == NotifEditScope.Project) effectiveRules(p) else {
            val d = LinkedHashMap(p.defaults.rules)
            for (l in p.catalog.locks) d[l.category]?.let { d[l.category] = it.copy(channels = it.channels + (l.channel to true)) }
            d
        }

    fun lockReason(p: NotifPrefsPayload, category: String, channel: String): String? =
        p.catalog.locks.firstOrNull { it.category == category && it.channel == channel }?.let { it.reason ?: "Always on" }

    /** True when this project overrides [category]. */
    fun isOverridden(p: NotifPrefsPayload, category: String): Boolean = p.project.rules[category] != null

    /** A rule with one channel flipped, or the scope changed. */
    fun withChannel(rule: NotifRule, channel: String, on: Boolean): NotifRule = rule.copy(channels = rule.channels + (channel to on))

    /** The complete defaults map with one category replaced — the defaults PUT needs every category. */
    fun defaultsWith(p: NotifPrefsPayload, category: String, rule: NotifRule): Map<String, NotifRule> =
        p.defaults.rules + (category to rule)

    /** The whole project override map with [category] set to the full [rule]. */
    fun projectOverrideWith(p: NotifPrefsPayload, category: String, rule: NotifRule): Map<String, NotifRule> {
        val out = linkedMapOf<String, NotifRule>()
        for ((k, v) in p.project.rules) {
            val base = p.defaults.rules[k] ?: NotifRule()
            out[k] = NotifRule(v.scope ?: base.scope, base.channels + (v.channels ?: emptyMap()))
        }
        out[category] = rule
        return out
    }

    /** The project override map without [category] (it follows the defaults again). */
    fun projectOverrideWithout(p: NotifPrefsPayload, category: String): Map<String, NotifRule> =
        projectOverrideWith(p, category, NotifRule()).filterKeys { it != category }

    /** Which preset the rules match exactly, or null. */
    fun matchingPreset(p: NotifPrefsPayload, rules: Map<String, NotifRule>): String? =
        p.catalog.presets.firstOrNull { preset ->
            p.catalog.categories.all { c ->
                val a = rules[c.key]
                val b = preset.rules[c.key]
                a != null && b != null && a.scope == b.scope &&
                    p.catalog.channels.all { ch -> (a.channels[ch.key] == true) == (b.channels[ch.key] == true) }
            }
        }?.key

    fun isPaused(pause: NotifPause?, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (pause == null) return false
        val until = pause.until ?: return true
        return nowMs / 1000.0 < until
    }

    enum class PauseChoice(val label: String) { OneHour("For 1 hour"), Tomorrow("Until tomorrow"), Forever("Until I turn it back on") }

    /** The `pause.until` (epoch seconds, or null = until turned back on). "Until tomorrow" = 8:00 tomorrow, local. */
    fun pauseUntil(choice: PauseChoice, now: ZonedDateTime = ZonedDateTime.now()): Long? = when (choice) {
        PauseChoice.Forever -> null
        PauseChoice.OneHour -> now.toEpochSecond() + 3600
        PauseChoice.Tomorrow -> now.toLocalDate().plusDays(1).atTime(8, 0).atZone(now.zone).toEpochSecond()
    }

    /** "Paused until 3:40 PM" / "Paused until tomorrow, 8:00 AM" / "Paused until you turn them back on". */
    fun pauseText(pause: NotifPause?, now: ZonedDateTime = ZonedDateTime.now()): String? {
        if (!isPaused(pause, now.toInstant().toEpochMilli())) return null
        val until = pause?.until ?: return "Paused until you turn them back on"
        val d = Instant.ofEpochSecond(until.toLong()).atZone(now.zone)
        val time = d.format(DateTimeFormatter.ofPattern("h:mm a", Locale.US))
        return when (d.toLocalDate()) {
            now.toLocalDate() -> "Paused until $time"
            now.toLocalDate().plusDays(1) -> "Paused until tomorrow, $time"
            else -> "Paused until " + d.format(DateTimeFormatter.ofPattern("MMM d", Locale.US)) + ", " + time
        }
    }

    /** Channels this server can't deliver on: hidden from the matrix, named in a footnote. */
    fun hiddenChannelsNote(p: NotifPrefsPayload): String? {
        val hidden = p.catalog.channels.filter { p.channels[it.key]?.available == false }.map { it.label }
        if (hidden.isEmpty()) return null
        val names = if (hidden.size == 1) hidden[0] else hidden.dropLast(1).joinToString(", ") + " and " + hidden.last()
        return "$names ${if (hidden.size == 1) "isn't" else "aren't"} set up here."
    }

    /** A failed save, in plain words (web `prefsErrText`). */
    fun errorText(status: Int?): String = when {
        status == null || status == 0 -> "Embodent couldn't be reached"
        status == 401 || status == 403 -> "you can only change your own notification settings"
        status == 422 -> "that setting isn't valid"
        status >= 500 -> "Embodent hit an error — try again"
        else -> "the server refused the change"
    }

    val HHMM = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")
}

// ── Routines ───────────────────────────────────────────────────────────────────

object RoutineCopy {
    fun statusWord(s: String): String = when (s) {
        "ready" -> "Ready"; "pending" -> "Waiting on deps"; "in_progress" -> "In progress"; "blocked" -> "Blocked"
        "not_ready" -> "Held"; "needs_verification" -> "Needs verification"; "completed" -> "Done"
        "cancelled" -> "Cancelled"; "failed" -> "Failed"
        else -> s.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    /** Web `LastResult`: the created task's current status, or why the run didn't create one. */
    fun lastResult(run: InboxRoutineRunDto?): String = when {
        run == null -> "Never run"
        run.outcome == "created" && run.taskId != null -> statusWord(run.taskStatus ?: "unknown")
        run.outcome == "created" -> "Task removed"
        run.outcome == "skipped" -> "Skipped"
        run.outcome == "failed" -> "Failed"
        else -> "Creating…"
    }

    fun trigger(run: InboxRoutineRunDto): String = when (run.trigger) {
        "manual" -> run.actorAlias?.let { "Run now by $it" } ?: "Run now"
        "catch_up" -> if ((run.missedCount ?: 0) > 1) "Catch-up (${run.missedCount} missed)" else "Catch-up (late)"
        else -> "Scheduled"
    }

    /** "in 3h", "in 2d", "in 5m", "now" — the next-run hint. */
    fun relFuture(iso: String?, nowMs: Long = System.currentTimeMillis()): String? {
        val then = parse(iso) ?: return null
        val mins = (then.toEpochMilli() - nowMs) / 60_000
        return when {
            mins <= 0 -> "due now"
            mins < 60 -> "in ${mins}m"
            mins < 48 * 60 -> "in ${mins / 60}h"
            else -> "in ${mins / (60 * 24)}d"
        }
    }

    fun nextRun(enabled: Boolean, nextRunAt: String?, nowMs: Long = System.currentTimeMillis()): String =
        if (!enabled) "Paused" else relFuture(nextRunAt, nowMs)?.let { "Next run $it" } ?: "No upcoming run"

    /** "Mon 9:00 AM" in the routine's zone. */
    fun formatInZone(iso: String?, tz: String): String? {
        val then = parse(iso) ?: return null
        val zone = runCatching { ZoneId.of(tz) }.getOrDefault(ZoneId.of("UTC"))
        return then.atZone(zone).format(DateTimeFormatter.ofPattern("EEE MMM d, h:mm a", Locale.US))
    }

    internal fun parse(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return runCatching { Instant.parse(iso) }.getOrNull()
            ?: runCatching { java.time.OffsetDateTime.parse(iso).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(iso + "Z") }.getOrNull()
    }
}

// ── Synced prefs (iOS PrefsSync parity) ────────────────────────────────────────

object PrefsSyncLogic {
    /** Server theme value → "auto" | "light" | "dark", or null when absent/unknown. */
    fun resolveTheme(bag: JsonObject): String? =
        (bag["theme"] as? JsonPrimitive)?.contentOrNull?.lowercase()?.let { if (it == "system") "auto" else it }
            ?.takeIf { it in setOf("auto", "light", "dark") }

    fun resolveSkin(bag: JsonObject): String? =
        (bag["skin"] as? JsonPrimitive)?.contentOrNull?.lowercase()?.takeIf { it in setOf("classic", "swiss", "minimal") }

    /** Whole-bag replace safety: keys the app doesn't manage ride along intact. */
    fun mergedBag(current: JsonObject?, theme: String, skin: String): JsonObject =
        JsonObject((current ?: JsonObject(emptyMap())) + mapOf("theme" to JsonPrimitive(theme), "skin" to JsonPrimitive(skin)))
}

// ── Connect repo ───────────────────────────────────────────────────────────────

object RepoConnectLogic {
    fun filter(repos: List<InboxGithubRepoDto>, query: String): List<InboxGithubRepoDto> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return repos
        return repos.filter { it.fullName.lowercase().contains(q) || it.description?.lowercase()?.contains(q) == true }
    }
}
