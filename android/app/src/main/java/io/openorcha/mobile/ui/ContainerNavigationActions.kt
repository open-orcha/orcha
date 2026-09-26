package io.openorcha.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.BearerTokens
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.ContainerStore
import io.openorcha.mobile.data.ConversationDto
import io.openorcha.mobile.data.ModelDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.OrchaServerAddress
import io.openorcha.mobile.data.isAuthRequired
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

/** Owns saved-container navigation, probing, connection, and snapshot refresh. */
internal interface ContainerNavigationActions : OrchaViewModelAccess, ContainerFailoverActions {
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

/** Design/skin setting (Settings → Appearance §3): Classic/Swiss/Minimalist, applied instantly. */
fun setSkinMode(skin: io.openorcha.mobile.ui.theme.SkinMode) {
    store.saveSkinMode(skin.storageValue)
    _uiState.update { it.copy(skinMode = skin) }
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
        scope.launch {
            _uiState.update { it.copy(containerHealth = it.containerHealth + (stored.id to (it.containerHealth[stored.id]?.copy(state = "probing") ?: ContainerHealth("probing")))) }
            // issue 4: the home cards need counts only — fetch a slim snapshot window
            // (server orders needs-attention rows first, so needsYou stays accurate)
            // and read totals from task_total/request_total instead of row counts.
            val health = runCatching { api.getSnapshot(stored.baseUrl, stored.id, taskLimit = PROBE_LIMIT, requestLimit = PROBE_LIMIT) }
                .map { snap ->
                    // iOS probeHealth parity: needs-you = undecided plans + tasks
                    // awaiting verification + open requests routed to THIS human (or
                    // unrouted) — not every open request on the box; tasks = the
                    // server's open (non-terminal) total, never the capped row count.
                    val plans = snap.tasks.count { it.status == "in_progress" && it.planMessage != null && it.planDecision == null }
                    val verifs = snap.tasks.count { it.status == "needs_verification" }
                    val reqs = snap.requests.count {
                        it.status == "open" && (it.targetId == stored.humanAgentId || it.targetId == null)
                    }
                    ContainerHealth(
                        "polling", snap.agents.size, snap.taskOpenTotal,
                        needsYou = plans + verifs + reqs,
                        githubRepo = snap.container.githubRepo,
                    )
                }
                .getOrElse { err ->
                    // An auth bounce is not "unreachable" — the box answered; the phone's
                    // token is missing/stale. Rendered as its own chip + card copy.
                    ContainerHealth(if (isAuthRequired(err)) "signin" else "unreachable")
                }
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

/**
 * Flow 03: a scanned QR payload runs through the same parse+probe as manual entry.
 * Device-token auth: a probe that bounces off the perimeter (401) sets
 * `connectNeedsToken` the same way manual entry does, and this screen renders the
 * sign-in state instead of the failure panel.
 */
fun connectScanned(payload: String) {
    _uiState.update { it.copy(route = AppRoute.AddContainer) }
    connectManual(payload)
}

override fun showWorkspace() {
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

/** Search tab (iOS `SearchTabView` parity): the live query, over the selected workspace. */
fun setSearchQuery(query: String) {
    _uiState.update { it.copy(searchQuery = query) }
}

/**
 * Flow 03/04 manual entry. Device-token auth: `accessToken` is the credential a
 * caller already has in hand (a pasted team/device token) -- omit it for a plain
 * probe, which a protected deployment bounces with a 401 that
 * [connectWithToken] turns into `connectNeedsToken`.
 */
fun connectManual(rawBaseUrl: String, accessToken: String? = null) {
    scope.launch { connectWithToken(rawBaseUrl, accessToken) }
}

/**
 * Device-token auth (cloud unification): probe+pair [rawBaseUrl] with an explicit
 * bearer token (or none). One pairing stores EVERY project the token is good for
 * on that box the same way `connectManual` always has -- this container's
 * `accessToken` rides [BearerTokens] for every later request via the Ktor request
 * seam in `OrchaHttpClient.kt`. iOS parity: `AppModel.connect(_:accessToken:)`.
 */
override suspend fun connectWithToken(rawBaseUrl: String, accessToken: String?): Boolean {
    val trimmedToken = accessToken?.trim()?.takeIf { it.isNotEmpty() }
    val baseUrl = try {
        OrchaServerAddress.normalize(pairingBaseUrl(rawBaseUrl))
    } catch (err: IllegalArgumentException) {
        _uiState.update { it.copy(error = err.message ?: friendlyConnectionError(), connectNeedsToken = false) }
        return false
    }
    // LAN↔remote failover pairing: an `orcha-pair` QR may carry a second address
    // (e.g. Tailscale) — tolerant, absent for plain address/manual entry.
    val remoteUrl = pairingRemoteUrl(rawBaseUrl)
    val pairedContainerId = pairingContainerId(rawBaseUrl)
    val pairedHumanId = pairingHumanAgentId(rawBaseUrl)
    _uiState.update { it.copy(connecting = true, error = null, connectNeedsToken = false) }
    val outcome = runCatching {
        val listed = if (trimmedToken != null) {
            api.listContainersWithBearer(baseUrl, trimmedToken).containers
        } else {
            api.listContainers(baseUrl).containers
        }
        if (listed.isEmpty()) error("No Orcha container was found at this address.")
        // The QR is a capability for ONE project (iOS `payload.containerId` parity):
        // select it as primary; manual entry has no id and takes the first. Taking
        // `first()` unconditionally made scanning a second project on the same box
        // a silent no-op — same host, same first container, upsert deduped it away.
        val primary = listed.firstOrNull { it.id == pairedContainerId } ?: listed.first()
        val snapshot = if (trimmedToken != null) {
            api.getSnapshotWithBearer(baseUrl, primary.id, trimmedToken)
        } else {
            api.getSnapshot(baseUrl, primary.id)
        }
        Triple(listed, primary, snapshot)
    }
    return outcome.fold(
        onSuccess = { (listed, primary, snapshot) ->
            // A token-less connect (scan/manual re-pair of an already-authed host)
            // means "no NEW credential", never "clear": set(null) DELETES the host's
            // registry entry, which silently de-authed the app on every re-scan —
            // the next probe went headerless into the perimeter and the container
            // showed "unreachable".
            trimmedToken?.let { token ->
                BearerTokens.set(baseUrl, token)
                remoteUrl?.let { BearerTokens.set(it, token) }
            }
            // Prefer the operator named in the QR (multi-human disambiguation), verified
            // against the snapshot; fall back to the sole human for manual entry.
            val humans = snapshot.agents.filter { it.kind == "human" }
            val human = humans.firstOrNull { it.id == pairedHumanId } ?: humans.singleOrNull()
            // One pairing stores EVERY project the portal lists (iOS `for dto in listed`
            // parity — "Every project on a paired Orcha appears here automatically"),
            // preserving local edits (rename, remote, resolved human) on re-pair.
            // Primary upserts last so it sorts to the top of the containers list.
            val existingById = _uiState.value.containers.associateBy { it.id }
            var containers = _uiState.value.containers
            var primaryStored: StoredContainer? = null
            for (dto in listed.sortedBy { it.id == primary.id }) {
                val prev = existingById[dto.id]
                val isPrimary = dto.id == primary.id
                val stored = StoredContainer(
                    id = dto.id,
                    displayName = prev?.displayName ?: dto.name,
                    baseUrl = baseUrl,
                    humanAgentId = if (isPrimary) human?.id else prev?.humanAgentId,
                    humanAlias = if (isPrimary) human?.alias else prev?.humanAlias,
                    lastOpenedAt = if (isPrimary) System.currentTimeMillis()
                        else prev?.lastOpenedAt ?: System.currentTimeMillis(),
                    remoteBaseUrl = remoteUrl ?: prev?.remoteBaseUrl,
                    accessToken = trimmedToken ?: prev?.accessToken,
                )
                containers = store.upsert(stored)
                if (isPrimary) primaryStored = stored
            }
            _uiState.update {
                it.copy(
                    containers = containers,
                    selectedContainer = primaryStored,
                    snapshot = snapshot,
                    route = AppRoute.Workspace,
                    connecting = false,
                    connectNeedsToken = false,
                    connectDraft = null,
                    selectedTab = WorkspaceTab.Home,
                )
            }
            startPolling()
            true
        },
        onFailure = { err ->
            if (isAuthRequired(err)) {
                // Item-1 UX: scan/enter -> token prompt only when the perimeter asks.
                _uiState.update {
                    it.copy(
                        connecting = false,
                        connectNeedsToken = true,
                        connectDraft = rawBaseUrl,
                        error = if (trimmedToken == null) {
                            "This Orcha is protected — sign in with GitHub or enter its access token to connect."
                        } else {
                            "That access token wasn't accepted. Check it and try again."
                        },
                    )
                }
            } else {
                android.util.Log.w("OrchaApp", "connect failed", err)
                _uiState.update { it.copy(connecting = false, error = friendlyConnectionError(err)) }
            }
            false
        },
    )
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

override fun refreshSelected() {
    val selected = _uiState.value.selectedContainer ?: return
    scope.launch {
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
            attemptRemoteFailover(selected, err)
        }
    }
}

}
