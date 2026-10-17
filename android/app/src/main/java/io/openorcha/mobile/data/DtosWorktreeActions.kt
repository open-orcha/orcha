package io.openorcha.mobile.data

/* Agent worktree actions — `POST …/agent-worktrees/actions` and `GET …/actions/{aid}`
   (iOS `WorktreeActionDto`). Every field defaults so a newer server never breaks decoding. */

import kotlinx.serialization.Serializable

@Serializable
data class WorktreeActionDto(
    val id: String,
    val action: String? = null,
    /** `requested` | `claimed` | `done` | `failed` */
    val status: String = "requested",
    val error: String? = null,
) {
    val pending: Boolean get() = status == "requested" || status == "claimed"
}
