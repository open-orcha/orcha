package io.openorcha.mobile.domain

/**
 * Pure error-classification/copy-selection for a failed connect/action, split out of
 * `OrchaViewModelSupport.kt` so it's directly unit-testable. iOS parity:
 * `AppModel.friendly(_:)`.
 *
 * Address-neutral by design: the app supports a local self-host address and a
 * deployed cloud/remote portal address equally, so the fallback copy names
 * neither Wi-Fi nor a laptop specifically.
 */
object ConnectionErrorCopy {

    fun friendly(err: Throwable?): String {
        if (err is IllegalArgumentException && !err.message.isNullOrBlank()) {
            return err.message.orEmpty()
        }
        // A data-shape mismatch (the phone reached Orcha but couldn't read part of the
        // reply) must NOT be dressed up as a "reach" failure — that sends the user
        // chasing their network (or, for a cloud address, nothing at all) for an
        // app-side problem. Keep the word "reach" out of this copy so the connect
        // screen shows a plain banner, not the unreachable checklist.
        if (isDataShapeError(err)) {
            return "This app version couldn't read part of Orcha's reply. Your Orcha and network are fine — update the app to the latest version."
        }
        val message = err?.message.orEmpty()
        return when {
            message.contains("403") -> "This action is not allowed for the paired human."
            message.contains("409") -> "Orcha rejected this action because the item changed. Refresh and try again."
            message.contains("422") -> "Orcha needs more information for this action."
            message.isNotBlank() && message.length < 140 -> message
            // Address-neutral, iOS `AppModel.friendly(_:)` parity: this fires for both a
            // local self-host address and a cloud/remote one, so it names neither Wi-Fi
            // nor a laptop specifically.
            else -> "Could not reach Orcha at this address. Check the address and that your Orcha is up."
        }
    }

    /**
     * True when the failure is a JSON deserialization / content-negotiation error — i.e.
     * the phone talked to Orcha but the reply didn't match the app's models. Walk the
     * cause chain because Ktor wraps the underlying kotlinx serialization error in a
     * convert exception.
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
}
