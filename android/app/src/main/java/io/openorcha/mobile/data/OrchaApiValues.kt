package io.openorcha.mobile.data

import io.ktor.client.plugins.ResponseException
import io.ktor.http.HttpStatusCode

/** Normalizes addresses and optional text consistently across API operations. */
internal fun String.endpoint(): String = OrchaServerAddress.normalize(this)

internal fun String?.blankToNull(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

/**
 * True when [err] is the auth perimeter's 401, distinguishing "reachable, sign-in
 * required" from a genuine network failure. Portal-level errors (403 authority,
 * 404, 409, 422) are real Ktor `ResponseException`s too but never carry status 401,
 * so they pass through unaffected.
 */
internal fun isAuthRequired(err: Throwable?): Boolean =
    err is OrchaAuthRequiredException ||
        (err is ResponseException && err.response.status == HttpStatusCode.Unauthorized)
