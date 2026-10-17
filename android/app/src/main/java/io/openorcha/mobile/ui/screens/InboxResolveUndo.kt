package io.openorcha.mobile.ui.screens

/* One-tap Resolve with Undo for an answered question you asked (web
   pages/requests/resolveUndo.ts). The backend has no "reopen", so Undo can't be a
   second write: the close is DEFERRED for RESOLVE_UNDO_MS and only then sent. Process
   scoped (not screen state) so leaving the screen inside the window still sends it. */

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.openorcha.mobile.data.InboxApi
import io.openorcha.mobile.data.RequestDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

const val RESOLVE_UNDO_MS = 5_000L

object ResolveUndoStore {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val pending = mutableStateMapOf<String, Job>()
    /** Sent closes not yet reflected by a refreshed snapshot — shown as resolved meanwhile. */
    private val resolved = mutableStateMapOf<String, Boolean>()

    /** The last failed resolve: request id to a plain-words reason. */
    var failure by mutableStateOf<Pair<String, String>?>(null)
        private set

    fun isPending(id: String): Boolean = pending.containsKey(id)

    /** Pending or already sent: the request should read as resolved. */
    fun isResolving(id: String): Boolean = pending.containsKey(id) || resolved.containsKey(id)

    /** The status to show for [req]: "closed" while a resolve is pending or in flight. */
    fun displayStatus(req: RequestDto): String =
        if (req.status == "answered" && isResolving(req.id)) "closed" else req.status

    fun schedule(baseUrl: String, requestId: String, requesterId: String, onDone: () -> Unit = {}) {
        pending.remove(requestId)?.cancel()
        if (failure?.first == requestId) failure = null
        pending[requestId] = scope.launch {
            delay(RESOLVE_UNDO_MS)
            pending.remove(requestId)
            resolved[requestId] = true
            runCatching { InboxApi.closeRequest(baseUrl, requestId, requesterId) }
                .onSuccess { onDone() }
                .onFailure {
                    resolved.remove(requestId)
                    failure = requestId to "Couldn't resolve this request — Embodent couldn't be reached. It's still open."
                }
        }
    }

    /** Cancel a scheduled resolve. True when there was one to cancel. */
    fun undo(requestId: String): Boolean {
        val job = pending.remove(requestId) ?: return false
        job.cancel()
        return true
    }

    /** Forget sent closes once a refreshed snapshot shows them closed. */
    fun reconcile(requests: List<RequestDto>) {
        requests.forEach { if (it.status != "answered") resolved.remove(it.id) }
    }

    fun clearFailure() {
        failure = null
    }
}
