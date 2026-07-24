package io.openorcha.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.ContainerStore
import io.openorcha.mobile.data.ConversationDto
import io.openorcha.mobile.data.ModelDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.OrchaServerAddress
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.RunStream
import io.openorcha.mobile.data.RunStreamEvent
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.Paging
import io.openorcha.mobile.domain.RunFeed
import io.openorcha.mobile.domain.RunFeedRow
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Owns human task decisions, task messages, and primary request actions. */
internal interface TaskAndRequestHumanActions : OrchaViewModelAccess {
fun sendTaskMessage(body: String) = runHumanAction("Message sent") { selected, actor ->
    val task = _uiState.value.selectedTask ?: error("No task selected")
    api.postTaskMessage(selected.baseUrl, task.id, actor, body)
    // issue 4: re-fetch only the NEWEST page; earlier-loaded pages (and their
    // cursors) stay put instead of collapsing back to one page.
    val resp = api.getTaskMessages(selected.baseUrl, task.id)
    _uiState.update { st ->
        val firstLoad = st.taskMessages.isEmpty()
        st.copy(
            taskMessages = Paging.mergeNewest(st.taskMessages, resp.messages, ::messageKey),
            threadHasMore = if (firstLoad) resp.hasMore == true else st.threadHasMore,
            threadNextBefore = if (firstLoad) resp.nextBefore else st.threadNextBefore,
            threadNextBeforeId = if (firstLoad) resp.nextBeforeId else st.threadNextBeforeId,
        )
    }
}

fun cancelSelectedTask(reason: String?) = runHumanAction("Task closed") { selected, actor ->
    val task = _uiState.value.selectedTask ?: error("No task selected")
    api.cancelTask(selected.baseUrl, task.id, actor, reason)
    refreshSelected()
    showWorkspace()
}

fun verifySelectedTask(approve: Boolean, feedback: String?) = runHumanAction(if (approve) "Task verified" else "Task sent back") { selected, actor ->
    val task = _uiState.value.selectedTask ?: error("No task selected")
    api.verifyTask(selected.baseUrl, task.id, actor, approve, feedback)
    refreshSelectedTask()
    refreshSelected()
}

/** Flow 08: verify straight from the Home-tab queue card (no navigation). */
fun verifyTaskById(taskId: String, approve: Boolean, feedback: String?) =
    runHumanAction(if (approve) "Task accepted · completed" else "Task sent back") { selected, actor ->
        api.verifyTask(selected.baseUrl, taskId, actor, approve, feedback)
        refreshSelected()
    }

/** Flow 08: plan decision straight from the Home-tab queue card. */
fun decidePlanById(taskId: String, approve: Boolean, reason: String?) =
    runHumanAction(if (approve) "Plan approved" else "Changes requested") { selected, actor ->
        val task = _uiState.value.snapshot?.tasks?.firstOrNull { it.id == taskId }
        val target = task?.ownerId ?: task?.createdByAgentId
        api.decidePlan(selected.baseUrl, taskId, actor, approve, reason, target)
        refreshSelected()
    }

fun decideSelectedPlan(approve: Boolean, reason: String?) = runHumanAction(if (approve) "Plan approved" else "Plan changes sent") { selected, actor ->
    val task = _uiState.value.selectedTask ?: error("No task selected")
    val target = task.ownerId ?: task.createdByAgentId
    api.decidePlan(selected.baseUrl, task.id, actor, approve, reason, target)
    refreshSelectedTask()
    refreshSelected()
}

fun respondSelectedRequest(text: String) = runHumanAction("Answer sent") { selected, actor ->
    val request = _uiState.value.selectedRequest ?: error("No request selected")
    api.respondRequest(selected.baseUrl, request.id, actor, text)
    refreshSelected()
    showWorkspace()
}

fun closeSelectedRequest(reason: String?) = runHumanAction("Request closed") { selected, actor ->
    val request = _uiState.value.selectedRequest ?: error("No request selected")
    api.closeRequest(selected.baseUrl, request.id, actor, reason)
    refreshSelected()
    showWorkspace()
}

/**
 * Flow 07a: nudge the next-action owner. The server never changes state; it returns
 * `{nudged: false}` when the next action is a human's (nothing to wake) — that is an
 * INFORMATIONAL outcome, not an error, so it still shows as a (non-alarming) snackbar.
 * On `{nudged: true}` the routed recipient is deterministic client-side: the target on an
 * `open` ask, the requester on an `answered` one (spec §5).
 */
fun nudgeSelectedRequest(note: String?) {
    val selected = _uiState.value.selectedContainer ?: return
    val actor = selected.humanAgentId ?: run {
        _uiState.update { it.copy(error = "Pairing is missing the human identity. Reconnect this Orcha first.") }
        return
    }
    val request = _uiState.value.selectedRequest ?: return
    val agents = _uiState.value.snapshot?.agents.orEmpty()
    scope.launch {
        _uiState.update { it.copy(actionInFlight = true, error = null) }
        runCatching { api.nudgeRequest(selected.baseUrl, request.id, actor, note) }
            .onSuccess { resp ->
                val recipientId = if (request.status == "open") request.targetId else request.requesterId
                val alias = io.openorcha.mobile.domain.RequestsView.aliasFor(agents, recipientId)
                val toast = if (resp.nudged == false) {
                    "No agent to wake — a human owns the next action."
                } else {
                    "Nudged ${alias ?: "the other agent"}"
                }
                refreshSelected()
                _uiState.update { it.copy(actionInFlight = false, toast = toast) }
            }
            .onFailure { err -> _uiState.update { it.copy(actionInFlight = false, error = friendlyConnectionError(err)) } }
    }
}

}
