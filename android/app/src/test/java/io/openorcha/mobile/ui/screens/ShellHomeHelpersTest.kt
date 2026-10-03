package io.openorcha.mobile.ui.screens

import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.ui.ContainerHealth
import kotlin.test.Test
import kotlin.test.assertEquals

/** Pure helpers behind the Linear projects list, workspace header and search recents. */
class ShellHomeHelpersTest {

    private fun t(id: String, status: String, priority: Int? = null) = TaskDto(id = id, title = id, status = status, priority = priority)

    @Test fun tallyCountsEachBucket() {
        val tasks = listOf(t("a", "in_progress"), t("b", "in_progress"), t("c", "needs_verification"), t("d", "completed"))
        assertEquals("2 in progress · 1 to verify · 0 blocked · 1 done", homeTally(tasks))
    }

    @Test fun tallyDoneMatchesTheDonePill() {
        val tasks = listOf(t("a", "completed"), t("b", "cancelled"), t("c", "failed"), t("d", "in_progress"))
        val donePill = tasks.count { TaskScope.of(it.status) == TaskScope.Done }
        assertEquals("1 in progress · 0 to verify · 0 blocked · $donePill done", homeTally(tasks))
        assertEquals(3, donePill)
    }

    @Test fun taskCountPluralises() {
        assertEquals("1 task", taskCountLabel(1))
        assertEquals("0 tasks", taskCountLabel(0))
        assertEquals("4 tasks", taskCountLabel(4))
    }

    @Test fun activeWorkOrdersByGroupThenPriority() {
        val tasks = listOf(t("r", "ready", 1), t("p2", "in_progress", 50), t("p1", "in_progress", 5), t("done", "completed"))
        val ids = homeActiveWork(tasks).map { it.id }
        assertEquals(listOf("p1", "p2"), ids.take(2))
        assertEquals(false, "done" in ids)
    }

    @Test fun recentsDedupeCaseInsensitivelyAndCap() {
        var r = listOf<String>()
        for (q in listOf("a", "b", "c", "d", "e", "f", "g")) r = pushRecentSearch(r, q)
        assertEquals(listOf("g", "f", "e", "d", "c", "b"), r)
        assertEquals(listOf("B", "g", "f", "e", "d", "c"), pushRecentSearch(r, " B "))
        assertEquals(r, pushRecentSearch(r, "   "))
    }

    @Test fun projectMetaByReachability() {
        assertEquals("Checking…", projectMeta(null))
        assertEquals("Unreachable — is this project up?", projectMeta(ContainerHealth("unreachable")))
        assertEquals("3 agents · 4 open tasks · o/r", projectMeta(ContainerHealth("polling", agents = 3, tasks = 4, githubRepo = "o/r")))
        assertEquals("Running", projectStateLabel(ContainerHealth("live")))
    }
}
