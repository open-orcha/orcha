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
import io.openorcha.mobile.domain.ConnectionErrorCopy
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

/** Provides shared action execution, polling, pairing parsing, and error translation. */
internal interface OrchaViewModelSupport : OrchaViewModelAccess {
override fun runHumanAction(success: String, block: suspend (StoredContainer, String) -> Unit) {
    val selected = _uiState.value.selectedContainer ?: return
    val actor = selected.humanAgentId ?: run {
        _uiState.update { it.copy(error = "Pairing is missing the human identity. Reconnect this Orcha first.") }
        return
    }
    scope.launch {
        _uiState.update { it.copy(actionInFlight = true, error = null) }
        runCatching { block(selected, actor) }
            .onSuccess { _uiState.update { it.copy(actionInFlight = false, toast = success) } }
            .onFailure { err -> _uiState.update { it.copy(actionInFlight = false, error = friendlyConnectionError(err)) } }
    }
}

override fun startPolling() {
    pollingJob?.cancel()
    pollingJob = scope.launch {
        while (true) {
            delay(30_000)
            refreshSelected()
        }
    }
}

override fun pairingBaseUrl(raw: String): String {
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

/**
 * The QR's target project (iOS `OrchaServerAddress.Payload.containerId`): a pairing
 * payload is a capability for ONE specific project — connect selects it as primary
 * rather than whatever the portal lists first. Absent for manual entry; tolerant.
 */
override fun pairingContainerId(raw: String): String? = pairingField(raw, "containerId")

/** The QR's paired operator (iOS `Payload.humanAgentId`) — verified against the
 *  snapshot's humans before being trusted; disambiguates multi-human containers. */
override fun pairingHumanAgentId(raw: String): String? = pairingField(raw, "humanAgentId")

private fun pairingField(raw: String, key: String): String? {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("{")) return null
    return runCatching {
        json.parseToJsonElement(trimmed).jsonObject[key]?.jsonPrimitive?.content
    }.getOrNull()?.takeIf { it.isNotBlank() }
}

/**
 * LAN↔remote failover pairing (iOS `OrchaServerAddress.Payload.remoteBaseUrl`): the QR's
 * optional second address (typically a Tailscale name/IP). Tolerant of a malformed value —
 * a bad remote address degrades to LAN-only pairing rather than failing the whole scan.
 */
override fun pairingRemoteUrl(raw: String): String? {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("{")) return null
    val remote = runCatching {
        json.parseToJsonElement(trimmed).jsonObject["remoteBaseUrl"]?.jsonPrimitive?.content
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: return null
    return runCatching { OrchaServerAddress.normalize(remote) }.getOrNull()
}

// Classification/copy-selection itself is pure and lives in
// `domain/ConnectionErrorCopy.kt` so it's directly unit-testable; this just
// exposes it through the `OrchaViewModelAccess` seam.
override fun friendlyConnectionError(err: Throwable?): String = ConnectionErrorCopy.friendly(err)

override fun messageKey(message: TaskMessageDto): Any =
    message.messageId ?: "${message.createdAt}-${message.body.hashCode()}"

}
