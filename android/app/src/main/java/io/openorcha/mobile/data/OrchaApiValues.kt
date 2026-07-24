package io.openorcha.mobile.data

/** Normalizes addresses and optional text consistently across API operations. */
internal fun String.endpoint(): String = OrchaServerAddress.normalize(this)

internal fun String?.blankToNull(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
