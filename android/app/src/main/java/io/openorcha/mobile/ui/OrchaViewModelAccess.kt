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

import kotlinx.coroutines.CoroutineScope

/** Web-parity retained-line cap for the run feed. */
internal const val RUN_FEED_CAP = 400

/** Slim snapshot window for the saved-container health probes. */
internal const val PROBE_LIMIT = 50

/** Supplies shared state and cross-module operations to the view-model action modules. */
internal interface OrchaViewModelAccess {
    val store: ContainerStore
    val api: OrchaApiClient
    val json: Json
    var pollingJob: Job?
    var runStreamJob: Job?
    /** Chat send-UX: the bounded post-send poll awaiting the turns delta (iOS `replyWatchTask`). */
    var replyWatchJob: Job?
    /** Device-token auth: the GitHub sign-in Custom Tab round-trip bridge (one shared
     *  instance so `MainActivity.onNewIntent` and `signInWithGitHub()` see the same session). */
    val deviceAuthSession: DeviceAuthSession
    val _uiState: MutableStateFlow<OrchaUiState>
    val scope: CoroutineScope

    fun showWorkspace()
    fun refreshSelected()
    fun refreshSelectedTask()
    fun refreshAgentDetail()
    fun refreshConversation()
    suspend fun refreshConversationQuiet(agentId: String)
    fun cancelReplyWatch()
    fun refreshRunLog()
    fun openTask(taskId: String)
    fun cancelRunStream()
    fun startPolling()
    fun pairingBaseUrl(raw: String): String
    fun pairingRemoteUrl(raw: String): String?
    fun pairingContainerId(raw: String): String?
    fun pairingHumanAgentId(raw: String): String?
    fun friendlyConnectionError(err: Throwable? = null): String
    fun messageKey(message: TaskMessageDto): Any
    fun runHumanAction(success: String, block: suspend (StoredContainer, String) -> Unit)

    /**
     * Device-token auth: probe+pair [rawBaseUrl] with an explicit bearer token (or
     * none, for an unprotected server). Shared body for `connectManual` and the
     * GitHub sign-in retry / manual-token entry so every entry point persists a
     * token identically. Implemented once, on [ContainerNavigationActions]. Returns
     * true on a successful connect.
     */
    suspend fun connectWithToken(rawBaseUrl: String, accessToken: String?): Boolean
}
