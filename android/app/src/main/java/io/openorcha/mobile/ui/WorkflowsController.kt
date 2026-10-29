package io.openorcha.mobile.ui

import android.content.Context
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.WorkflowActivityDto
import io.openorcha.mobile.data.WorkflowApiException
import io.openorcha.mobile.data.WorkflowCapabilityDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrite
import io.openorcha.mobile.data.WorkflowWriteOutcome
import io.openorcha.mobile.data.WorkflowsRepository
import io.openorcha.mobile.domain.WorkflowLogic
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Workflows tab segments (design §2). */
enum class WorkflowsSegment { Workflows, Tasks }

/** Workflow detail segments (W03). Route replaces the web's Dependencies tab. */
enum class WorkflowDetailSegment(val label: String) { Tasks("Tasks"), Route("Route"), Review("Review"), Activity("Activity") }

/** W02 support phases: what the Workflows segment can show before (or instead of) a list. */
enum class WorkflowSupport { Checking, Supported, Unsupported, Forbidden, Unreachable }

/** The detail-level operation notice (W03): one unresolved write blocks every other action. */
sealed interface WorkflowOperation {
    val label: String

    data class Sending(override val label: String) : WorkflowOperation
    data class Uncertain(override val label: String, val message: String, val write: WorkflowWrite) : WorkflowOperation
    data class Refused(override val label: String, val message: String) : WorkflowOperation
}

/** W16/W17: whether a task is a workflow member. Task reads carry no workflow_id, so this is resolved from the server. */
sealed interface TaskMembership {
    data object Checking : TaskMembership
    data class Failed(val message: String) : TaskMembership
    data object None : TaskMembership
    data class Member(val workflow: WorkflowDetailDto) : TaskMembership
}

data class WorkflowsState(
    val containerId: String? = null,
    /** W16 "Open task controls": the task sheet to open once the workflow detail shows. */
    val pendingTaskSheet: String? = null,
    /** W17 member verification: the W09 result review to open once the workflow detail shows. */
    val pendingResultReview: String? = null,
    /** W16 "Add to {workflow}": the task to preselect in the import sheet once the detail shows. */
    val pendingImport: String? = null,
    /** Server-resolved membership per task id (see [TaskMembership]). */
    val memberships: Map<String, TaskMembership> = emptyMap(),
    val segment: WorkflowsSegment = WorkflowsSegment.Workflows,
    val support: WorkflowSupport = WorkflowSupport.Checking,
    val capability: WorkflowCapabilityDto? = null,
    val supportMessage: String? = null,
    // W01 list
    val loaded: List<WorkflowDetailDto> = emptyList(),
    val nextCursor: String? = null,
    val listLoading: Boolean = false,
    val loadingMore: Boolean = false,
    /** A refresh failed after data was shown: stale banner, writes disabled. */
    val listStale: Boolean = false,
    val filter: WorkflowLogic.Filter = WorkflowLogic.Filter.Open,
    val query: String = "",
    val ownerId: String? = null,
    // hidden list (web §4.14)
    val hiddenOpen: Boolean = false,
    val hidden: List<WorkflowDetailDto> = emptyList(),
    val hiddenLoading: Boolean = false,
    // W03 detail
    val openWorkflowId: String? = null,
    val detail: WorkflowDetailDto? = null,
    val detailLoading: Boolean = false,
    val detailStale: Boolean = false,
    val detailError: String? = null,
    val detailSegment: WorkflowDetailSegment = WorkflowDetailSegment.Tasks,
    /** W19 replaces the segment content while open. */
    val inputOpen: Boolean = false,
    // W15 activity
    val activity: List<WorkflowActivityDto> = emptyList(),
    val activityNextAt: String? = null,
    val activityNextId: String? = null,
    val activityLoading: Boolean = false,
    val activityError: String? = null,
    val activityLoaded: Boolean = false,
    val operation: WorkflowOperation? = null,
    /** One-shot confirmation ("Workflow hidden", …); the screen shows then clears it. */
    val notice: String? = null,
    /** "Restore" on the hidden snackbar targets this workflow. */
    val noticeRestoreId: String? = null,
)

/**
 * The Workflows tab's state holder, owned by the view model so the list, the open detail
 * and an unresolved operation survive tab switches and the task-page round trip. One
 * [WorkflowsRepository] per bound container (design §8).
 */
class WorkflowsController(
    private val scope: CoroutineScope,
    private val api: OrchaApiClient,
    context: Context? = null,
) {
    private val prefs = context?.getSharedPreferences("orcha_workflows", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(WorkflowsState())
    val state: StateFlow<WorkflowsState> = _state
    var repository: WorkflowsRepository? = null
        private set
    private var container: StoredContainer? = null
    private var listJob: Job? = null
    private var detailJob: Job? = null

    /** Binds to the open container (idempotent). Capability is read once per container session. */
    fun bind(selected: StoredContainer?) {
        if (selected == null) return
        val same = container?.id == selected.id && container?.humanAgentId == selected.humanAgentId
        container = selected
        if (same && repository != null) return
        repository = WorkflowsRepository(api, selected.id, { container?.baseUrl ?: selected.baseUrl }, selected.humanAgentId)
        val remembered = prefs?.getString("segment:${selected.id}", null)
            ?.let { runCatching { WorkflowsSegment.valueOf(it) }.getOrNull() }
        _state.value = WorkflowsState(containerId = selected.id, segment = remembered ?: WorkflowsSegment.Workflows)
        checkSupport()
    }

    private var draft: WorkflowCreateDraft? = null

    /** The W10 draft for this container and person; kept while the app stays open. */
    fun createDraft(): WorkflowCreateDraft {
        val scope = "${container?.id}:${actorId}"
        return draft?.takeIf { it.scope == scope } ?: WorkflowCreateDraft(scope).also { draft = it }
    }

    fun discardDraft() { draft = null }

    val hasHuman: Boolean get() = repository?.actorId != null
    val actorId: String? get() = repository?.actorId

    fun selectSegment(segment: WorkflowsSegment) {
        _state.update { it.copy(segment = segment) }
        container?.id?.let { prefs?.edit()?.putString("segment:$it", segment.name)?.apply() }
    }

    /** W02: capability first; 404 = an older server without workflows. Recovers stale state too. */
    fun checkSupport() {
        val repo = repository ?: return
        listJob?.cancel()
        _state.update { it.copy(support = WorkflowSupport.Checking, supportMessage = null) }
        listJob = scope.launch {
            try {
                val cap = repo.capability()
                _state.update { it.copy(capability = cap, support = WorkflowSupport.Supported) }
                loadList(reset = true)
            } catch (e: WorkflowApiException) {
                val support = when (e.status) {
                    404 -> WorkflowSupport.Unsupported
                    401, 403 -> WorkflowSupport.Forbidden
                    else -> WorkflowSupport.Unreachable
                }
                _state.update {
                    it.copy(
                        support = support,
                        supportMessage = e.message,
                        // A server without workflows opens on Tasks (design §2 segment memory).
                        segment = if (support == WorkflowSupport.Unsupported) WorkflowsSegment.Tasks else it.segment,
                    )
                }
            }
        }
    }

    fun setFilter(filter: WorkflowLogic.Filter) {
        val serverChanged = filter.serverStatus != _state.value.filter.serverStatus
        _state.update { it.copy(filter = filter) }
        if (serverChanged) refreshList()
    }

    fun setQuery(q: String) = _state.update { it.copy(query = q) }
    fun setOwner(ownerId: String?) = _state.update { it.copy(ownerId = ownerId) }

    /** Pull-to-refresh resets the cursor; a failure after data keeps it and marks it stale. */
    fun refreshList() {
        if (_state.value.support != WorkflowSupport.Supported) return checkSupport()
        listJob?.cancel()
        listJob = scope.launch { loadList(reset = true) }
    }

    fun loadMore() {
        val cursor = _state.value.nextCursor ?: return
        if (_state.value.loadingMore) return
        scope.launch { loadList(reset = false, cursor = cursor) }
    }

    private suspend fun loadList(reset: Boolean, cursor: String? = null) {
        val repo = repository ?: return
        _state.update { if (reset) it.copy(listLoading = true) else it.copy(loadingMore = true) }
        try {
            val page = repo.list(_state.value.filter.serverStatus, cursor)
            _state.update {
                it.copy(
                    loaded = if (reset) page.workflows else (it.loaded + page.workflows).distinctBy { w -> w.id },
                    nextCursor = page.nextCursor,
                    capability = page.capability,
                    listLoading = false,
                    loadingMore = false,
                    listStale = false,
                )
            }
        } catch (e: WorkflowApiException) {
            _state.update {
                if (it.loaded.isEmpty() && reset) {
                    it.copy(listLoading = false, loadingMore = false, support = supportFor(e), supportMessage = e.message)
                } else {
                    it.copy(listLoading = false, loadingMore = false, listStale = true)
                }
            }
        }
    }

    private fun supportFor(e: WorkflowApiException) = when (e.status) {
        404 -> WorkflowSupport.Unsupported
        401, 403 -> WorkflowSupport.Forbidden
        else -> WorkflowSupport.Unreachable
    }

    fun openHidden(open: Boolean) {
        _state.update { it.copy(hiddenOpen = open) }
        if (!open) return
        val repo = repository ?: return
        scope.launch {
            _state.update { it.copy(hiddenLoading = true) }
            val hidden = runCatching { repo.list(null, null, visibility = "hidden").workflows }.getOrNull()
            _state.update { it.copy(hiddenLoading = false, hidden = hidden ?: it.hidden) }
        }
    }

    // ---- detail ----

    fun openWorkflow(id: String, segment: WorkflowDetailSegment = WorkflowDetailSegment.Tasks) {
        val cached = _state.value.loaded.firstOrNull { it.id == id } ?: _state.value.detail?.takeIf { it.id == id }
        _state.update {
            it.copy(
                openWorkflowId = id, detail = cached, detailSegment = segment, detailError = null, detailStale = false,
                inputOpen = false, activity = emptyList(), activityLoaded = false, activityError = null,
                activityNextAt = null, activityNextId = null,
                operation = it.operation.takeIf { op -> op is WorkflowOperation.Uncertain && it.openWorkflowId == id },
            )
        }
        refreshDetail()
    }

    /** W16: open [workflowId] on the Workflows segment with [taskId]'s task sheet (W06). */
    fun openTaskControls(workflowId: String, taskId: String) {
        selectSegment(WorkflowsSegment.Workflows)
        openWorkflow(workflowId)
        _state.update { it.copy(pendingTaskSheet = taskId) }
    }

    fun consumePendingTaskSheet() = _state.update { it.copy(pendingTaskSheet = null, pendingResultReview = null, pendingImport = null) }

    /** W16 non-member "Add to {workflow}": opens that workflow's import (W11b) with this task picked. */
    fun openImportWith(workflowId: String, taskId: String) {
        selectSegment(WorkflowsSegment.Workflows)
        openWorkflow(workflowId)
        _state.update { it.copy(pendingImport = taskId) }
    }

    /** W17: a member's verification goes through the W09 result review, not the legacy verify sheet. */
    fun openResultReview(workflowId: String, taskId: String) {
        selectSegment(WorkflowsSegment.Workflows)
        openWorkflow(workflowId)
        _state.update { it.copy(pendingResultReview = taskId) }
    }

    /** W16: the workflow [taskId] belongs to, only once membership is known to be Member. */
    fun membershipOf(taskId: String?): WorkflowDetailDto? =
        (taskId?.let { membership(it) } as? TaskMembership.Member)?.workflow

    /** Membership as known now: a loaded workflow that lists the task wins; otherwise the server lookup's result. */
    fun membership(taskId: String): TaskMembership {
        // A server without Workflows has no members: the legacy task page stays as it was.
        if (_state.value.support == WorkflowSupport.Unsupported) return TaskMembership.None
        _state.value.loaded.firstOrNull { w -> w.tasks.any { it.id == taskId } }?.let { return TaskMembership.Member(it) }
        return _state.value.memberships[taskId] ?: TaskMembership.Checking
    }

    /** W16 section refresh: re-reads the member's workflow and updates both the list entry and the membership. */
    fun refreshMembershipWorkflow(workflowId: String, taskId: String) {
        val repo = repository ?: return
        scope.launch {
            val d = try { repo.detail(workflowId) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) {
                _state.update { it.copy(memberships = it.memberships + (taskId to TaskMembership.Failed(e.message ?: "Couldn't refresh the workflow."))) }
                return@launch
            }
            val m = if (d.tasks.any { it.id == taskId }) TaskMembership.Member(d) else TaskMembership.None
            _state.update { st -> st.copy(loaded = st.loaded.map { if (it.id == d.id) d else it }, memberships = st.memberships + (taskId to m)) }
        }
    }

    /**
     * Resolves [taskId]'s workflow from the server (workflow-task-search echoes the selected
     * task's workflow_id, then the workflow detail is read). Until it answers the task counts
     * as unknown, never as a non-member (design W16).
     */
    fun resolveMembership(taskId: String, force: Boolean = false) {
        if (_state.value.support == WorkflowSupport.Unsupported) return
        if (_state.value.loaded.any { w -> w.tasks.any { it.id == taskId } }) return
        val known = _state.value.memberships[taskId]
        if (!force && known != null && known !is TaskMembership.Failed) return
        val repo = repository
        if (repo == null) {
            _state.update { it.copy(memberships = it.memberships + (taskId to TaskMembership.Failed("Workflows aren't connected yet. Try again."))) }
            return
        }
        _state.update { it.copy(memberships = it.memberships + (taskId to TaskMembership.Checking)) }
        scope.launch {
            val result = try {
                val wid = repo.searchTasks("", listOf(taskId)).selected.firstOrNull { it.id == taskId }?.workflowId
                if (wid == null) TaskMembership.None else TaskMembership.Member(repo.detail(wid))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                TaskMembership.Failed(e.message ?: "Couldn't check whether this task is in a workflow.")
            }
            _state.update { it.copy(memberships = it.memberships + (taskId to result)) }
        }
    }

    fun closeWorkflow() {
        if (_state.value.operation is WorkflowOperation.Sending) return
        detailJob?.cancel()
        _state.update { it.copy(openWorkflowId = null, detail = null, inputOpen = false, operation = null) }
    }

    fun refreshDetail() {
        val id = _state.value.openWorkflowId ?: return
        val repo = repository ?: return
        detailJob?.cancel()
        detailJob = scope.launch {
            _state.update { it.copy(detailLoading = true) }
            try {
                val d = repo.detail(id)
                applyDetail(d)
                _state.update { it.copy(detailLoading = false, detailError = null, detailStale = false) }
                if (_state.value.detailSegment == WorkflowDetailSegment.Activity) loadActivity(reset = true)
            } catch (e: WorkflowApiException) {
                _state.update {
                    if (it.detail == null) it.copy(detailLoading = false, detailError = e.message)
                    else it.copy(detailLoading = false, detailStale = true)
                }
            }
        }
    }

    /** A confirmed write or a fresh read replaces the loaded detail (and its list card). */
    fun applyDetail(d: WorkflowDetailDto) {
        _state.update { s ->
            s.copy(
                detail = if (s.openWorkflowId == d.id) d else s.detail,
                loaded = s.loaded.map { if (it.id == d.id) d else it },
                hidden = s.hidden.map { if (it.id == d.id) d else it },
            )
        }
    }

    fun selectDetailSegment(segment: WorkflowDetailSegment) {
        _state.update { it.copy(detailSegment = segment, inputOpen = false) }
        if (segment == WorkflowDetailSegment.Activity && !_state.value.activityLoaded) {
            scope.launch { loadActivity(reset = true) }
        }
    }

    fun openInput(open: Boolean) = _state.update { it.copy(inputOpen = open) }

    fun loadEarlierActivity() {
        if (_state.value.activityNextAt == null || _state.value.activityLoading) return
        scope.launch { loadActivity(reset = false) }
    }

    private suspend fun loadActivity(reset: Boolean) {
        val id = _state.value.openWorkflowId ?: return
        val repo = repository ?: return
        _state.update { it.copy(activityLoading = true, activityError = null) }
        try {
            val s0 = _state.value
            val page = repo.activity(id, if (reset) null else s0.activityNextAt, if (reset) null else s0.activityNextId)
            _state.update {
                it.copy(
                    activity = if (reset) page.activity else (it.activity + page.activity).distinctBy { a -> a.id },
                    activityNextAt = page.nextBeforeAt,
                    activityNextId = page.nextBeforeId,
                    activityLoading = false,
                    activityLoaded = true,
                )
            }
        } catch (e: WorkflowApiException) {
            _state.update { it.copy(activityLoading = false, activityError = e.message) }
        }
    }

    // ---- writes (design §8: revisions + one idempotency key + receipt check) ----

    /** True while a write is sending or uncertain: every action is disabled meanwhile. */
    val busy: Boolean get() = _state.value.operation.let { it is WorkflowOperation.Sending || it is WorkflowOperation.Uncertain }

    /**
     * Sends [write]; on success applies the returned detail and calls [onSaved]. Refusals keep
     * the sheet's drafts (the caller clears its preview). Uncertain replies stay on the notice.
     */
    fun send(label: String, write: WorkflowWrite, success: String? = null, onSaved: (WorkflowDetailDto) -> Unit = {}) {
        val repo = repository ?: return
        if (busy) return
        _state.update { it.copy(operation = WorkflowOperation.Sending(label)) }
        scope.launch {
            when (val outcome = repo.send(write)) {
                is WorkflowWriteOutcome.Saved -> saved(outcome.detail, success, onSaved)
                is WorkflowWriteOutcome.Refused ->
                    _state.update { it.copy(operation = WorkflowOperation.Refused(label, outcome.message)) }
                is WorkflowWriteOutcome.Uncertain ->
                    _state.update { it.copy(operation = WorkflowOperation.Uncertain(label, outcome.message, outcome.write)) }
            }
        }
    }

    private fun saved(d: WorkflowDetailDto, success: String?, onSaved: (WorkflowDetailDto) -> Unit) {
        applyDetail(d)
        if (_state.value.loaded.none { it.id == d.id } && !d.hidden) {
            _state.update { it.copy(loaded = listOf(d) + it.loaded) }
        }
        _state.update { it.copy(operation = null, notice = success, detailStale = false) }
        onSaved(d)
    }

    /** "Check saved result" on an uncertain write. */
    fun checkSaved(onSaved: (WorkflowDetailDto) -> Unit = {}) {
        val op = _state.value.operation as? WorkflowOperation.Uncertain ?: return
        val repo = repository ?: return
        _state.update { it.copy(operation = WorkflowOperation.Sending(op.label)) }
        scope.launch {
            val receipt = repo.checkReceipt(op.write)
            if (receipt != null) saved(receipt.detail, "Saved", onSaved)
            else _state.update {
                it.copy(operation = op.copy(message = "Orcha has no saved result for this change yet. Retry the same request, or refresh."))
            }
        }
    }

    /** "Retry same request": the SAME write, same idempotency key. */
    fun retrySame(onSaved: (WorkflowDetailDto) -> Unit = {}) {
        val op = _state.value.operation as? WorkflowOperation.Uncertain ?: return
        _state.update { it.copy(operation = null) }
        send(op.label, op.write, "Saved", onSaved)
    }

    fun dismissOperation() {
        if (_state.value.operation is WorkflowOperation.Refused) _state.update { it.copy(operation = null) }
    }

    fun clearNotice() = _state.update { it.copy(notice = null, noticeRestoreId = null) }

    fun notify(text: String, restoreId: String? = null) = _state.update { it.copy(notice = text, noticeRestoreId = restoreId) }

    /** After hiding: back to the list, the card gone, "Workflow hidden" + Restore. */
    fun afterHidden(d: WorkflowDetailDto) {
        _state.update {
            it.copy(
                openWorkflowId = null, detail = null, loaded = it.loaded.filterNot { w -> w.id == d.id },
                notice = "Workflow hidden", noticeRestoreId = d.id,
            )
        }
    }

    /** W06 discussion: the newest thread page, oldest → newest; null on failure. */
    suspend fun taskMessages(taskId: String): List<io.openorcha.mobile.data.TaskMessageDto>? {
        val c = container ?: return null
        return runCatching { api.getTaskMessages(c.baseUrl, taskId).messages }.getOrNull()
    }

    /** W16 "Read approval history" (`GET /api/tasks/{tid}/approvals`), oldest → newest. */
    suspend fun taskApprovals(taskId: String): Result<io.openorcha.mobile.data.TaskApprovalHistoryDto> {
        val repo = repository ?: return Result.failure(IllegalStateException("Not connected"))
        return runCatching { repo.approvals(taskId) }
    }

    /**
     * W16 task authority (`PUT /api/tasks/{tid}/autonomy`). The server allows only the project
     * owner; its refusal comes back as the failure message. On success the loaded workflows
     * are re-read so the switch shows the saved value.
     */
    suspend fun setTaskAutonomy(taskId: String, on: Boolean): Result<io.openorcha.mobile.data.TaskAutonomyResultDto> {
        val repo = repository ?: return Result.failure(IllegalStateException("Not connected"))
        return runCatching { repo.setAutonomy(taskId, if (on) "on" else "off") }
            .onSuccess { refreshList(); if (_state.value.openWorkflowId != null) refreshDetail() }
    }

    /** Posts as the paired human (`author_agent_id`); false keeps the draft. */
    suspend fun postTaskMessage(taskId: String, body: String): Boolean {
        val c = container ?: return false
        val actor = c.humanAgentId ?: return false
        return runCatching { api.postTaskMessage(c.baseUrl, taskId, actor, body) }.isSuccess
    }

    /** W18: plan approval for an autonomy-OFF workflow task (`POST /api/decisions`, subject plan_approval). */
    fun decidePlan(taskId: String, approve: Boolean, reason: String?, onDone: () -> Unit) {
        val c = container ?: return
        val actor = c.humanAgentId ?: return notify(WorkflowsRepository.NO_HUMAN)
        scope.launch {
            runCatching { api.decidePlan(c.baseUrl, taskId, actor, approve, reason, null) }
                .onSuccess { notify(if (approve) "Plan approved" else "Plan sent back"); refreshDetail(); onDone() }
                .onFailure { notify(io.openorcha.mobile.domain.ConnectionErrorCopy.friendly(it)) }
        }
    }

    /** Snackbar Restore for a just-hidden workflow. */
    fun restoreHidden(id: String) {
        val repo = repository ?: return
        scope.launch {
            runCatching { repo.detail(id) }.getOrNull()?.let { d ->
                val key = WorkflowsRepository.newIdempotencyKey()
                send("Restore workflow", io.openorcha.mobile.data.WorkflowWrites.workflowMutation(d, "restore", key), "Workflow restored") {
                    _state.update { s -> s.copy(hidden = s.hidden.filterNot { h -> h.id == id }) }
                    refreshList()
                }
            }
        }
    }
}
