package io.openorcha.mobile.data

/**
 * Task deliverables endpoints (see DtosTask2.kt). Extension functions on [OrchaApiClient]
 * so they ride the shared Ktor client: bearer auth, the perimeter HTML check, tolerant JSON.
 */

import io.ktor.client.call.body
import io.ktor.client.plugins.timeout
import io.ktor.client.request.forms.formData
import io.ktor.client.request.forms.submitFormWithBinaryData
import io.ktor.client.request.get
import io.ktor.client.statement.readRawBytes
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.withTimeout

private fun deliverablesPath(taskId: String) = "/api/tasks/$taskId/deliverables"

suspend fun OrchaApiClient.listDeliverables(baseUrl: String, taskId: String): DeliverableListDto = withTimeout(10_000) {
    client.get(baseUrl.endpoint() + deliverablesPath(taskId)).body()
}

/** One deliverable with its full version history (newest first). */
suspend fun OrchaApiClient.getDeliverable(baseUrl: String, taskId: String, deliverableId: String): DeliverableDto =
    withTimeout(10_000) { client.get(baseUrl.endpoint() + deliverablesPath(taskId) + "/$deliverableId").body() }

/** The capped UTF-8 text of a text-kind version; [textUrl] is the version's server-relative `text_url`. */
suspend fun OrchaApiClient.getDeliverableText(baseUrl: String, textUrl: String): DeliverableTextDto =
    withTimeout(15_000) { client.get(baseUrl.endpoint() + textUrl).body() }

/** The bytes of one version (images / PDFs); [rawUrl] is the version's `raw_url`. */
suspend fun OrchaApiClient.getDeliverableRaw(baseUrl: String, rawUrl: String): ByteArray = withTimeout(60_000) {
    client.get(baseUrl.endpoint() + rawUrl) {
        timeout { requestTimeoutMillis = 60_000; socketTimeoutMillis = 30_000 }
    }.readRawBytes()
}

suspend fun OrchaApiClient.getDeliverableDiff(
    baseUrl: String,
    taskId: String,
    deliverableId: String,
    from: Int,
    to: Int,
): DeliverableDiffDto = withTimeout(15_000) {
    client.get(baseUrl.endpoint() + deliverablesPath(taskId) + "/$deliverableId/diff?from=$from&to=$to").body()
}

/**
 * Attach a file as a human (web parity: `author_agent_id` = the acting human). Uploading a
 * path that exists appends a version; identical bytes come back `deduplicated`.
 */
suspend fun OrchaApiClient.uploadDeliverable(
    baseUrl: String,
    taskId: String,
    actorId: String,
    fileName: String,
    mimeType: String,
    bytes: ByteArray,
): DeliverableUploadDto = withTimeout(120_000) {
    client.submitFormWithBinaryData(
        url = baseUrl.endpoint() + deliverablesPath(taskId),
        formData = formData {
            append("author_agent_id", actorId)
            append(
                "file",
                bytes,
                Headers.build {
                    append(HttpHeaders.ContentType, mimeType)
                    append(HttpHeaders.ContentDisposition, "filename=\"${fileName.replace("\"", "")}\"")
                },
            )
        },
    ) {
        timeout { requestTimeoutMillis = 120_000; socketTimeoutMillis = 60_000 }
    }.body()
}
