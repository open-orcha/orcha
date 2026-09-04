package io.openorcha.mobile.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException

/**
 * Bridges the GitHub sign-in Custom Tab round-trip into a single suspend call --
 * Android's answer to iOS's `WebAuthSession` (`ASWebAuthenticationSession` hands the
 * callback URL straight back to its caller; a Custom Tab instead delivers it as a
 * fresh `Intent` on `MainActivity`, routed here through [onCallback]).
 *
 * One call in ([authenticate]), one callback URI back. Only ever one round-trip in
 * flight: starting a new one cancels whatever the previous one was still waiting
 * for, matching `WebAuthSession`'s "never two browser sheets" contract.
 */
class DeviceAuthSession {
    private var pending: CompletableDeferred<Uri>? = null

    /**
     * Launch `startUrl` in a Custom Tab and suspend until [onCallback] delivers the
     * `orcha://auth/callback` URI, or [cancel] is called (the user backed out of
     * the tab without ever reaching the redirect -- `MainActivity` has no reliable
     * "tab was dismissed" signal, so the caller times this out or the flow's own
     * UI offers a way back to `cancel()`).
     */
    suspend fun authenticate(context: Context, startUrl: String): Uri {
        pending?.cancel()
        val deferred = CompletableDeferred<Uri>()
        pending = deferred
        val intent = CustomTabsIntent.Builder().build()
        intent.launchUrl(context, Uri.parse(startUrl))
        try {
            return deferred.await()
        } finally {
            if (pending === deferred) pending = null
        }
    }

    /** `MainActivity.onNewIntent` forwards any `orcha://auth/...` intent here. */
    fun onCallback(uri: Uri) {
        pending?.complete(uri)
    }

    /** The user backed out of the Custom Tab without a redirect ever arriving. */
    fun cancel() {
        pending?.cancel(CancellationException("Sign-in cancelled"))
    }

    companion object {
        /** True for any `orcha://auth/...` intent -- see `DeviceAuth.isAuthCallback`. */
        fun isAuthCallbackIntent(intent: Intent?): Boolean {
            val uri = intent?.data ?: return false
            return uri.scheme?.lowercase() == "orcha" && uri.host?.lowercase() == "auth"
        }
    }
}
