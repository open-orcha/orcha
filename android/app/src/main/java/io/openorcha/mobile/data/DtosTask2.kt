package io.openorcha.mobile.data

/**
 * Task deliverables (web P2): the non-code files a task produced — reports, tables,
 * images, PDFs — with a version history. Mirrors `portal_backend/deliverables_routes.py`
 * and the web `pages/tasks/deliverables/api.ts`. Every field defaults so an older or
 * partial payload still decodes.
 */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** One stored version. `raw_url` / `text_url` are server-relative paths. */
@Serializable
data class DeliverableVersionDto(
    val version: Int = 0,
    /** run_output | attached */
    val source: String = "attached",
    @SerialName("run_id") val runId: String? = null,
    @SerialName("author_agent_id") val authorAgentId: String? = null,
    @SerialName("author_alias") val authorAlias: String? = null,
    @SerialName("author_kind") val authorKind: String? = null,
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    val sha256: String = "",
    @SerialName("content_type") val contentType: String = "",
    val note: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("raw_url") val rawUrl: String = "",
    @SerialName("text_url") val textUrl: String? = null,
)

@Serializable
data class DeliverableDto(
    val id: String = "",
    @SerialName("task_id") val taskId: String = "",
    val path: String = "",
    val name: String = "",
    /** markdown | text | csv | json | pdf | image */
    val kind: String = "text",
    @SerialName("latest_version") val latestVersion: Int = 0,
    @SerialName("version_count") val versionCount: Int = 0,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val latest: DeliverableVersionDto? = null,
    /** only on the detail endpoint, newest first */
    val versions: List<DeliverableVersionDto>? = null,
)

@Serializable
data class DeliverableLimitsDto(
    @SerialName("max_bytes") val maxBytes: Long = 0,
    @SerialName("max_deliverables_per_task") val maxDeliverablesPerTask: Int = 0,
    @SerialName("max_versions_per_deliverable") val maxVersionsPerDeliverable: Int = 0,
    @SerialName("allowed_extensions") val allowedExtensions: List<String> = emptyList(),
    @SerialName("outputs_folder") val outputsFolder: String = ".orcha/outputs",
)

/** GET /api/tasks/{tid}/deliverables */
@Serializable
data class DeliverableListDto(
    @SerialName("task_id") val taskId: String = "",
    val deliverables: List<DeliverableDto> = emptyList(),
    val limits: DeliverableLimitsDto = DeliverableLimitsDto(),
)

/** GET …/versions/{v}/text */
@Serializable
data class DeliverableTextDto(
    val text: String = "",
    val truncated: Boolean = false,
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    @SerialName("max_bytes") val maxBytes: Long = 0,
    val kind: String = "text",
)

/** GET …/diff?from=&to= — text kinds carry a git-style unified diff; binaries only report change. */
@Serializable
data class DeliverableDiffDto(
    @SerialName("deliverable_id") val deliverableId: String = "",
    val path: String = "",
    val kind: String = "text",
    @SerialName("from") val fromVersion: DeliverableVersionDto = DeliverableVersionDto(),
    @SerialName("to") val toVersion: DeliverableVersionDto = DeliverableVersionDto(),
    val binary: Boolean = false,
    @SerialName("bytes_changed") val bytesChanged: Boolean = false,
    val diff: String? = null,
    val added: Int = 0,
    val removed: Int = 0,
    val identical: Boolean = false,
    val truncated: Boolean = false,
)

/** POST /api/tasks/{tid}/deliverables (multipart) */
@Serializable
data class DeliverableUploadDto(
    val created: Boolean = false,
    val deduplicated: Boolean = false,
    val deliverable: DeliverableDto? = null,
    val version: DeliverableVersionDto? = null,
)
