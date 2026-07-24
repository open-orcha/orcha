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

override fun friendlyConnectionError(err: Throwable?): String {
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

override fun messageKey(message: TaskMessageDto): Any =
    message.messageId ?: "${message.createdAt}-${message.body.hashCode()}"

}
