package io.openorcha.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import io.openorcha.mobile.data.EvidencePackDto
import io.openorcha.mobile.data.GoalChainDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.RoutineCreateBody
import io.openorcha.mobile.data.RoutineDto
import io.openorcha.mobile.data.SchedulePreviewDto
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.VerdiktRunsResponse
import io.openorcha.mobile.data.createRoutine
import io.openorcha.mobile.data.getGoalChain
import io.openorcha.mobile.data.getTaskEvidence
import io.openorcha.mobile.data.getVerdiktRuns
import io.openorcha.mobile.data.listRoutinesFromTask
import io.openorcha.mobile.data.previewSchedule
import io.openorcha.mobile.data.reassignTask
import io.openorcha.mobile.data.setTaskReviewer
import io.openorcha.mobile.data.triggerVerdikt
import io.ktor.client.plugins.ResponseException
import io.ktor.client.statement.bodyAsText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** What the task-detail parity sections show. Each part loads independently; a failure in one never hides the others. */
data class TaskInsightsState(
    val taskId: String? = null,
    val evidence: EvidencePackDto? = null,
    val evidenceLoading: Boolean = false,
    val evidenceError: String? = null,
    val goalChain: GoalChainDto? = null,
    val verdikt: VerdiktRunsResponse? = null,
    val routines: List<RoutineDto> = emptyList(),
    /** a sheet / inline action is in flight */
    val busy: Boolean = false,
    val actionError: String? = null,
    /** one-shot confirmation the screen shows (then clears) */
    val notice: String? = null,
)

/**
 * Task-detail parity state, kept OUT of the shared view model (and so out of `MainActivity`
 * wiring): a small controller remembered by the task screen, with its own [StateFlow]. It
 * reuses one process-wide [OrchaApiClient] so bearer auth and decoding match every other call.
 */
class TaskInsightsController(private val scope: CoroutineScope, private val api: OrchaApiClient = sharedApi) {
    private val _state = MutableStateFlow(TaskInsightsState())
    val state: StateFlow<TaskInsightsState> = _state
    private var loadJob: Job? = null

    fun load(container: StoredContainer, taskId: String) {
        loadJob?.cancel()
        val fresh = _state.value.taskId != taskId
        _state.update {
            if (fresh) TaskInsightsState(taskId = taskId, evidenceLoading = true)
            else it.copy(evidenceLoading = true, evidenceError = null)
        }
        val base = container.baseUrl
        loadJob = scope.launch {
            val evidence = async { runCatching { api.getTaskEvidence(base, taskId) } }
            val chain = async { runCatching { api.getGoalChain(base, taskId) } }
            val verdikt = async { runCatching { api.getVerdiktRuns(base, taskId) } }
            val routines = async { runCatching { api.listRoutinesFromTask(base, container.id, taskId).routines } }
            val ev = evidence.await()
            _state.update {
                it.copy(
                    evidence = ev.getOrNull() ?: it.evidence,
                    evidenceLoading = false,
                    // a 404 means an older server without evidence packs: show nothing, not an error
                    evidenceError = ev.exceptionOrNull()?.takeUnless { e -> statusOf(e) == 404 }?.let { "Evidence couldn't be loaded." },
                )
            }
            _state.update {
                it.copy(
                    goalChain = chain.await().getOrNull() ?: it.goalChain,
                    verdikt = verdikt.await().getOrNull() ?: it.verdikt,
                    routines = routines.await().getOrNull() ?: it.routines,
                )
            }
        }
    }

    fun clearNotice() = _state.update { it.copy(notice = null) }
    fun clearError() = _state.update { it.copy(actionError = null) }

    fun reassign(container: StoredContainer, taskId: String, agentId: String, agentAlias: String, onDone: () -> Unit) =
        act(container, "Reassigned to $agentAlias", onDone) { actor -> api.reassignTask(container.baseUrl, taskId, actor, agentId) }

    fun setReviewer(container: StoredContainer, taskId: String, reviewerId: String?, onDone: () -> Unit) =
        act(container, if (reviewerId == null) "Reviewer cleared — anyone can verify" else "Reviewer assigned", onDone) { actor ->
            api.setTaskReviewer(container.baseUrl, taskId, actor, reviewerId)
        }

    fun runVerdikt(container: StoredContainer, taskId: String, onDone: () -> Unit) =
        act(container, "Sent to Verdikt", { load(container, taskId); onDone() }) { actor ->
            api.triggerVerdikt(container.baseUrl, taskId, actor)
        }

    fun createRoutine(container: StoredContainer, body: (String) -> RoutineCreateBody, onDone: () -> Unit) {
        var created: RoutineDto? = null
        act(container, null, {
            val r = created
            _state.update {
                it.copy(
                    routines = if (r != null) it.routines + r else it.routines,
                    notice = "Routine created" + (r?.scheduleText?.takeIf { s -> s.isNotBlank() }?.let { s -> " — $s" } ?: "") + ". The task is unchanged.",
                )
            }
            onDone()
        }) { actor -> created = api.createRoutine(container.baseUrl, container.id, body(actor)) }
    }

    /** Schedule preview for the routine sheet; null on transport failure (the sheet just shows the preset text). */
    suspend fun preview(container: StoredContainer, cron: String, timezone: String): SchedulePreviewDto? =
        runCatching { api.previewSchedule(container.baseUrl, container.id, cron, timezone) }.getOrNull()

    private fun act(container: StoredContainer, success: String?, onDone: () -> Unit, block: suspend (String) -> Unit) {
        val actor = container.humanAgentId ?: run {
            _state.update { it.copy(actionError = "Pairing is missing the human identity. Reconnect this Embodent first.") }
            return
        }
        scope.launch {
            _state.update { it.copy(busy = true, actionError = null) }
            runCatching { block(actor) }
                .onSuccess {
                    _state.update { it.copy(busy = false, notice = success ?: it.notice) }
                    onDone()
                }
                .onFailure { err -> _state.update { it.copy(busy = false, actionError = errorText(err)) } }
        }
    }

    companion object {
        /** One client for the process — Ktor clients are heavyweight; auth is global via BearerTokens. */
        val sharedApi: OrchaApiClient by lazy { OrchaApiClient() }

        private val json = Json { ignoreUnknownKeys = true }

        internal fun statusOf(e: Throwable): Int? = (e as? ResponseException)?.response?.status?.value

        /** The server's own `detail` (FastAPI) when it sent one, else a plain fallback. */
        internal suspend fun errorText(e: Throwable): String {
            val resp = (e as? ResponseException)?.response ?: return "Couldn't reach Embodent. Check the connection and try again."
            val detail = runCatching {
                json.parseToJsonElement(resp.bodyAsText()).jsonObject["detail"]?.jsonPrimitive?.content
            }.getOrNull()
            return detailText(resp.status.value, detail)
        }

        internal fun detailText(status: Int, detail: String?): String = when {
            !detail.isNullOrBlank() -> detail.replaceFirstChar { it.uppercase() }
            status == 403 -> "You don't have permission to do that on this project."
            status == 404 -> "This Embodent server doesn't support that yet."
            else -> "Something went wrong (HTTP $status)."
        }
    }
}

/** Remembers one controller per task screen, scoped to its composition. */
@Composable
fun rememberTaskInsights(): TaskInsightsController {
    val scope = rememberCoroutineScope()
    return remember { TaskInsightsController(scope) }
}
