package io.openorcha.mobile.domain

/* Project slice pure logic (unit-tested): routine schedule presets <-> 5-field cron
   (mirrors web pages/routines/schedule.ts), metrics formatting (web
   performanceModel.ts wording) and who may change project settings. */

import io.openorcha.mobile.data.PerfCostDto
import io.openorcha.mobile.data.PerfMedianDto
import io.openorcha.mobile.data.PerfRateDto
import io.openorcha.mobile.data.ProjectMembersResponse
import java.util.Locale

enum class SchedulePreset(val label: String) {
    Hourly("Hourly"), Daily("Daily"), Weekdays("Weekdays"), Weekly("Weekly"), Monthly("Monthly"), Custom("Custom"),
}

data class ScheduleForm(
    val preset: SchedulePreset = SchedulePreset.Weekdays,
    val minute: Int = 0,
    val time: String = "09:00",
    /** 0 = Sunday … 6 = Saturday */
    val weekday: Int = 1,
    /** 1–28 */
    val monthDay: Int = 1,
    val cron: String = "0 9 * * 1-5",
)

object RoutineSchedule {
    val DAY_NAMES = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    /** Common zones for the picker (device zone is added first by the screen). */
    val ZONES = listOf(
        "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
        "Europe/London", "Europe/Berlin", "Europe/Paris", "Africa/Nairobi", "Africa/Lagos", "Asia/Dubai",
        "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
    )

    private fun hm(time: String): Pair<Int, Int> {
        val m = Regex("""^(\d{1,2}):(\d{2})$""").find(time.trim()) ?: return 9 to 0
        return m.groupValues[1].toInt().coerceIn(0, 23) to m.groupValues[2].toInt().coerceIn(0, 59)
    }

    fun normalize(cron: String): String = cron.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

    fun toCron(f: ScheduleForm): String {
        val (h, m) = hm(f.time)
        return when (f.preset) {
            SchedulePreset.Hourly -> "${f.minute.coerceIn(0, 59)} * * * *"
            SchedulePreset.Daily -> "$m $h * * *"
            SchedulePreset.Weekdays -> "$m $h * * 1-5"
            SchedulePreset.Weekly -> "$m $h * * ${((f.weekday % 7) + 7) % 7}"
            SchedulePreset.Monthly -> "$m $h ${f.monthDay.coerceIn(1, 28)} * *"
            SchedulePreset.Custom -> normalize(f.cron)
        }
    }

    private val NUM = Regex("""^\d{1,2}$""")

    /** Read a saved cron back into the preset controls (Custom when it isn't a preset shape). */
    fun fromCron(cron: String): ScheduleForm {
        val expr = normalize(cron)
        val base = ScheduleForm(preset = SchedulePreset.Custom, cron = expr)
        val f = expr.split(" ")
        if (f.size != 5) return base
        val (mi, hr, dom, mon, dow) = f
        if (!NUM.matches(mi) || mon != "*") return base
        val minute = mi.toInt()
        if (hr == "*" && dom == "*" && dow == "*") return base.copy(preset = SchedulePreset.Hourly, minute = minute)
        if (!NUM.matches(hr)) return base
        val time = String.format(Locale.US, "%02d:%02d", hr.toInt(), minute)
        if (dom == "*" && dow == "*") return base.copy(preset = SchedulePreset.Daily, time = time)
        if (dom == "*" && (dow == "1-5" || dow.uppercase() == "MON-FRI")) return base.copy(preset = SchedulePreset.Weekdays, time = time)
        if (dom == "*" && Regex("^[0-7]$").matches(dow)) return base.copy(preset = SchedulePreset.Weekly, time = time, weekday = dow.toInt() % 7)
        if (dow == "*" && NUM.matches(dom) && dom.toInt() in 1..28) return base.copy(preset = SchedulePreset.Monthly, time = time, monthDay = dom.toInt())
        return base
    }

    /** True when a custom cron has the 5 fields the server expects (it still validates). */
    fun looksLikeCron(cron: String): Boolean = normalize(cron).split(" ").size == 5
}

object MetricsFormat {
    const val NOT_ENOUGH = "Not enough data"
    const val NOT_METERED = "Not metered"

    val RANGES = listOf("7d" to "7 days", "30d" to "30 days", "90d" to "90 days", "all" to "All time")

    fun rate(r: PerfRateDto): String =
        if (!r.enough || r.value == null) NOT_ENOUGH else "${Math.round(r.value * 100)}%"

    fun duration(m: PerfMedianDto): String {
        val v = m.value
        if (!m.enough || v == null) return NOT_ENOUGH
        val s = v.toLong()
        return when {
            s < 60 -> "${s}s"
            s < 3_600 -> "${s / 60}m"
            s < 86_400 -> "${s / 3_600}h ${(s % 3_600) / 60}m".replace(" 0m", "")
            else -> "${s / 86_400}d ${(s % 86_400) / 3_600}h".replace(" 0h", "")
        }
    }

    fun cost(c: PerfCostDto): String = when {
        c.meteredTasks == 0 -> NOT_METERED
        !c.enough || c.value == null -> NOT_ENOUGH
        else -> usd(c.value)
    }

    fun usd(v: Double): String = if (v >= 100) "$" + Math.round(v) else String.format(Locale.US, "$%.2f", v)

    fun tokens(n: Long): String = when {
        n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1_000_000.0).replace(".0M", "M")
        n >= 1_000 -> String.format(Locale.US, "%.1fk", n / 1_000.0).replace(".0k", "k")
        else -> n.toString()
    }

    fun bytes(n: Long): String = when {
        n >= 1L shl 30 -> String.format(Locale.US, "%.1f GB", n / (1L shl 30).toDouble())
        n >= 1L shl 20 -> String.format(Locale.US, "%.1f MB", n / (1L shl 20).toDouble())
        n >= 1L shl 10 -> String.format(Locale.US, "%.0f KB", n / (1L shl 10).toDouble())
        else -> "$n B"
    }
}

object ProjectAuthority {
    /**
     * Owner or holder of [grant] may change project settings. Unknown roster (self-host with
     * trust off answers no members) stays open, like the server; the server still refuses.
     */
    fun can(members: ProjectMembersResponse?, actorId: String?, grant: String = "manage_autonomy"): Boolean {
        if (actorId == null) return false
        if (members == null || members.members.isEmpty()) return true
        val me = members.members.firstOrNull { it.agentId == actorId } ?: return false
        return me.memberRole == "owner" || grant in me.grants
    }

    fun isOwner(members: ProjectMembersResponse?, actorId: String?): Boolean {
        if (actorId == null) return false
        if (members == null || members.members.isEmpty()) return true
        return members.members.firstOrNull { it.agentId == actorId }?.memberRole == "owner"
    }
}
