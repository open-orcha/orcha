package io.openorcha.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import io.openorcha.mobile.data.DeliverableDiffDto
import io.openorcha.mobile.data.DeliverableDto
import io.openorcha.mobile.data.DeliverableLimitsDto
import io.openorcha.mobile.data.DeliverableTextDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.getDeliverable
import io.openorcha.mobile.data.getDeliverableDiff
import io.openorcha.mobile.data.getDeliverableRaw
import io.openorcha.mobile.data.getDeliverableText
import io.openorcha.mobile.data.listDeliverables
import io.openorcha.mobile.data.uploadDeliverable
import io.openorcha.mobile.domain.DeliverablesUx
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class TaskDeliverablesState(
    val taskId: String? = null,
    /** false until the first answer; a 404 (an older server) keeps the section hidden */
    val available: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val items: List<DeliverableDto> = emptyList(),
    val limits: DeliverableLimitsDto = DeliverableLimitsDto(),
    val uploading: Boolean = false,
    val uploadError: String? = null,
    val notice: String? = null,
)

/**
 * Task deliverables state, kept out of the shared view model (no `MainActivity` wiring): the
 * list, a human upload, and the on-demand reads the preview sheet makes. Reuses the process-wide
 * client from [TaskInsightsController] so auth and decoding match every other call.
 */
class TaskDeliverablesController(
    private val scope: CoroutineScope,
    private val api: OrchaApiClient = TaskInsightsController.sharedApi,
) {
    private val _state = MutableStateFlow(TaskDeliverablesState())
    val state: StateFlow<TaskDeliverablesState> = _state
    private var loadJob: Job? = null

    fun load(container: StoredContainer, taskId: String) {
        loadJob?.cancel()
        if (_state.value.taskId != taskId) _state.value = TaskDeliverablesState(taskId = taskId)
        _state.update { it.copy(loading = true) }
        loadJob = scope.launch {
            runCatching { api.listDeliverables(container.baseUrl, taskId) }
                .onSuccess { list ->
                    _state.update { it.copy(available = true, loading = false, error = null, items = list.deliverables, limits = list.limits) }
                }
                .onFailure { e ->
                    val status = TaskInsightsController.statusOf(e)
                    _state.update {
                        if (status == 404 && !it.available) it.copy(loading = false)
                        else it.copy(available = true, loading = false, error = if (it.items.isEmpty()) "Deliverables unavailable — ${TaskInsightsController.errorText(e).trimEnd('.')}." else null)
                    }
                }
        }
    }

    fun clearNotice() = _state.update { it.copy(notice = null) }

    fun upload(container: StoredContainer, taskId: String, fileName: String, mimeType: String, read: () -> ByteArray?) {
        val actor = container.humanAgentId ?: run {
            _state.update { it.copy(uploadError = "Pairing is missing the human identity. Reconnect this Embodent first.") }
            return
        }
        val limits = _state.value.limits
        if (!DeliverablesUx.extensionAllowed(fileName, limits.allowedExtensions)) {
            _state.update {
                it.copy(uploadError = "Embodent can't attach “$fileName”. Allowed: " + limits.allowedExtensions.joinToString(", ") { e -> ".$e" } + ".")
            }
            return
        }
        scope.launch {
            _state.update { it.copy(uploading = true, uploadError = null) }
            runCatching {
                val bytes = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { read() }
                    ?: throw Unreadable()
                if (limits.maxBytes > 0 && bytes.size > limits.maxBytes) throw TooLarge(limits.maxBytes)
                api.uploadDeliverable(container.baseUrl, taskId, actor, fileName, mimeType, bytes)
            }.onSuccess { r ->
                _state.update { it.copy(uploading = false, notice = DeliverablesUx.uploadNotice(fileName, r.deduplicated)) }
                load(container, taskId)
            }.onFailure { e ->
                val msg = when {
                    e is TooLarge -> DeliverablesUx.tooLargeCopy(e.max)
                    e is Unreadable -> "Couldn't read “$fileName” from the phone."
                    else -> "Couldn't attach $fileName — " + TaskInsightsController.errorText(e).replaceFirstChar { c -> c.lowercase() }
                }
                _state.update { it.copy(uploading = false, uploadError = msg) }
            }
        }
    }

    suspend fun detail(container: StoredContainer, taskId: String, id: String): Result<DeliverableDto> =
        runCatching { api.getDeliverable(container.baseUrl, taskId, id) }

    suspend fun text(container: StoredContainer, textUrl: String): Result<DeliverableTextDto> =
        runCatching { api.getDeliverableText(container.baseUrl, textUrl) }

    suspend fun raw(container: StoredContainer, rawUrl: String): ByteArray =
        api.getDeliverableRaw(container.baseUrl, rawUrl)

    suspend fun diff(container: StoredContainer, taskId: String, id: String, from: Int, to: Int): Result<DeliverableDiffDto> =
        runCatching { api.getDeliverableDiff(container.baseUrl, taskId, id, from, to) }

    /** The server's own wording for a failed read. */
    suspend fun describe(e: Throwable): String = TaskInsightsController.errorText(e)

    private class TooLarge(val max: Long) : Exception()
    private class Unreadable : Exception()
}

@Composable
fun rememberTaskDeliverables(): TaskDeliverablesController {
    val scope = rememberCoroutineScope()
    return remember { TaskDeliverablesController(scope) }
}
