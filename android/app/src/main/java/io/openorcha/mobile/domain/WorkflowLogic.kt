package io.openorcha.mobile.domain

import io.openorcha.mobile.data.RepeatGroupViewDto
import io.openorcha.mobile.data.StepRouteDto
import io.openorcha.mobile.data.WorkflowAvailableActionDto
import io.openorcha.mobile.data.WorkflowCapabilityDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowTaskDto

/**
 * Pure Workflows rules for the phone (design #373), ported from the web's
 * `workflowApi.ts` / `WorkflowListView.tsx` / `WorkflowHeader.tsx` / `WorkflowLoopDecision.tsx`
 * so both surfaces word things the same way. Status words come from the server
 * (`display_state.label`, this `workflowLabel`); reasons from `available_actions[].reason`.
 */
object WorkflowLogic {

    /** W01 filter chips. The server receives status=active|paused|completed|cancelled; the finer chips filter loaded pages. */
    enum class Filter(val key: String, val label: String) {
        Open("open", "Open"),
        Preparing("preparing", "Preparing"),
        Active("active", "Active"),
        Paused("paused", "Paused"),
        Ready("ready", "Ready to finish"),
        Completed("completed", "Completed"),
        Cancelled("cancelled", "Cancelled"),
        All("all", "All");

        val serverStatus: String?
            get() = when (this) {
                Preparing, Active, Ready -> "active"
                Paused -> "paused"
                Completed -> "completed"
                Cancelled -> "cancelled"
                Open, All -> null
            }

        fun matches(w: WorkflowDetailDto): Boolean = when {
            w.hidden -> false
            this == Open -> w.status == "active" || w.status == "paused"
            this == Preparing -> w.status == "active" && !w.launchEnabled
            this == Ready -> w.status == "active" && w.completion.canFinish
            this == Active -> w.status == "active" && w.launchEnabled
            this == All -> true
            else -> w.status == key
        }
    }

    fun counts(loaded: List<WorkflowDetailDto>): Map<Filter, Int> =
        Filter.entries.associateWith { f -> loaded.count { f.matches(it) } }

    /** Search + owner filter over loaded pages (web parity: title and goal, case-insensitive). */
    fun visible(loaded: List<WorkflowDetailDto>, filter: Filter, query: String, ownerId: String?): List<WorkflowDetailDto> {
        val q = query.trim().lowercase()
        return loaded.filter { w ->
            filter.matches(w) &&
                (ownerId == null || w.ownerHumanId == ownerId) &&
                (q.isEmpty() || w.title.lowercase().contains(q) || w.goal.lowercase().contains(q))
        }
    }

    fun workflowLabel(w: WorkflowDetailDto): String = when {
        w.status == "active" && !w.launchEnabled -> "Preparing"
        w.status == "active" && w.completion.canFinish -> "Ready to finish"
        else -> when (w.status) {
            "active" -> "Active"
            "paused" -> "Paused"
            "completed" -> "Completed"
            "cancelled" -> "Cancelled"
            else -> w.status.replaceFirstChar { it.uppercase() }
        }
    }

    /** Glyph status for the shared `LStatusGlyph` (the web `workflowStatusIcon`). */
    fun glyphStatus(w: WorkflowDetailDto): String = when (workflowLabel(w)) {
        "Preparing" -> "pending"
        "Ready to finish" -> "needs_verification"
        "Active" -> "in_progress"
        else -> w.status
    }

    /** Group order for the All filter's sticky headers. */
    val GROUP_ORDER = listOf("Preparing", "Active", "Ready to finish", "Paused", "Completed", "Cancelled")

    fun grouped(list: List<WorkflowDetailDto>): List<Pair<String, List<WorkflowDetailDto>>> =
        list.groupBy { workflowLabel(it) }
            .toList()
            .sortedBy { (label, _) -> GROUP_ORDER.indexOf(label).let { if (it < 0) GROUP_ORDER.size else it } }

    fun modeLabel(mode: String): String = if (mode == "parallel") "Parallel" else "Serial"

    /** The running repeat group's "Round N of M", or null. */
    fun runningRound(w: WorkflowDetailDto): String? =
        w.repeatGroups.firstOrNull { it.state == "running" && it.currentRound > 0 }
            ?.let { "Round ${it.currentRound} of ${it.maxRounds}" }

    /** The owner-decision chip for a card (W01): the first waiting task's case in words. */
    fun decisionChip(w: WorkflowDetailDto): String? = when (w.tasks.firstNotNullOfOrNull { it.awaitingLoopDecision }) {
        "limit_reached" -> "Limit reached"
        "stalled" -> "Stalled"
        null -> null
        else -> "Needs your decision"
    }

    fun needsDecision(w: WorkflowDetailDto): Boolean = w.tasks.any { it.awaitingLoopDecision != null }

    // ---- capability and action reasons (web `workflowWriteReason` / `availableActionReason`) ----

    fun writeReason(capability: WorkflowCapabilityDto?, hasHuman: Boolean): String? {
        if (capability == null) return "Checking access to workflow changes…"
        if (!capability.workflowHumanWrite) {
            return when (capability.reason) {
                "integration_required" -> "Workflow changes are not available on this server yet. You can continue reading."
                "local_workflow_writes_unavailable" -> "Workflow changes are unavailable on this older server. Update Orcha and try again."
                "verified_sign_in_required" -> "Sign in as a current human member of this project to change workflows on this hosted server."
                "human_required" -> "Choose a current human member of this project to change workflows."
                "workflow_owner_required" -> "Only this workflow’s owner can make these changes."
                else -> "You do not have permission to change workflows on this connection."
            }
        }
        return if (hasHuman) null else "Choose a current human member of this project to change workflows."
    }

    val ACTION_MESSAGES: Map<String, String> = mapOf(
        "integration_required" to "This action is not available on this server yet.",
        "approval_integration_required" to "Task approval is not available on this server yet.",
        "human_required" to "Choose a current human member of this project for this action.",
        "verified_sign_in_required" to "Sign in as a current human member of this project for this hosted action.",
        "verified_member_required" to "A current non-viewer project membership is required.",
        "workflow_owner_required" to "Only this workflow’s owner can make this change.",
        "human_reviewer_required" to "A current human reviewer is required.",
        "workflow_participation_required" to "Only this workflow’s owner or a participating agent can do this.",
        "completion_not_authorized" to "You do not have permission to accept this task result.",
        "workflow_not_active" to "The workflow must be active before this action is available.",
        "project_not_active" to "The project is not active.",
        "workflow_completed" to "Completed workflows are read-only.",
        "workflow_terminal" to "This workflow has ended. Only permitted recovery actions remain available.",
        "workflow_not_started" to "Start the workflow before adding work as a participant.",
        "prepared_selection_required" to "Prepare at least one task first: open a draft task and choose Prepare, then Start can release it.",
        "already_started" to "This workflow has already started.",
        "workflow_not_paused" to "The workflow is not paused.",
        "reservation_live" to "The current worker or review turn must end first.",
        "task_not_prepared" to "Prepare this task before releasing it.",
        "no_hold" to "This task has no hold you can release.",
        "hold_owner_required" to "Only the person who set this hold or the workflow owner may release it.",
        "hold_exists" to "This task is already held by another person.",
        "task_already_started" to "This task has already started.",
        "task_terminal" to "This task has ended.",
        "task_not_waiting" to "This task is not waiting. Stop its worker or wait for the current attempt.",
        "task_withdrawn" to "This task was withdrawn from scope.",
        "task_has_dependents" to "Resolve this task’s remaining dependents first.",
        "last_required_task" to "The last required task cannot be withdrawn.",
        "task_history_present" to "A task with work or review history cannot be moved.",
        "no_running_worker" to "There is no running worker to stop.",
        "stop_already_requested" to "A stop has already been requested. Use Send stop again if needed.",
        "stop_not_pending" to "There is no pending stop request.",
        "already_released" to "This worker has already been released.",
        "release_not_yet_available" to "Wait until the server confirms that lost-worker release is available.",
        "owner_decision_required" to "This task is waiting for its owner’s decision.",
        "owner_evidence_pending" to "Review or withdraw the pending outside result first.",
        "evidence_not_pending" to "There is no pending outside result to withdraw.",
        "outside_result_not_allowed" to "An outside result cannot be submitted in this task’s current state.",
        "missing_evidence_required" to "Only missing evidence can be replaced here.",
        "worker_live" to "Wait for the worker to finish before replacing evidence.",
        "not_awaiting_review" to "This task is not awaiting acceptance.",
        "evidence_version_stale" to "The saved evidence changed. Refresh and review it again.",
        "evidence_not_saved" to "Wait for evidence to finish saving before accepting.",
        "evidence_missing" to "Add or restore the missing evidence before accepting.",
        "review_loop_unavailable" to "There are no open review findings to resolve.",
        "withdrawal_not_allowed" to "This task cannot be withdrawn in its current state.",
        "task_limit" to "The workflow’s task limit has been reached.",
    )

    const val GENERIC_UNAVAILABLE = "This action is not available in the current state. Refresh to check for changes."

    /** Per-action decisions are authoritative; null = enabled. */
    fun availableActionReason(
        capability: WorkflowCapabilityDto,
        actions: List<WorkflowAvailableActionDto>,
        action: String,
        hasHuman: Boolean,
    ): String? {
        if (!hasHuman) return "Choose a current human member of this project to make this change."
        if (capability.reason == "integration_required" || capability.reason == "local_workflow_writes_unavailable") {
            return writeReason(capability, hasHuman)
        }
        val available = actions.firstOrNull { it.action == action }
        if (available?.enabled == true) return null
        return ACTION_MESSAGES[available?.reason.orEmpty()] ?: GENERIC_UNAVAILABLE
    }

    fun actionReason(w: WorkflowDetailDto, action: String, hasHuman: Boolean): String? {
        if (w.hidden && action != "restore") return "Restore this hidden workflow before making changes."
        return availableActionReason(w.capability, w.availableActions, action, hasHuman)
    }

    fun taskActionReason(w: WorkflowDetailDto, t: WorkflowTaskDto, action: String, hasHuman: Boolean): String? {
        if (w.hidden) return "Restore this hidden workflow before making changes."
        return availableActionReason(w.capability, t.availableActions, action, hasHuman)
    }

    // ---- W03 header: primary action + overflow in the web's fixed order ----

    enum class MenuAction(val key: String, val label: String, val danger: Boolean = false) {
        Start("start", "Review start"),
        Pause("pause", "Pause new starts"),
        Resume("resume", "Resume workflow"),
        AddTasks("add_tasks", "Add new tasks…"),
        Import("import", "Add existing tasks…"),
        Move("move", "Move or remove tasks…"),
        ReviewRound("review_round", "Record review outcome…"),
        Settings("settings", "Workflow settings…"),
        TransferOwner("transfer_owner", "Transfer ownership…"),
        Hide("hide", "Hide workflow…"),
        Cancel("cancel", "Cancel workflow…", danger = true),
        Finish("finish", "Finish checklist"),
    }

    /** null entries are separators. */
    val MENU_ORDER: List<MenuAction?> = listOf(
        MenuAction.Start, MenuAction.Pause, MenuAction.Resume, null,
        MenuAction.AddTasks, MenuAction.Import, MenuAction.Move, MenuAction.ReviewRound, null,
        MenuAction.Settings, MenuAction.TransferOwner, null,
        MenuAction.Hide, MenuAction.Cancel,
    )

    fun menuReason(w: WorkflowDetailDto, action: MenuAction, hasHuman: Boolean): String? = when (action) {
        MenuAction.Settings -> listOf("patch", "transfer_owner").map { actionReason(w, it, hasHuman) }
            .let { reasons -> if (reasons.any { it == null }) null else reasons.first() }
        MenuAction.Finish -> null
        MenuAction.Hide -> {
            val key = if (w.hidden) "restore" else "hide"
            if (w.availableActions.any { it.action == key }) actionReason(w, key, hasHuman)
            else "Hiding workflows is not available on this server."
        }
        else -> actionReason(w, action.key, hasHuman)
    }

    /** The single primary button: the first enabled of start → resume → finish, else finish. */
    fun primaryAction(w: WorkflowDetailDto, hasHuman: Boolean): MenuAction =
        listOf(MenuAction.Start, MenuAction.Resume).firstOrNull { actionReason(w, it.key, hasHuman) == null }
            ?: MenuAction.Finish

    /** Overflow = every menu action except the one shown as the primary button. */
    fun overflow(w: WorkflowDetailDto, hasHuman: Boolean): List<MenuAction?> {
        val primary = primaryAction(w, hasHuman)
        return MENU_ORDER.filter { it != primary }.let { trimSeparators(it) }
    }

    private fun trimSeparators(items: List<MenuAction?>): List<MenuAction?> {
        val out = mutableListOf<MenuAction?>()
        for (item in items) if (item != null || (out.isNotEmpty() && out.last() != null)) out += item
        while (out.isNotEmpty() && out.last() == null) out.removeAt(out.lastIndex)
        return out
    }

    // ---- W06 task actions ----

    enum class TaskAction(val key: String, val label: String, val route: String, val group: Int) {
        Prepare("prepare", "Prepare task", "prepare", PRIMARY),
        Retry("retry", "Retry task", "retry", PRIMARY),
        Release("release", "Release holds", "release", PRIMARY),
        Hold("hold", "Put on hold", "hold", MORE),
        Stop("stop", "Stop this task", "stop", DANGER),
        ReissueStop("reissue_stop", "Send stop again", "reissue-stop", MORE),
        ReleaseLostWorker("release_lost_worker", "Release lost worker", "release-lost-worker", DANGER),
        Withdraw("withdraw", "Withdraw from scope", "withdraw-from-scope", DANGER),
        Dependencies("dependencies", "Edit prerequisites", "dependencies", MORE),
        SubmitOutsideResult("submit_outside_result", "Submit outside result", "external-result", MORE),
        WithdrawEvidence("withdraw_evidence", "Withdraw outside result", "external-result/withdraw", DANGER),
        AddEvidence("add_evidence", "Replace missing evidence", "evidence", MORE);

        companion object {
            fun of(key: String): TaskAction? = entries.firstOrNull { it.key == key }
        }
    }

    const val PRIMARY = 0
    const val DANGER = 1
    const val MORE = 2

    /** "Retry task" reads "Let worker start" after an outside result was withdrawn (web parity). */
    fun taskActionLabel(t: WorkflowTaskDto, a: TaskAction): String =
        if (a == TaskAction.Retry && t.awaitingOwnerDecision == "evidence_withdrawn") "Let worker start" else a.label

    /** Enabled and disabled task actions, each with its reason (W06 "Not available now"). */
    data class TaskActionRow(val action: TaskAction, val reason: String?)

    fun taskActions(w: WorkflowDetailDto, t: WorkflowTaskDto, hasHuman: Boolean): List<TaskActionRow> =
        t.availableActions.mapNotNull { a -> TaskAction.of(a.action) }
            .distinct()
            .map { TaskActionRow(it, taskActionReason(w, t, it.key, hasHuman)) }

    /** Result review (W09) is offered for a task waiting on acceptance; never the legacy verify. */
    fun canReviewResult(t: WorkflowTaskDto): Boolean =
        t.status == "needs_verification" || t.availableActions.any { it.action == "accept" || it.action == "reject" }

    // ---- W04 repeat-group bracket ----

    sealed interface TaskRowGroup {
        data class Single(val task: WorkflowTaskDto) : TaskRowGroup
        data class Loop(val group: RepeatGroupViewDto, val tasks: List<WorkflowTaskDto>) : TaskRowGroup
    }

    /**
     * Wraps CONSECUTIVE member rows of one repeat group in a bracket. A "Not selected" row
     * (route_state) sits outside the bracket even when it belongs to the group.
     */
    fun groupRows(tasks: List<WorkflowTaskDto>, groups: List<RepeatGroupViewDto>): List<TaskRowGroup> {
        val groupOf = mutableMapOf<String, RepeatGroupViewDto>()
        for (g in groups) for (id in g.memberTasks + g.reviewTask) groupOf.putIfAbsent(id, g)
        val out = mutableListOf<TaskRowGroup>()
        for (t in tasks) {
            val g = (t.repeatGroupId?.let { id -> groups.firstOrNull { it.id == id } } ?: groupOf[t.id])
                ?.takeIf { t.routeState != "not_selected" }
            val last = out.lastOrNull()
            if (g == null) {
                out += TaskRowGroup.Single(t)
            } else if (last is TaskRowGroup.Loop && last.group.id == g.id) {
                out[out.lastIndex] = last.copy(tasks = last.tasks + t)
            } else {
                out += TaskRowGroup.Loop(g, listOf(t))
            }
        }
        return out
    }

    /** "Round 2 of 5 · exits when Review reports Passed · then asks Kedar" (design §1 principle 3). */
    fun loopSentence(g: RepeatGroupViewDto, reviewTitle: String?, escalationName: String?): String = buildList {
        add(if (g.currentRound > 0) "Round ${g.currentRound} of ${g.maxRounds}" else "Up to ${g.maxRounds} rounds")
        add("exits when ${reviewTitle ?: "the review"} reports ${g.exitOutcome}")
        add("then asks ${escalationName ?: "the owner"}")
    }.joinToString(" · ")

    /** Round dots: done, current, remaining. */
    enum class Dot { Done, Current, Remaining }

    fun roundDots(g: RepeatGroupViewDto): List<Dot> = (1..g.maxRounds.coerceIn(1, 20)).map {
        when {
            it < g.currentRound -> Dot.Done
            it == g.currentRound -> Dot.Current
            else -> Dot.Remaining
        }
    }

    // ---- W05 route sentences ----

    fun routeSentence(r: StepRouteDto, titleOf: (String?) -> String?): String = when (r.destination) {
        "next" -> "${r.outcome} → next step"
        "step" -> "${r.outcome} → ${titleOf(r.destinationTask) ?: "a step"}"
        "return" -> "${r.outcome} ↺ ${titleOf(r.destinationTask) ?: "an earlier step"} (round)"
        "ask_owner" -> "${r.outcome} → ask the owner"
        "exit_group" -> "${r.outcome} → leave the repeat group"
        "stop" -> "${r.outcome} → end of route"
        else -> "${r.outcome} → ${r.destination}"
    }

    fun dependsLine(t: WorkflowTaskDto, all: List<WorkflowTaskDto>): String {
        val title = { id: String -> all.firstOrNull { it.id == id }?.title ?: "an earlier task" }
        val needs = t.dependsOn.map(title)
        val neededBy = all.filter { t.id in it.dependsOn }.map { it.title }
        return listOfNotNull(
            needs.takeIf { it.isNotEmpty() }?.let { "Depends on ${it.joinToString(", ")}" },
            neededBy.takeIf { it.isNotEmpty() }?.let { "Needed by ${it.joinToString(", ")}" },
        ).joinToString(" · ").ifEmpty { "No prerequisites" }
    }

    // ---- W12 prerequisite picker ----

    const val MAX_PREREQUISITES = 3

    /** Why [candidate] cannot be a prerequisite of [task], or null. */
    fun dependencyReason(task: WorkflowTaskDto, candidate: WorkflowTaskDto, all: List<WorkflowTaskDto>, chosen: List<String>): String? = when {
        candidate.id == task.id -> "A task cannot depend on itself."
        candidate.withdrawnAt != null -> "Withdrawn tasks cannot be prerequisites."
        dependsTransitively(candidate.id, task.id, all, chosen.toSet() - candidate.id, task.id) -> "This would create a cycle."
        candidate.id !in chosen && chosen.size >= MAX_PREREQUISITES -> "At most $MAX_PREREQUISITES prerequisites."
        else -> null
    }

    /** True when [from] already (transitively) depends on [target], using [overrideFor]'s pending choice. */
    private fun dependsTransitively(
        from: String,
        target: String,
        all: List<WorkflowTaskDto>,
        pending: Set<String>,
        overrideFor: String,
    ): Boolean {
        val deps = { id: String -> if (id == overrideFor) pending.toList() else all.firstOrNull { it.id == id }?.dependsOn.orEmpty() }
        val seen = mutableSetOf<String>()
        val stack = ArrayDeque(listOf(from))
        while (stack.isNotEmpty()) {
            val id = stack.removeLast()
            if (id == target) return true
            if (seen.add(id)) deps(id).forEach { stack.addLast(it) }
        }
        return false
    }

    // ---- W20 owner decisions (web `WorkflowLoopDecision`) ----

    val DECISION_OPTIONS: Map<String, List<String>> = mapOf(
        "limit_reached" to listOf("raise_limit", "reassign_continue", "accept_override", "stop"),
        "stalled" to listOf("resume_stalled", "reassign_continue", "accept_override", "stop"),
        "missing_outcome" to listOf("pick_outcome", "stop"),
        "ask_owner" to listOf("pick_outcome", "stop"),
    )

    val DECISION_HEADINGS: Map<String, String> = mapOf(
        "limit_reached" to "The loop reached its round limit",
        "stalled" to "The loop stalled: the same findings came back on unchanged work",
        "missing_outcome" to "This step was accepted without an outcome",
        "ask_owner" to "This step's rule asks you what happens next",
    )

    val DECISION_TITLES: Map<String, String> = mapOf(
        "limit_reached" to "The loop reached its limit. What should happen?",
        "stalled" to "The loop stopped making progress. What should happen?",
        "missing_outcome" to "This step finished without an outcome. What should happen?",
        "ask_owner" to "This step asks you what happens next",
    )

    fun plural(n: Int, one: String, many: String = "${one}s") = "$n ${if (n == 1) one else many}"

    /** The owner bar text (W03), or null when nothing waits on the owner. */
    fun ownerBar(w: WorkflowDetailDto): Pair<WorkflowTaskDto, String>? {
        val task = w.tasks.firstOrNull { it.awaitingLoopDecision != null } ?: return null
        val group = w.repeatGroups.firstOrNull { it.id == task.repeatGroupId }
        val reported = task.reportedOutcome?.outcome
        val text = when (task.awaitingLoopDecision) {
            "limit_reached" -> group?.let {
                "“${it.name}” used all ${it.maxRounds} rounds" +
                    (reported?.let { r -> " and the last review reported “$r”" } ?: "") +
                    ". No round ${it.maxRounds + 1} was started. Nothing is lost: every round’s work and review is kept."
            } ?: (DECISION_HEADINGS.getValue("limit_reached") + ".")
            "stalled" -> group?.let {
                "“${it.name}” is paused: round ${it.currentRound} brought back the same findings on unchanged work, so another round would likely repeat them."
            } ?: (DECISION_HEADINGS.getValue("stalled") + ".")
            "missing_outcome" -> "${task.title} was accepted without an outcome, so Orcha did not guess what comes next."
            else -> "${task.title} reported${reported?.let { " “$it”" } ?: " an outcome"}, and its rule asks you what happens next."
        }
        return task to text
    }

    /** Outcomes a decision may pick: the server refuses any whose own rule asks the owner again. */
    fun pickableOutcomes(t: WorkflowTaskDto): List<String> = t.outcomes.map { it.name }.filter { name ->
        t.routes.firstOrNull { it.outcome.equals(name, ignoreCase = true) }?.destination != "ask_owner"
    }

    /** Client-side check before the decision confirm enables (server re-checks). */
    fun decisionInvalid(kind: String?, group: RepeatGroupViewDto?, extra: Int, assignee: String?, outcome: String?, note: String): String? {
        val used = group?.currentRound ?: 0
        return when {
            kind == null -> "Choose what happens next."
            kind == "raise_limit" && (group == null || extra < 1 || used + extra > 20) ->
                "Allow between 1 and ${maxOf(20 - used, 1)} more rounds (at most 20 in all)."
            kind == "reassign_continue" && assignee.isNullOrBlank() -> "Choose who takes the step."
            kind == "pick_outcome" && outcome.isNullOrBlank() -> "Choose an outcome."
            kind == "resume_stalled" && note.isBlank() -> "Write the guidance the next round should follow."
            else -> null
        }
    }

    // ---- Home card (§2) ----

    data class HomeCounts(val active: Int, val paused: Int, val ready: Int, val needDecision: Int)

    fun homeCounts(loaded: List<WorkflowDetailDto>): HomeCounts = HomeCounts(
        active = loaded.count { Filter.Active.matches(it) },
        paused = loaded.count { Filter.Paused.matches(it) },
        ready = loaded.count { Filter.Ready.matches(it) },
        needDecision = loaded.count { !it.hidden && needsDecision(it) },
    )
}
