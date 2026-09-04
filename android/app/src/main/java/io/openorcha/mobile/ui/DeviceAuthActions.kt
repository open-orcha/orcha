package io.openorcha.mobile.ui

/**
 * GitHub device-token sign-in (cloud unification), Android parity of iOS
 * `AppModel.swift`'s pairing + `signInWithGitHub()` section. The primary way through
 * a deployment's auth perimeter: launch `<base>/auth/device` in a Custom Tab, let
 * the authenticated portal page mint a per-device token and redirect back to
 * `orcha://auth/callback?host&token`, then retry the captured pairing draft with
 * it -- the existing `connectManual` path persists the token per container and
 * refreshes [io.openorcha.mobile.data.BearerTokens].
 */

import android.content.Context
import io.openorcha.mobile.data.BearerTokens
import io.openorcha.mobile.domain.DeviceAuth
import io.openorcha.mobile.domain.DeviceAuthFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface DeviceAuthActions : OrchaViewModelAccess {

    /**
     * Fresh flow per presentation of the sign-in sheet. Also clears the bounce
     * message that got the user here — the sheet opens with its own explainer, so
     * any error that appears afterwards is a fresh one.
     */
    fun resetDeviceAuth() {
        _uiState.update { it.copy(deviceAuth = DeviceAuthFlow(), error = null) }
    }

    /**
     * The primary way through the auth perimeter (QR/manual address -> GitHub
     * OAuth -> device token): run `<base>/auth/device` in a Custom Tab, wait for
     * the `orcha://auth/callback` intent, then retry the captured pairing draft
     * with the minted token. The existing `connectManual` path persists the token
     * per container and rebuilds [BearerTokens]. Call from a `viewModelScope`
     * coroutine since it suspends for the whole browser round-trip.
     */
    fun signInWithGitHub(context: Context) {
        // The manual sheet can start a sign-in without the sheet's onAppear reset —
        // never let a stale terminal phase eat the events.
        if (_uiState.value.deviceAuth.phase is DeviceAuthFlow.Phase.Connected) {
            _uiState.update { it.copy(deviceAuth = DeviceAuthFlow()) }
        }
        _uiState.update { it.copy(deviceAuth = it.deviceAuth.handle(DeviceAuthFlow.Event.SignInTapped)) }

        val draft = _uiState.value.connectDraft
        val base = draft?.let { runCatching { pairingBaseUrl(it) }.getOrNull() }
        val startUrl = base?.let { DeviceAuth.startUrl(it) }
        if (draft == null || base == null || startUrl == null) {
            _uiState.update {
                it.copy(
                    deviceAuth = it.deviceAuth.handle(
                        DeviceAuthFlow.Event.RetryFailed(
                            "The pairing address went missing — close this and scan the portal's QR again.",
                        ),
                    ),
                )
            }
            return
        }

        scope.launch {
            val callbackUri = runCatching { deviceAuthSession.authenticate(context, startUrl) }
                .getOrElse {
                    // The user closed the Custom Tab — or the server showed its own
                    // error page and never redirected, which ends the round-trip the
                    // same way. Either way: back to the options, no banner.
                    _uiState.update { st -> st.copy(deviceAuth = st.deviceAuth.handle(DeviceAuthFlow.Event.Cancelled)) }
                    return@launch
                }

            val callback = DeviceAuth.parseCallback(callbackUri.toString())
            if (callback == null || !DeviceAuth.callbackMatchesBase(callback, base)) {
                _uiState.update { st -> st.copy(deviceAuth = st.deviceAuth.handle(DeviceAuthFlow.Event.InvalidCallback)) }
                return@launch
            }
            _uiState.update { it.copy(deviceAuth = it.deviceAuth.handle(DeviceAuthFlow.Event.CallbackReceived)) }

            val connected = connectWithToken(draft, callback.token)
            if (connected) {
                _uiState.update {
                    it.copy(
                        deviceAuth = it.deviceAuth.handle(DeviceAuthFlow.Event.RetrySucceeded),
                        // Visible even for a Settings-triggered "Sign in again", which has
                        // no phase-driven sign-in panel of its own to show Connected in.
                        toast = "Signed in",
                    )
                }
            } else {
                val message = if (_uiState.value.connectNeedsToken) {
                    "That sign-in wasn't accepted. Try again, or use an access token instead."
                } else {
                    _uiState.value.error ?: "Connecting with the new sign-in didn't work. Try again."
                }
                _uiState.update { it.copy(deviceAuth = it.deviceAuth.handle(DeviceAuthFlow.Event.RetryFailed(message))) }
            }
        }
    }

    /** The Custom Tab intercepted the redirect but the user backed out instead. */
    fun cancelDeviceAuthSignIn() {
        deviceAuthSession.cancel()
    }

    /**
     * Settings "Sign in again" for an already-paired container whose token expired
     * or was revoked: prime `connectDraft` with its stored address so
     * [signInWithGitHub] has a pairing target, then the caller launches the sign-in
     * itself (the Custom Tab needs an Activity `Context`, which this module doesn't
     * have — `MainActivity` calls this immediately before `signInWithGitHub`).
     */
    fun beginSignInAgain(containerId: String) {
        val container = _uiState.value.containers.firstOrNull { it.id == containerId } ?: return
        _uiState.update { it.copy(connectDraft = container.baseUrl, deviceAuth = DeviceAuthFlow(), error = null) }
    }

    /**
     * Connect (or reconnect) [rawBaseUrl] with an explicit bearer token — the
     * device-token retry path, and the Settings/manual-entry "paste a token"
     * fallback. Shares `connectManual`'s probe-then-pair body via [connectWithToken]
     * so both paths persist the token identically.
     */
    fun connectWithAccessToken(rawBaseUrl: String, accessToken: String) {
        scope.launch { connectWithToken(rawBaseUrl, accessToken) }
    }

    /**
     * Settings "Sign in again" / manual token update (mirrors the remote-address
     * dialog pattern in `SettingsScreen.kt`'s `AddRemoteDialog`): set or clear one
     * ALREADY-PAIRED container's stored token directly, without a fresh probe --
     * the next request just starts carrying (or dropping) the bearer header.
     */
    fun setContainerAccessToken(id: String, token: String?) {
        val containers = store.setAccessToken(id, token)
        val updated = containers.firstOrNull { it.id == id }
        if (updated != null) {
            BearerTokens.set(updated.baseUrl, updated.accessToken)
            updated.remoteBaseUrl?.let { BearerTokens.set(it, updated.accessToken) }
        }
        _uiState.update { st ->
            st.copy(
                containers = containers,
                selectedContainer = st.selectedContainer?.let { sel ->
                    if (sel.id == id) containers.firstOrNull { it.id == id } ?: sel else sel
                },
            )
        }
    }
}
