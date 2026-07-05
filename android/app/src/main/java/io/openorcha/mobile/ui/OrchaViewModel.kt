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

enum class AppRoute {
    Containers,
    Scanner,
    AddContainer,
    Workspace,
    TaskDetail,
    TaskThread,
    RequestDetail,
    AgentDetail,
    RunDetail,
    Conversation,
    CreateTask,
    Settings,
}

enum class WorkspaceTab { Home, Tasks, Requests, Agents }

/** Per-card reachability + glance counts for the Containers home (flow 04 H1). */
data class ContainerHealth(
    val state: String,               // live | polling | unreachable | probing
    val agents: Int = 0,
    val tasks: Int = 0,
    val needsYou: Int = 0,
)

/** Flow 09: lazily-fetched agent-detail sections (each best-effort, absent on failure). */
data class AgentExtras(
    val persona: io.openorcha.mobile.data.PersonaResponse? = null,
    val digest: io.openorcha.mobile.data.DigestDto? = null,
    val inboxCount: Int? = null,
    val inboxPreview: String? = null,
    val outboxOpen: Int? = null,
    val outboxAnswered: Int? = null,
)

data class OrchaUiState(
    val route: AppRoute = AppRoute.Containers,
    val themeMode: io.openorcha.mobile.ui.theme.ThemeMode = io.openorcha.mobile.ui.theme.ThemeMode.Auto,
    val containerHealth: Map<String, ContainerHealth> = emptyMap(),
    val agentExtras: AgentExtras = AgentExtras(),
    val closeImplications: List<String>? = null,
    val containers: List<StoredContainer> = emptyList(),
    val selectedContainer: StoredContainer? = null,
    val snapshot: ContainerSnapshot? = null,
    val selectedTab: WorkspaceTab = WorkspaceTab.Home,
    val selectedTask: TaskDto? = null,
    val taskMessages: List<TaskMessageDto> = emptyList(),
    // thread keyset paging (issue 4): cursors point at the OLDEST loaded message
    val threadHasMore: Boolean = false,
    val threadNextBefore: String? = null,
    val threadNextBeforeId: String? = null,
    val threadLoadingEarlier: Boolean = false,
    val taskRuns: List<RunDto> = emptyList(),
    val selectedRequest: RequestDto? = null,
    val selectedAgent: AgentDto? = null,
    val agentRuns: List<RunDto> = emptyList(),
    val selectedRun: RunDto? = null,
    val runFeed: List<RunFeedRow> = emptyList(),
    // neutral stream-health note (issue 3): never the Wi-Fi banner for a mid-stream drop
    val runStreamNote: String? = null,
    val models: List<ModelDto> = emptyList(),
    val conversation: ConversationDto? = null,
    val turns: List<TurnDto> = emptyList(),
    val loading: Boolean = false,
    val actionInFlight: Boolean = false,
    val connecting: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
)

class OrchaViewModel(application: Application) : AndroidViewModel(application) {
    private val store = ContainerStore(application)
    private val api = OrchaApiClient()
    private val json = Json { ignoreUnknownKeys = true }
    private var pollingJob: Job? = null
    private var runStreamJob: Job? = null

    private val _uiState = MutableStateFlow(
        OrchaUiState(
            containers = store.load(),
            themeMode = runCatching {
                io.openorcha.mobile.ui.theme.ThemeMode.valueOf(
                    store.loadThemeMode().replaceFirstChar { it.uppercase() },
                )
            }.getOrDefault(io.openorcha.mobile.ui.theme.ThemeMode.Auto),
        ),
    )
    val uiState: StateFlow<OrchaUiState> = _uiState

    init {
        val first = _uiState.value.containers.firstOrNull()
        if (first != null) openContainer(first.id) else probeContainers()
    }

    fun showContainers() {
        pollingJob?.cancel()
        cancelRunStream()
        _uiState.update { it.copy(route = AppRoute.Containers, error = null, selectedTask = null, selectedRequest = null, selectedAgent = null) }
        probeContainers()
    }

    fun showSettings() {
        _uiState.update { it.copy(route = AppRoute.Settings, error = null) }
    }

    fun setThemeMode(mode: io.openorcha.mobile.ui.theme.ThemeMode) {
        store.saveThemeMode(mode.name.lowercase())
        _uiState.update { it.copy(themeMode = mode) }
    }

    fun renameContainer(id: String, name: String) {
        if (name.isBlank()) return
        val containers = store.rename(id, name.trim())
        _uiState.update { st ->
            st.copy(
                containers = containers,
                selectedContainer = st.selectedContainer?.let { sel ->
                    containers.firstOrNull { it.id == sel.id } ?: sel
                },
            )
        }
    }

    /** Flow 04: per-card reachability probe + glance counts, non-blocking per card. */
    fun probeContainers() {
        val targets = _uiState.value.containers
        targets.forEach { stored ->
            viewModelScope.launch {
                _uiState.update { it.copy(containerHealth = it.containerHealth + (stored.id to (it.containerHealth[stored.id]?.copy(state = "probing") ?: ContainerHealth("probing")))) }
                // issue 4: the home cards need counts only — fetch a slim snapshot window
                // (server orders needs-attention rows first, so needsYou stays accurate)
                // and read totals from task_total/request_total instead of row counts.
                val health = runCatching { api.getSnapshot(stored.baseUrl, stored.id, taskLimit = PROBE_LIMIT, requestLimit = PROBE_LIMIT) }
                    .map { snap ->
                        val needs = io.openorcha.mobile.domain.OrchaSelectors.needsYou(snap).total
                        ContainerHealth("polling", snap.agents.size, snap.taskTotal ?: snap.tasks.size, needs)
                    }
                    .getOrElse { ContainerHealth("unreachable") }
                _uiState.update { it.copy(containerHealth = it.containerHealth + (stored.id to health)) }
            }
        }
    }

    fun openThread() {
        if (_uiState.value.selectedTask == null) return
        _uiState.update { it.copy(route = AppRoute.TaskThread, error = null) }
    }

    fun backToTaskDetail() {
        cancelRunStream()
        _uiState.update { it.copy(route = AppRoute.TaskDetail, error = null) }
    }

    fun showAddContainer() {
        _uiState.update { it.copy(route = AppRoute.AddContainer, error = null) }
    }

    fun showScanner() {
        _uiState.update { it.copy(route = AppRoute.Scanner, error = null) }
    }

    /** Flow 03: a scanned QR payload runs through the same parse+probe as manual entry. */
    fun connectScanned(payload: String) {
        _uiState.update { it.copy(route = AppRoute.AddContainer) }
        connectManual(payload)
    }

    fun showWorkspace() {
        cancelRunStream()
        _uiState.update {
            it.copy(
                route = AppRoute.Workspace,
                selectedTask = null,
                selectedRequest = null,
                selectedAgent = null,
                selectedRun = null,
                taskMessages = emptyList(),
                threadHasMore = false,
                threadNextBefore = null,
                threadNextBeforeId = null,
                taskRuns = emptyList(),
                agentRuns = emptyList(),
                runFeed = emptyList(),
                runStreamNote = null,
                conversation = null,
                turns = emptyList(),
                error = null,
            )
        }
    }

    fun showCreateTask() {
        _uiState.update { it.copy(route = AppRoute.CreateTask, error = null) }
    }

    fun selectTab(tab: WorkspaceTab) {
        _uiState.update { it.copy(selectedTab = tab) }
    }

    fun connectManual(rawBaseUrl: String) {
        val baseUrl = try {
            OrchaServerAddress.normalize(pairingBaseUrl(rawBaseUrl))
        } catch (err: IllegalArgumentException) {
            _uiState.update { it.copy(error = err.message ?: friendlyConnectionError()) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(connecting = true, error = null) }
            runCatching {
                val container = api.listContainers(baseUrl).containers.firstOrNull()
                    ?: error("No Orcha container was found at this address.")
                val snapshot = api.getSnapshot(baseUrl, container.id)
                val human = snapshot.agents.firstOrNull { it.kind == "human" }
                StoredContainer(
                    id = container.id,
                    displayName = container.name,
                    baseUrl = baseUrl,
                    humanAgentId = human?.id,
                    humanAlias = human?.alias,
                    lastOpenedAt = System.currentTimeMillis(),
                ) to snapshot
            }.onSuccess { (stored, snapshot) ->
                val containers = store.upsert(stored)
                _uiState.update {
                    it.copy(
                        containers = containers,
                        selectedContainer = stored,
                        snapshot = snapshot,
                        route = AppRoute.Workspace,
                        connecting = false,
                        selectedTab = WorkspaceTab.Home,
                    )
                }
                startPolling()
            }.onFailure { err ->
                android.util.Log.w("OrchaApp", "connect failed", err)
                _uiState.update { it.copy(connecting = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    fun openContainer(id: String) {
        val selected = _uiState.value.containers.firstOrNull { it.id == id } ?: return
        val touched = selected.copy(lastOpenedAt = System.currentTimeMillis())
        val containers = store.upsert(touched)
        _uiState.update {
            it.copy(
                containers = containers,
                selectedContainer = touched,
                route = AppRoute.Workspace,
                selectedTab = WorkspaceTab.Home,
                error = null,
            )
        }
        refreshSelected()
        startPolling()
    }

    fun refreshSelected() {
        val selected = _uiState.value.selectedContainer ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching {
                api.getSnapshot(selected.baseUrl, selected.id)
            }.onSuccess { snapshot ->
                val human = snapshot.agents.firstOrNull { it.kind == "human" }
                val upgraded = if (selected.humanAgentId == null && human != null) {
                    selected.copy(humanAgentId = human.id, humanAlias = human.alias)
                } else {
                    selected
                }
                if (upgraded != selected) {
                    val containers = store.upsert(upgraded)
                    _uiState.update { it.copy(containers = containers, selectedContainer = upgraded) }
                }
                _uiState.update { state ->
                    state.copy(
                        snapshot = snapshot,
                        selectedTask = state.selectedTask?.let { task -> snapshot.tasks.firstOrNull { it.id == task.id } ?: task },
                        selectedRequest = state.selectedRequest?.let { request -> snapshot.requests.firstOrNull { it.id == request.id } ?: request },
                        selectedAgent = state.selectedAgent?.let { agent -> snapshot.agents.firstOrNull { it.id == agent.id } ?: agent },
                        loading = false,
                    )
                }
            }.onFailure { err ->
                _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    fun openTask(taskId: String) {
        val task = _uiState.value.snapshot?.tasks?.firstOrNull { it.id == taskId } ?: return
        cancelRunStream()
        _uiState.update {
            it.copy(
                route = AppRoute.TaskDetail, selectedTask = task, taskMessages = emptyList(),
                threadHasMore = false, threadNextBefore = null, threadNextBeforeId = null,
                taskRuns = emptyList(), error = null,
            )
        }
        refreshSelectedTask()
    }

    fun refreshSelectedTask() {
        val selected = _uiState.value.selectedContainer ?: return
        val task = _uiState.value.selectedTask ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching {
                // newest thread page only (issue 4) — older pages load on demand
                val messages = api.getTaskMessages(selected.baseUrl, task.id)
                val runs = api.getTaskRuns(selected.baseUrl, task.id).runs
                messages to runs
            }.onSuccess { (resp, runs) ->
                _uiState.update {
                    it.copy(
                        taskMessages = resp.messages,
                        threadHasMore = resp.hasMore == true,
                        threadNextBefore = resp.nextBefore,
                        threadNextBeforeId = resp.nextBeforeId,
                        taskRuns = runs,
                        loading = false,
                    )
                }
            }.onFailure { err ->
                _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    /** Issue 4: "Load earlier" — fetch the page before the oldest loaded message and prepend. */
    fun loadEarlierMessages() {
        val selected = _uiState.value.selectedContainer ?: return
        val task = _uiState.value.selectedTask ?: return
        val before = _uiState.value.threadNextBefore ?: return
        val beforeId = _uiState.value.threadNextBeforeId
        if (_uiState.value.threadLoadingEarlier) return
        viewModelScope.launch {
            _uiState.update { it.copy(threadLoadingEarlier = true) }
            runCatching { api.getTaskMessages(selected.baseUrl, task.id, before = before, beforeId = beforeId) }
                .onSuccess { resp ->
                    _uiState.update { st ->
                        st.copy(
                            taskMessages = Paging.prependOlder(st.taskMessages, resp.messages, ::messageKey),
                            threadHasMore = resp.hasMore == true,
                            threadNextBefore = resp.nextBefore,
                            threadNextBeforeId = resp.nextBeforeId,
                            threadLoadingEarlier = false,
                        )
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(threadLoadingEarlier = false, error = friendlyConnectionError(err)) }
                }
        }
    }

    fun openRequest(requestId: String) {
        val request = _uiState.value.snapshot?.requests?.firstOrNull { it.id == requestId } ?: return
        _uiState.update { it.copy(route = AppRoute.RequestDetail, selectedRequest = request, error = null) }
    }

    fun openAgent(agentId: String) {
        val agent = _uiState.value.snapshot?.agents?.firstOrNull { it.id == agentId } ?: return
        cancelRunStream()
        _uiState.update { it.copy(route = AppRoute.AgentDetail, selectedAgent = agent, agentRuns = emptyList(), models = emptyList(), error = null) }
        refreshAgentDetail()
    }

    fun refreshAgentDetail() {
        val selected = _uiState.value.selectedContainer ?: return
        val agent = _uiState.value.selectedAgent ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null, agentExtras = AgentExtras()) }
            runCatching {
                // flow 09 §9: headless + resident runs merged, newest first
                val headless = api.getAgentRuns(selected.baseUrl, agent.id).runs
                val resident = runCatching { api.getResidentRuns(selected.baseUrl, agent.id).runs }.getOrDefault(emptyList())
                val runs = (headless + resident).distinctBy { it.runId }.sortedByDescending { it.startedAt ?: "" }
                val models = api.listModels(selected.baseUrl).models
                runs to models
            }.onSuccess { (runs, models) ->
                _uiState.update { it.copy(agentRuns = runs, models = models, loading = false) }
            }.onFailure { err ->
                _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
            }
            // lazy sections — each best-effort, independent of the core fetch (flow 09 §states)
            val persona = runCatching { api.getPersona(selected.baseUrl, agent.id) }.getOrNull()
            val digest = runCatching { api.getDigest(selected.baseUrl, agent.id).digest }.getOrNull()
            val inbox = runCatching { api.getInbox(selected.baseUrl, agent.id).openRequests }.getOrNull()
            val outbox = runCatching { api.getOutbox(selected.baseUrl, agent.id).outgoingRequests }.getOrNull()
            _uiState.update {
                it.copy(
                    agentExtras = AgentExtras(
                        persona = persona,
                        digest = digest,
                        inboxCount = inbox?.size,
                        inboxPreview = inbox?.firstOrNull()?.payload,
                        outboxOpen = outbox?.count { r -> r.status == "open" },
                        outboxAnswered = outbox?.count { r -> r.status == "answered" },
                    ),
                )
            }
        }
    }

    /** Flow 05: fetch the close-implications preview before showing the destructive confirm. */
    fun fetchCloseImplications() {
        val selected = _uiState.value.selectedContainer ?: return
        val task = _uiState.value.selectedTask ?: return
        viewModelScope.launch {
            val imp = runCatching { api.getCloseImplications(selected.baseUrl, task.id) }.getOrNull()
            val lines = buildList {
                imp?.summary?.takeIf { it.isNotBlank() }?.let { add(it) }
                addAll(imp?.implications.orEmpty())
            }
            _uiState.update { it.copy(closeImplications = lines.ifEmpty { null }) }
        }
    }

    /** Flow 09: rename an agent (overflow → Details). PARTIAL update, human-gated. */
    fun renameSelectedAgent(alias: String) = runHumanAction("Agent renamed") { selected, actor ->
        val agent = _uiState.value.selectedAgent ?: error("No agent selected")
        api.updateAgent(selected.baseUrl, agent.id, actor, alias, null)
        refreshSelected()
    }

    fun openRun(run: RunDto) {
        cancelRunStream()
        _uiState.update { it.copy(route = AppRoute.RunDetail, selectedRun = run, runFeed = emptyList(), runStreamNote = null, error = null) }
        refreshRunLog()
    }

    /**
     * Issue 3: a RUNNING run gets a live collector on the same SSE endpoint the web
     * streams (incremental read, per-request infinite timeout); a finished run keeps
     * the one-shot fetch (the server closes those streams immediately).
     */
    fun refreshRunLog() {
        val selected = _uiState.value.selectedContainer ?: return
        val run = _uiState.value.selectedRun ?: return
        val agentId = run.agentId ?: _uiState.value.selectedAgent?.id ?: return
        cancelRunStream()
        if (run.status == "running") {
            _uiState.update { it.copy(loading = false, error = null, runStreamNote = null, runFeed = emptyList()) }
            runStreamJob = viewModelScope.launch { collectRunStream(selected.baseUrl, agentId, run) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null, runStreamNote = null) }
            runCatching {
                feedFromStreamText(api.getRunStreamText(selected.baseUrl, agentId, run.runId))
            }.onSuccess { rows ->
                _uiState.update { it.copy(runFeed = rows, loading = false) }
            }.onFailure { err ->
                _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    /**
     * Web startRunStream parity (app.js:1444-1468): monotonic-seq dedup, immediate reopen
     * on the 30-min stream_timeout, terminal done marks the run finished. A mid-stream
     * drop retries with backoff behind a neutral note — never the Wi-Fi banner.
     */
    private suspend fun collectRunStream(baseUrl: String, agentId: String, run: RunDto) {
        var maxSeq = 0
        var backoffMs = 1_000L
        while (currentCoroutineContext().isActive) {
            var terminal: RunStreamEvent.Done? = null
            val attempt = runCatching {
                api.streamRun(baseUrl, agentId, run.runId).collect { event ->
                    when (event) {
                        is RunStreamEvent.Line -> if (event.seq > maxSeq) { // drops reconnect replay
                            maxSeq = event.seq
                            backoffMs = 1_000L
                            val rows = RunFeed.classifyLine(event.line)
                            if (rows.isNotEmpty()) {
                                _uiState.update { st ->
                                    st.copy(runFeed = (st.runFeed + rows).takeLast(RUN_FEED_CAP), runStreamNote = null)
                                }
                            }
                        }
                        is RunStreamEvent.Done -> {
                            if (event.seq > maxSeq) maxSeq = event.seq
                            terminal = event
                        }
                    }
                }
            }
            currentCoroutineContext().ensureActive() // a cancelled collect must not fall into retry
            val done = terminal
            when {
                done != null && done.status == "stream_timeout" -> Unit // server cap: reopen immediately
                done != null -> {
                    val status = done.status ?: "exited"
                    _uiState.update { st ->
                        st.copy(
                            runFeed = (st.runFeed + RunFeedRow("done", "run-complete", status)).takeLast(RUN_FEED_CAP),
                            selectedRun = st.selectedRun?.takeIf { it.runId == run.runId }?.copy(status = status)
                                ?: st.selectedRun,
                            runStreamNote = null,
                        )
                    }
                    return
                }
                else -> { // connection dropped (or errored) without a terminal frame
                    if (attempt.isFailure) {
                        android.util.Log.w("OrchaApp", "run stream dropped", attempt.exceptionOrNull())
                    }
                    _uiState.update { it.copy(runStreamNote = "Log stream interrupted — reconnecting…") }
                    delay(backoffMs)
                    backoffMs = (backoffMs * 2).coerceAtMost(15_000L)
                }
            }
        }
    }

    /** Classify a finished run's buffered SSE text into feed rows (same seq dedup). */
    private fun feedFromStreamText(text: String): List<RunFeedRow> {
        val rows = mutableListOf<RunFeedRow>()
        var maxSeq = 0
        text.lineSequence().forEach { raw ->
            when (val event = RunStream.parse(raw)) {
                is RunStreamEvent.Line -> if (event.seq > maxSeq) {
                    maxSeq = event.seq
                    rows += RunFeed.classifyLine(event.line)
                }
                is RunStreamEvent.Done -> rows += RunFeedRow("done", "run-complete", event.status ?: "ended")
                null -> Unit
            }
        }
        return rows.takeLast(RUN_FEED_CAP)
    }

    private fun cancelRunStream() {
        runStreamJob?.cancel()
        runStreamJob = null
    }

    fun openConversation(agentId: String) {
        val agent = _uiState.value.snapshot?.agents?.firstOrNull { it.id == agentId } ?: return
        cancelRunStream()
        _uiState.update { it.copy(route = AppRoute.Conversation, selectedAgent = agent, conversation = null, turns = emptyList(), error = null) }
        refreshConversation()
    }

    fun refreshConversation() {
        val selected = _uiState.value.selectedContainer ?: return
        val agent = _uiState.value.selectedAgent ?: return
        viewModelScope.launch {
            // issue 4 (web conversation.js poll): once mounted, refresh via an after_seq
            // DELTA append instead of re-fetching + replacing the whole transcript.
            val conversation = _uiState.value.conversation
            val lastSeq = _uiState.value.turns.lastOrNull()?.seq ?: 0
            if (conversation != null && lastSeq > 0) {
                runCatching { api.getConversationTurns(selected.baseUrl, conversation.id, afterSeq = lastSeq) }
                    .onSuccess { response ->
                        if (response.turns.isNotEmpty()) {
                            _uiState.update { st -> st.copy(turns = Paging.appendTurns(st.turns, response.turns), error = null) }
                        }
                    }
                    .onFailure { err ->
                        _uiState.update { it.copy(error = friendlyConnectionError(err)) }
                    }
                return@launch
            }
            // initial mount fetch (web parity: one ?limit=80 load)
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching { api.getConversation(selected.baseUrl, agent.id) }
                .onSuccess { response ->
                    _uiState.update { it.copy(conversation = response.conversation, turns = response.turns, loading = false) }
                }.onFailure { err ->
                    _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
                }
        }
    }

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
        viewModelScope.launch {
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

    fun escalateSelectedRequest(reason: String?) = runHumanAction("Request escalated") { selected, actor ->
        val request = _uiState.value.selectedRequest ?: error("No request selected")
        api.escalateRequest(selected.baseUrl, request.id, actor, reason)
        refreshSelected()
        showWorkspace()
    }

    fun acceptSelectedTaskRequest(note: String?) = runHumanAction("Task request accepted") { selected, actor ->
        val request = _uiState.value.selectedRequest ?: error("No request selected")
        api.acceptTaskRequest(selected.baseUrl, request.id, actor, note)
        refreshSelected()
        showWorkspace()
    }

    fun rejectSelectedTaskRequest(reason: String) = runHumanAction("Task request rejected") { selected, actor ->
        val request = _uiState.value.selectedRequest ?: error("No request selected")
        api.rejectTaskRequest(selected.baseUrl, request.id, actor, reason)
        refreshSelected()
        showWorkspace()
    }

    fun convertSelectedRequest(title: String, definitionOfDone: String, assigneeAlias: String?, priority: Int) =
        runHumanAction("Request became a task") { selected, actor ->
            val request = _uiState.value.selectedRequest ?: error("No request selected")
            api.convertRequest(selected.baseUrl, request.id, actor, title, definitionOfDone, assigneeAlias, priority)
            refreshSelected()
            showWorkspace()
        }

    fun changeSelectedAgentModel(model: String) = runHumanAction("Model changed") { selected, _ ->
        val agent = _uiState.value.selectedAgent ?: error("No agent selected")
        api.updateAgentModel(selected.baseUrl, agent.id, model)
        refreshSelected()
        refreshAgentDetail()
    }

    fun changeSelectedAgentAutoWake(intervalSecs: Int?) = runHumanAction("Auto-wake updated") { selected, actor ->
        val agent = _uiState.value.selectedAgent ?: error("No agent selected")
        api.updateAutoWake(selected.baseUrl, agent.id, actor, intervalSecs)
        refreshSelected()
    }

    fun retireSelectedAgent() = runHumanAction("Agent retired") { selected, actor ->
        val agent = _uiState.value.selectedAgent ?: error("No agent selected")
        api.retireAgent(selected.baseUrl, agent.id, actor)
        refreshSelected()
        showWorkspace()
    }

    /** GH #148: notifier switch. Never touches autonomy_level — the two controls are orthogonal. */
    fun setWakes(enabled: Boolean) = runHumanAction(if (enabled) "Wakes resumed" else "Wakes paused") { selected, actor ->
        api.setWakes(selected.baseUrl, selected.id, enabled, actor)
        refreshSelected()
    }

    /** GH #148: autonomy gearbox. Never touches wakes_enabled — applies whether running or paused. */
    fun setAutonomy(level: String) = runHumanAction("Autonomy set to $level") { selected, actor ->
        api.setAutonomy(selected.baseUrl, selected.id, level, actor)
        refreshSelected()
    }

    fun sendConversationTurn(content: String) = runHumanAction("Message sent") { selected, actor ->
        val agent = _uiState.value.selectedAgent ?: error("No agent selected")
        val conversation = _uiState.value.conversation ?: api.startConversation(selected.baseUrl, agent.id, actor).conversation
        val conversationId = conversation?.id ?: error("Conversation did not start")
        api.sendConversationTurn(selected.baseUrl, conversationId, actor, content)
        refreshConversation()
    }

    fun endConversation() = runHumanAction("Conversation ended") { selected, actor ->
        val conversation = _uiState.value.conversation ?: return@runHumanAction
        api.endConversation(selected.baseUrl, conversation.id, actor)
        refreshConversation()
    }

    fun createTask(
        title: String,
        description: String?,
        definitionOfDone: String,
        assigneeAlias: String?,
        priority: Int,
        dependsOn: List<String>,
        notReady: Boolean,
    ) = runHumanAction("Task created") { selected, actor ->
        val response = api.createTask(
            selected.baseUrl,
            selected.id,
            title,
            description,
            definitionOfDone,
            actor,
            assigneeAlias,
            priority,
            dependsOn,
            notReady,
        )
        refreshSelected()
        response.taskId?.let { openTask(it) } ?: showWorkspace()
    }

    fun stopSelectedRun() = runHumanAction("Stop requested") { selected, actor ->
        val run = _uiState.value.selectedRun ?: error("No run selected")
        api.stopRun(selected.baseUrl, run.runId, actor)
        refreshRunLog()
    }

    fun forgetContainer(id: String) {
        val containers = store.remove(id)
        _uiState.update {
            it.copy(
                containers = containers,
                selectedContainer = null,
                snapshot = null,
                route = AppRoute.Containers,
            )
        }
    }

    fun forgetSelectedContainer() {
        _uiState.value.selectedContainer?.id?.let(::forgetContainer)
    }

    fun clearToast() {
        _uiState.update { it.copy(toast = null) }
    }

    private fun runHumanAction(success: String, block: suspend (StoredContainer, String) -> Unit) {
        val selected = _uiState.value.selectedContainer ?: return
        val actor = selected.humanAgentId ?: run {
            _uiState.update { it.copy(error = "Pairing is missing the human identity. Reconnect this Orcha first.") }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(actionInFlight = true, error = null) }
            runCatching { block(selected, actor) }
                .onSuccess { _uiState.update { it.copy(actionInFlight = false, toast = success) } }
                .onFailure { err -> _uiState.update { it.copy(actionInFlight = false, error = friendlyConnectionError(err)) } }
        }
    }

    private fun startPolling() {
        pollingJob?.cancel()
        pollingJob = viewModelScope.launch {
            while (true) {
                delay(30_000)
                refreshSelected()
            }
        }
    }

    private fun pairingBaseUrl(raw: String): String {
        val trimmed = raw.trim()
        if (!trimmed.startsWith("{")) return trimmed
        return runCatching {
            val obj = json.parseToJsonElement(trimmed).jsonObject
            val kind = obj["kind"]?.jsonPrimitive?.content
            if (kind != null && kind != "orcha-pair") {
                throw IllegalArgumentException("That QR code is not an Orcha pairing code.")
            }
            obj["baseUrl"]?.jsonPrimitive?.content ?: throw IllegalArgumentException(
                "That pairing code does not include an Orcha address.",
            )
        }.getOrElse { err ->
            if (err is IllegalArgumentException) throw err
            throw IllegalArgumentException("That pairing code could not be read.")
        }
    }

    private fun friendlyConnectionError(err: Throwable? = null): String {
        if (err is IllegalArgumentException && !err.message.isNullOrBlank()) {
            return err.message.orEmpty()
        }
        // A data-shape mismatch (the phone reached Orcha but couldn't read part of the
        // reply) must NOT be dressed up as a Wi-Fi/"reach" failure — that sends the user
        // chasing their network for an app-side problem. Keep the word "reach" out of this
        // copy so the connect screen shows a plain banner, not the unreachable checklist.
        if (isDataShapeError(err)) {
            return "This app version couldn't read part of Orcha's reply. Your laptop and network are fine — update the app to the latest version."
        }
        val message = err?.message.orEmpty()
        return when {
            message.contains("403") -> "This action is not allowed for the paired human."
            message.contains("409") -> "Orcha rejected this action because the item changed. Refresh and try again."
            message.contains("422") -> "Orcha needs more information for this action."
            message.isNotBlank() && message.length < 140 -> message
            else -> "Could not reach Orcha at this address. Check that Orcha is running and your phone is on the same Wi-Fi."
        }
    }

    /**
     * True when the failure is a JSON deserialization / content-negotiation error — i.e. the
     * phone talked to Orcha but the reply didn't match the app's models. Walk the cause chain
     * because Ktor wraps the underlying kotlinx serialization error in a convert exception.
     */
    private fun isDataShapeError(err: Throwable?): Boolean {
        var cause: Throwable? = err
        while (cause != null) {
            val name = cause::class.qualifiedName ?: cause::class.java.name
            if (name.contains("Serialization") || name.contains("JsonConvert") ||
                name.contains("JsonDecoding") || name.contains("ContentConvert")
            ) {
                return true
            }
            cause = cause.cause
        }
        return false
    }

    private fun messageKey(message: TaskMessageDto): Any =
        message.messageId ?: "${message.createdAt}-${message.body.hashCode()}"

    companion object {
        /** Web-parity retained-line cap for the run feed (app.js:1284). */
        private const val RUN_FEED_CAP = 400

        /** Slim snapshot window for the home-card probes (issue 4). */
        private const val PROBE_LIMIT = 50
    }
}
