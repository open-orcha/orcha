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
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.TurnDto
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
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
    val taskRuns: List<RunDto> = emptyList(),
    val selectedRequest: RequestDto? = null,
    val selectedAgent: AgentDto? = null,
    val agentRuns: List<RunDto> = emptyList(),
    val selectedRun: RunDto? = null,
    val runLines: List<String> = emptyList(),
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
                val health = runCatching { api.getSnapshot(stored.baseUrl, stored.id) }
                    .map { snap ->
                        val needs = io.openorcha.mobile.domain.OrchaSelectors.needsYou(snap).total
                        ContainerHealth("polling", snap.agents.size, snap.tasks.size, needs)
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
        _uiState.update {
            it.copy(
                route = AppRoute.Workspace,
                selectedTask = null,
                selectedRequest = null,
                selectedAgent = null,
                selectedRun = null,
                taskMessages = emptyList(),
                taskRuns = emptyList(),
                agentRuns = emptyList(),
                runLines = emptyList(),
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
        _uiState.update { it.copy(route = AppRoute.TaskDetail, selectedTask = task, taskMessages = emptyList(), taskRuns = emptyList(), error = null) }
        refreshSelectedTask()
    }

    fun refreshSelectedTask() {
        val selected = _uiState.value.selectedContainer ?: return
        val task = _uiState.value.selectedTask ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching {
                val messages = api.getTaskMessages(selected.baseUrl, task.id).messages
                val runs = api.getTaskRuns(selected.baseUrl, task.id).runs
                messages to runs
            }.onSuccess { (messages, runs) ->
                _uiState.update { it.copy(taskMessages = messages, taskRuns = runs, loading = false) }
            }.onFailure { err ->
                _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    fun openRequest(requestId: String) {
        val request = _uiState.value.snapshot?.requests?.firstOrNull { it.id == requestId } ?: return
        _uiState.update { it.copy(route = AppRoute.RequestDetail, selectedRequest = request, error = null) }
    }

    fun openAgent(agentId: String) {
        val agent = _uiState.value.snapshot?.agents?.firstOrNull { it.id == agentId } ?: return
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

    /** Flow 07: human triage-close for stale requests (neither requester nor target). */
    fun triageCloseSelectedRequest() = runHumanAction("Request closed (triage)") { selected, _ ->
        val request = _uiState.value.selectedRequest ?: error("No request selected")
        api.triageCloseRequest(selected.baseUrl, request.id)
        refreshSelected()
        showWorkspace()
    }

    /** Flow 09: rename an agent (overflow → Details). PARTIAL update, human-gated. */
    fun renameSelectedAgent(alias: String) = runHumanAction("Agent renamed") { selected, actor ->
        val agent = _uiState.value.selectedAgent ?: error("No agent selected")
        api.updateAgent(selected.baseUrl, agent.id, actor, alias, null)
        refreshSelected()
    }

    fun openRun(run: RunDto) {
        _uiState.update { it.copy(route = AppRoute.RunDetail, selectedRun = run, runLines = emptyList(), error = null) }
        refreshRunLog()
    }

    fun refreshRunLog() {
        val selected = _uiState.value.selectedContainer ?: return
        val run = _uiState.value.selectedRun ?: return
        val agentId = run.agentId ?: _uiState.value.selectedAgent?.id ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, error = null) }
            runCatching {
                parseSseLines(api.getRunStreamText(selected.baseUrl, agentId, run.runId))
            }.onSuccess { lines ->
                _uiState.update { it.copy(runLines = lines, loading = false) }
            }.onFailure { err ->
                _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    fun openConversation(agentId: String) {
        val agent = _uiState.value.snapshot?.agents?.firstOrNull { it.id == agentId } ?: return
        _uiState.update { it.copy(route = AppRoute.Conversation, selectedAgent = agent, conversation = null, turns = emptyList(), error = null) }
        refreshConversation()
    }

    fun refreshConversation() {
        val selected = _uiState.value.selectedContainer ?: return
        val agent = _uiState.value.selectedAgent ?: return
        viewModelScope.launch {
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
        refreshSelectedTask()
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

    fun nudgeSelectedRequest(note: String?) = runHumanAction("Nudge sent") { selected, actor ->
        val request = _uiState.value.selectedRequest ?: error("No request selected")
        api.nudgeRequest(selected.baseUrl, request.id, actor, note)
        refreshSelected()
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

    private fun parseSseLines(text: String): List<String> =
        text.lineSequence()
            .filter { it.startsWith("data:") }
            .mapNotNull { raw ->
                val payload = raw.removePrefix("data:").trim()
                runCatching {
                    val obj = json.parseToJsonElement(payload).jsonObject
                    obj["line"]?.jsonPrimitive?.content ?: obj["status"]?.jsonPrimitive?.content?.let { "run $it" }
                }.getOrNull()
            }
            .toList()

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
        val message = err?.message.orEmpty()
        return when {
            message.contains("403") -> "This action is not allowed for the paired human."
            message.contains("409") -> "Orcha rejected this action because the item changed. Refresh and try again."
            message.contains("422") -> "Orcha needs more information for this action."
            message.isNotBlank() && message.length < 140 -> message
            else -> "Could not reach Orcha at this address. Check that Orcha is running and your phone is on the same Wi-Fi."
        }
    }
}
