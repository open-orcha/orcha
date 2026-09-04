package io.openorcha.mobile.data

/**
 * GitHub hub API surface (cloud PRs #94 + #95) — Android parity of the iOS
 * `OrchaApiClient+GitHubHub.swift` / `GitHubHub.swift`. Reads ride the same
 * `available:false` clean-error contract as the rest of Orcha's read endpoints
 * (every failure is a 200 with `available:false`, never a 5xx), so these calls
 * only throw on transport / auth-perimeter / non-2xx. All DTOs use kotlinx
 * defaults for every field so an older self-host server (missing keys) degrades
 * gracefully instead of throwing a deserialization error.
 */

import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.Serializable

// ---------- checks rollup (shared list + detail) ----------

/** The four-count checks summary ("n passed / failing / pending" of total). */
@Serializable
data class GitHubChecks(
    val passed: Int = 0,
    val failing: Int = 0,
    val pending: Int = 0,
    val total: Int = 0,
    /** Per-run breakdown — detail-only (the list endpoint omits `runs`). */
    val runs: List<GitHubCheckRun> = emptyList(),
)

/** One check run in the detail breakdown (legacy commit statuses normalized server-side). */
@Serializable
data class GitHubCheckRun(
    val name: String = "",
    /** "completed" | "queued" | "in_progress" (GitHub's raw value). */
    val status: String = "",
    /** "success" | "failure" | … | null (only set once status == "completed"). */
    val conclusion: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
)

// ---------- list rows ----------

/**
 * One issue/PR label. The server moved from plain name strings to `{name, color}`
 * (GitHub's own label hex, no leading '#') so the UI can render real repo colors —
 * this serializer accepts BOTH shapes, so the app never again breaks on the change
 * (the "couldn't read part of Orcha's reply" Issues-tab failure).
 */
@Serializable(with = GitHubLabelSerializer::class)
data class GitHubLabel(val name: String, val color: String? = null)

object GitHubLabelSerializer : KSerializer<GitHubLabel> {
    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("io.openorcha.mobile.data.GitHubLabel")

    override fun deserialize(decoder: Decoder): GitHubLabel {
        val input = decoder as? JsonDecoder ?: error("GitHubLabel decodes from JSON only")
        return when (val el = input.decodeJsonElement()) {
            is JsonPrimitive -> GitHubLabel(el.content)
            is JsonObject -> GitHubLabel(
                // contentOrNull: JsonNull is a JsonPrimitive whose content is the
                // string "null" — .content would turn a null color into "null".
                name = (el["name"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                color = (el["color"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() },
            )
            else -> GitHubLabel("")
        }
    }

    override fun serialize(encoder: Encoder, value: GitHubLabel) =
        encoder.encodeString(value.name)
}

/** `GET …/github/issues` → one open issue row. */
@Serializable
data class GitHubIssueRow(
    val number: Int,
    val title: String = "",
    val labels: List<GitHubLabel> = emptyList(),
    /** Primary assignee login, or null. */
    val assignee: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
    /** First ~200 chars of the body. */
    @SerialName("body_excerpt") val bodyExcerpt: String? = null,
)

/** `GET …/github/pulls` → one open PR row. `head`/`base`/`checks`/`requestedReviewers`
 *  are nullable (rather than defaulting to empty) because a search-sourced row (author /
 *  involvement / q filters hitting GitHub's search API) genuinely LACKS these — GitHub
 *  search results don't carry them — and the UI must hide those chips rather than render
 *  a false "no checks" / "no reviewers" state. A plain list-sourced row always has them. */
@Serializable
data class GitHubPullRow(
    val number: Int,
    val title: String = "",
    val head: String? = null,
    val base: String? = null,
    val draft: Boolean = false,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
    @SerialName("requested_reviewers") val requestedReviewers: List<String>? = null,
    val checks: GitHubChecks? = null,
    /** GitHub's raw `mergeable_state` ("clean" | "dirty" | "blocked" | …) or null. */
    @SerialName("mergeable_state") val mergeableState: String? = null,
    /** The PR author's login — present on both list and search-sourced rows; used by the
     *  author filter's local echo / row display. */
    @SerialName("author_login") val authorLogin: String? = null,
)

/** `GET …/github/checks?numbers=1,2,3` — the PR list's progressive-fill follow-up. The
 *  list route deliberately ships `checks: null` on every row (one GitHub call per PR is
 *  too slow inline — the server's lazy split), and this batch call fills them in. Keys
 *  are PR numbers as strings (JSON object keys); a number the server couldn't resolve
 *  (e.g. a search-sourced row outside its open-PR cache) is simply absent. */
@Serializable
data class GitHubChecksBatchResponse(
    val available: Boolean = false,
    val reason: String? = null,
    val detail: String? = null,
    val checks: Map<String, GitHubChecks> = emptyMap(),
)

// ---------- list responses (the `available:false` clean-error contract) ----------

@Serializable
data class GitHubIssuesResponse(
    val available: Boolean = false,
    val repo: String? = null,
    val reason: String? = null,
    val detail: String? = null,
    val issues: List<GitHubIssueRow> = emptyList(),
)

/** `GET …/github/pulls` — the filter/pagination superset (author, involvement, q, page).
 *  `source` distinguishes the plain list from a GitHub search-API result, whose rows may
 *  omit `head`/`checks`/`requested_reviewers` (search doesn't carry them) — DTOs below
 *  default those fields so a search-sourced row degrades instead of failing to decode.
 *  `total_count` is nullable (GitHub search doesn't always report an exact count); when
 *  absent the UI shows "N so far" instead of "N of ~total". The row list itself decodes
 *  under `items` (the frozen filter/pagination contract's key) — [pulls] also tolerates
 *  the pre-filter server's `pulls` key so a not-yet-upgraded self-host still decodes. */
@Serializable
data class GitHubPullsResponse(
    val available: Boolean = false,
    val repo: String? = null,
    val reason: String? = null,
    val detail: String? = null,
    /** "list" (repo pulls) | "search" (author/involvement/q hit the search API), or null
     *  on an older server that doesn't report it. */
    val source: String? = null,
    val items: List<GitHubPullRow> = emptyList(),
    @SerialName("pulls") private val pullsLegacy: List<GitHubPullRow> = emptyList(),
    val page: Int = 1,
    @SerialName("per_page") val perPage: Int = 30,
    @SerialName("total_count") val totalCount: Int? = null,
    @SerialName("has_more") val hasMore: Boolean = false,
) {
    /** Unified row access regardless of which key the server used. */
    val pulls: List<GitHubPullRow> get() = if (items.isNotEmpty()) items else pullsLegacy
}

// ---------- detail models ----------

/** One changed file in a PR. `patch` carries the unified diff hunk text when the
 *  server includes it (cloud PR #95 files-with-patch contract) — Android's diff
 *  viewer goes beyond iOS here (#177 gap): iOS drops patches server-side, but this
 *  DTO tolerates their absence just as gracefully (null → "no diff available"). */
@Serializable
data class GitHubChangedFile(
    val filename: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
    /** "added" | "modified" | "removed" | "renamed". */
    val status: String = "",
    /** Unified-diff hunk text for this file, when the server provides it. */
    val patch: String? = null,
    /** iOS parity: true when the server deliberately dropped an oversized patch —
     *  distinguishes "too large to show" from "not available from this server yet". */
    @SerialName("patch_omitted") val patchOmitted: Boolean = false,
)

/** The `files` block on a PR detail: GitHub's honest `count`, the first-100 `items`,
 *  and `truncated:true` (present only when `count > items.count`; absent ⇒ false). */
@Serializable
data class GitHubFiles(
    val count: Int = 0,
    val items: List<GitHubChangedFile> = emptyList(),
    val truncated: Boolean = false,
)

/** `GET …/github/pulls/{number}` → the full PR. */
@Serializable
data class GitHubPullDetail(
    val number: Int,
    val title: String = "",
    val state: String = "open",
    val draft: Boolean = false,
    /** RAW markdown — render client-side (never html-rendered server-side). */
    @SerialName("body_markdown") val bodyMarkdown: String = "",
    @SerialName("author_login") val authorLogin: String? = null,
    val base: String = "",
    val head: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
    @SerialName("mergeable_state") val mergeableState: String? = null,
    val assignees: List<String> = emptyList(),
    @SerialName("requested_reviewers") val requestedReviewers: List<String> = emptyList(),
    val checks: GitHubChecks = GitHubChecks(),
    val files: GitHubFiles = GitHubFiles(),
    @SerialName("comments_count") val commentsCount: Int = 0,
    @SerialName("review_comments_count") val reviewCommentsCount: Int = 0,
)

/** One comment in an issue thread (most-recent 20, oldest-first). */
@Serializable
data class GitHubComment(
    @SerialName("author_login") val authorLogin: String? = null,
    /** RAW markdown — render client-side. */
    @SerialName("body_markdown") val bodyMarkdown: String = "",
    @SerialName("created_at") val createdAt: String? = null,
)

/** `GET …/github/issues/{number}` → the full issue. */
@Serializable
data class GitHubIssueDetail(
    val number: Int,
    val title: String = "",
    val state: String = "open",
    /** RAW markdown — render client-side. */
    @SerialName("body_markdown") val bodyMarkdown: String = "",
    @SerialName("author_login") val authorLogin: String? = null,
    val labels: List<GitHubLabel> = emptyList(),
    val assignee: String? = null,
    val assignees: List<String> = emptyList(),
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
    @SerialName("comments_count") val commentsCount: Int = 0,
    /** Most-recent 20, oldest-first. */
    val comments: List<GitHubComment> = emptyList(),
)

/** Detail envelopes: `available:true` carries the item; `available:false` carries
 *  the reason (`not_found` | `rate_limited` | `repo_not_connected` | …). */
@Serializable
data class GitHubPullDetailResponse(
    val available: Boolean = false,
    val repo: String? = null,
    val reason: String? = null,
    val detail: String? = null,
    val pull: GitHubPullDetail? = null,
)

@Serializable
data class GitHubIssueDetailResponse(
    val available: Boolean = false,
    val repo: String? = null,
    val reason: String? = null,
    val detail: String? = null,
    val issue: GitHubIssueDetail? = null,
)

// ---------- POST /start ----------

/** `POST …/github/start` request body. Null optionals are dropped by the wire JSON's
 *  `explicitNulls = false`, so an older server never sees a key it doesn't read. */
@Serializable
data class GitHubStartBody(
    val kind: String,
    val number: Int,
    val title: String? = null,
    @SerialName("body_excerpt") val bodyExcerpt: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
    @SerialName("assignee_agent_id") val assigneeAgentId: String? = null,
    @SerialName("created_by_agent_id") val createdByAgentId: String? = null,
)

/** `POST …/github/start` → the created (or already-tracked) task. */
@Serializable
data class GitHubStartResponse(
    @SerialName("task_id") val taskId: String,
    /** true ⇒ an OPEN `GH #N:` task already existed (idempotent, no duplicate). */
    val existing: Boolean = false,
)

/** GitHub hub reads + the one write (start), added to [OrchaApiClient] mirroring the
 *  iOS `OrchaApiClient+GitHubHub.swift` split. Defined here (not in OrchaApiClient.kt)
 *  to keep the GitHub hub surface self-contained, matching the split BUILD instructions.
 *  `client`/`transport` are `internal` on [OrchaApiClient] precisely so this same-package
 *  extension file can reach them without a public passthrough. */
suspend fun OrchaApiClient.githubIssues(baseUrl: String, containerId: String): GitHubIssuesResponse =
    withTimeout(8_000) { client.get("${baseUrl.endpoint()}/api/containers/$containerId/github/issues").body() }

/** `GET …/github/pulls?author=&involvement=&q=&page=&per_page=` — the filtered,
 *  paginated PR list. All params are optional; omitted ones are left off the query
 *  string entirely (never sent as an empty/blank value) so an older server that
 *  ignores unknown query params behaves exactly as it did pre-filter. `involvement`
 *  is server-resolved "me" (assigned | review_requested) — the server, not this client,
 *  maps it onto the caller's identity. */
suspend fun OrchaApiClient.githubPulls(
    baseUrl: String,
    containerId: String,
    author: String? = null,
    involvement: String? = null,
    q: String? = null,
    page: Int = 1,
    perPage: Int = 30,
): GitHubPullsResponse = withTimeout(8_000) {
    val params = listOfNotNull(
        author?.takeIf { it.isNotBlank() }?.let { "author=${it.encodeURLParameter()}" },
        involvement?.takeIf { it.isNotBlank() }?.let { "involvement=${it.encodeURLParameter()}" },
        q?.takeIf { it.isNotBlank() }?.let { "q=${it.encodeURLParameter()}" },
        if (page != 1) "page=$page" else null,
        if (perPage != 30) "per_page=$perPage" else null,
    ).joinToString("&").let { if (it.isEmpty()) "" else "?$it" }
    client.get("${baseUrl.endpoint()}/api/containers/$containerId/github/pulls$params").body()
}

/** `GET …/github/checks?numbers=` — see [GitHubChecksBatchResponse]. Callers split
 *  through [io.openorcha.mobile.domain.GitHubHubUx.checksBatches]: the server caps one
 *  call at 30 numbers. */
suspend fun OrchaApiClient.githubChecks(baseUrl: String, containerId: String, numbers: List<Int>): GitHubChecksBatchResponse =
    withTimeout(8_000) {
        val joined = numbers.joinToString(",").encodeURLParameter()
        client.get("${baseUrl.endpoint()}/api/containers/$containerId/github/checks?numbers=$joined").body()
    }

suspend fun OrchaApiClient.githubIssueDetail(baseUrl: String, containerId: String, number: Int): GitHubIssueDetailResponse =
    withTimeout(8_000) { client.get("${baseUrl.endpoint()}/api/containers/$containerId/github/issues/$number").body() }

suspend fun OrchaApiClient.githubPullDetail(baseUrl: String, containerId: String, number: Int): GitHubPullDetailResponse =
    withTimeout(8_000) { client.get("${baseUrl.endpoint()}/api/containers/$containerId/github/pulls/$number").body() }

/** `POST …/github/start` — create (or return the already-tracked) task for a GitHub
 *  item. `assigneeAgentId` (a live AI agent) → assigned + wake; null → an unassigned
 *  `ready` task. `createdByAgentId` is the acting human (the task's creator). */
suspend fun OrchaApiClient.startGithubItem(
    baseUrl: String,
    containerId: String,
    kind: String,
    number: Int,
    title: String? = null,
    bodyExcerpt: String? = null,
    htmlUrl: String? = null,
    assigneeAgentId: String? = null,
    createdByAgentId: String? = null,
): GitHubStartResponse = transport.post(
    "${baseUrl.endpoint()}/api/containers/$containerId/github/start",
    GitHubStartBody(
        kind = kind, number = number,
        title = title, bodyExcerpt = bodyExcerpt, htmlUrl = htmlUrl,
        assigneeAgentId = assigneeAgentId, createdByAgentId = createdByAgentId,
    ),
)
