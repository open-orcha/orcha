package io.openorcha.mobile.domain

import io.openorcha.mobile.data.CloseImplicationsResponse

/**
 * Turns the close-implications preview (`task_impact_routes.py`'s counts) into the
 * lines the destructive close confirm lists — pure, so the copy is unit-tested. Empty
 * when there is nothing worth warning about (the confirm then shows its generic copy).
 */
object CloseImplicationsUx {
    fun lines(response: CloseImplicationsResponse?): List<String> {
        if (response == null) return emptyList()
        val s = response.summary
        return buildList {
            if (s != null) {
                if (s.completesContainer) add("This is the root task — closing it marks the whole project complete.")
                if (s.downstreamTotal > 0) {
                    add(
                        "${count(s.downstreamTotal, "downstream task")} depend on it: " +
                            "${s.wouldUnblock} would unblock, ${s.stillBlocked} stay blocked.",
                    )
                }
                if (s.inFlightAgents > 0) {
                    add("${count(s.inFlightAgents, "agent")} ${if (s.inFlightAgents == 1) "is" else "are"} working on it right now.")
                }
                if (s.openRequests > 0) add("${count(s.openRequests, "open request")} from its assignees would be orphaned.")
            }
            response.implications.filter { it.isNotBlank() }.forEach { add(it) }
        }
    }

    private fun count(n: Int, noun: String) = "$n $noun${if (n == 1) "" else "s"}"
}
