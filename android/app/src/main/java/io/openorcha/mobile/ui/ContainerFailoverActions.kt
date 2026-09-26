package io.openorcha.mobile.ui

import io.openorcha.mobile.data.StoredContainer
import kotlinx.coroutines.flow.update

/**
 * LAN↔remote failover (iOS `AppModel.swift` `refresh()` + Settings §6 "Add remote…"
 * parity): a container may carry a second base URL (typically a Tailscale name/IP)
 * that `refreshSelected()` tries when the primary address doesn't answer, swapping
 * it to primary on success — symmetric, so it also swaps back to LAN once that's
 * the reachable one again.
 */
internal interface ContainerFailoverActions : OrchaViewModelAccess {

/** Settings "Add remote…" (iOS §6 parity): set (or clear, null) a container's failover address. */
fun setRemoteUrl(id: String, url: String?) {
    val containers = store.setRemoteUrl(id, url)
    _uiState.update { st ->
        st.copy(
            containers = containers,
            selectedContainer = st.selectedContainer?.let { sel ->
                if (sel.id == id) containers.firstOrNull { it.id == id } ?: sel else sel
            },
        )
    }
}

/**
 * iOS `AppModel.refresh()` failover parity: the active address didn't answer — if a
 * second address is configured, try it and SWAP it to primary on success. Symmetric:
 * this also swaps back to LAN once the remote path is the one that's dead, since the
 * failing address always ends up in `remoteBaseUrl` after a swap.
 */
suspend fun attemptRemoteFailover(selected: StoredContainer, primaryError: Throwable) {
    val remote = selected.remoteBaseUrl
    if (remote.isNullOrBlank()) {
        _uiState.update { it.copy(loading = false, error = friendlyConnectionError(primaryError)) }
        return
    }
    runCatching { api.getSnapshot(remote, selected.id) }
        .onSuccess { snapshot ->
            val swapped = selected.copy(baseUrl = remote, remoteBaseUrl = selected.baseUrl)
            val containers = store.upsert(swapped)
            _uiState.update {
                it.copy(
                    containers = containers,
                    selectedContainer = swapped,
                    snapshot = snapshot,
                    loading = false,
                    error = null,
                    toast = "Connected via $remote",
                )
            }
        }
        .onFailure {
            _uiState.update { it.copy(loading = false, error = friendlyConnectionError(primaryError)) }
        }
}

}
