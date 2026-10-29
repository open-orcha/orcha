package io.openorcha.mobile.data

/**
 * Workflows endpoints (mobile design #373 §3), every route checked against the live
 * `/openapi.json`. Extension functions on [OrchaApiClient] so they ride the shared Ktor
 * client (bearer auth, the perimeter HTML check, tolerant JSON). Every call carries the
 * paired human as `X-Orcha-Local-Actor`, the same claim the web sends; the server
 * re-validates live membership on every write and ignores the claim behind a hosted proxy.
 */

import io.ktor.client.call.body
import io.ktor.client.plugins.ResponseException
import io.ktor.client.plugins.timeout
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import io.ktor.http.encodeURLPathPart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

internal const val LOCAL_ACTOR_HEADER = "X-Orcha-Local-Actor"
private const val WORKFLOW_TIMEOUT_MS = 15_000L

/**
 * A workflow call that did not succeed. [uncertain] means a WRITE may or may not have been
 * saved (no reply, a 5xx/408, or an unreadable reply): the caller must read the operation
 * receipt before offering "Retry same request" (design §8).
 */
class WorkflowApiException(
    message: String,
    val status: Int = 0,
    val code: String = "",
    val uncertain: Boolean = false,
    cause: Throwable? = null,
) : Exception(message, cause)

private val errorJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Reads the server's `detail` (string, `{code, message}`, or a validation list) into one message. */
internal fun workflowErrorFrom(status: Int, body: String, mutation: Boolean): WorkflowApiException {
    var message = "Orcha could not complete this request."
    var code = ""
    runCatching {
        when (val detail = errorJson.parseToJsonElement(body).jsonObject["detail"]) {
            is JsonPrimitive -> detail.contentOrNull?.let { message = it }
            is JsonObject -> {
                (detail["message"] as? JsonPrimitive)?.contentOrNull?.let { message = it }
                (detail["code"] as? JsonPrimitive)?.contentOrNull?.let { code = it }
            }
            is JsonArray -> message = "Check the highlighted fields and review again. Nothing was saved."
            else -> Unit
        }
    }
    return WorkflowApiException(message, status, code, uncertain = mutation && (status >= 500 || status == 408))
}

private fun HttpRequestBuilder.workflowRequest(actorId: String?) {
    actorId?.takeIf { it.isNotBlank() }?.let { header(LOCAL_ACTOR_HEADER, it) }
    timeout { requestTimeoutMillis = WORKFLOW_TIMEOUT_MS; socketTimeoutMillis = WORKFLOW_TIMEOUT_MS }
}

/** Maps any failure to [WorkflowApiException], keeping cancellation intact. */
private suspend inline fun <R> workflowCall(mutation: Boolean, crossinline block: suspend () -> R): R =
    try {
        withTimeout(WORKFLOW_TIMEOUT_MS + 1_000) { block() }
    } catch (e: CancellationException) {
        if (e is kotlinx.coroutines.TimeoutCancellationException) {
            throw WorkflowApiException(
                "Could not reach Orcha. Check your connection and try again.", 0, "connection", mutation, e,
            )
        }
        throw e
    } catch (e: WorkflowApiException) {
        throw e
    } catch (e: OrchaAuthRequiredException) {
        throw WorkflowApiException("Sign in again to reach this project.", 401, "auth_required", false, e)
    } catch (e: ResponseException) {
        val text = runCatching { e.response.bodyAsText() }.getOrDefault("")
        throw workflowErrorFrom(e.response.status.value, text, mutation)
    } catch (e: io.ktor.serialization.ContentConvertException) {
        // Ktor wraps body decode failures (JsonConvertException); they are not connection errors.
        throw WorkflowApiException(
            "Orcha returned an unreadable response. Check the saved result before trying again.",
            0, "invalid_response", mutation, e,
        )
    } catch (e: SerializationException) {
        throw WorkflowApiException(
            "Orcha returned an unreadable response. Check the saved result before trying again.",
            0, "invalid_response", mutation, e,
        )
    } catch (e: Exception) {
        throw WorkflowApiException("Could not reach Orcha. Check your connection and try again.", 0, "connection", mutation, e)
    }

internal suspend inline fun <reified R> OrchaApiClient.workflowGet(baseUrl: String, path: String, actorId: String?): R =
    workflowCall(mutation = false) {
        client.get(baseUrl.endpoint() + path) { workflowRequest(actorId) }.body()
    }

/** POST/PUT/PATCH a typed body. Draft previews pass `mutation = false` (nothing is saved). */
internal suspend inline fun <reified T : Any, reified R> OrchaApiClient.workflowSend(
    method: String,
    baseUrl: String,
    path: String,
    actorId: String?,
    payload: T,
    mutation: Boolean = true,
): R = workflowCall(mutation) {
    val url = baseUrl.endpoint() + path
    val configure: HttpRequestBuilder.() -> Unit = {
        workflowRequest(actorId)
        contentType(ContentType.Application.Json)
        setBody(payload)
    }
    when (method) {
        "PUT" -> client.put(url, configure)
        "PATCH" -> client.patch(url, configure)
        else -> client.post(url, configure)
    }.body()
}

private fun seg(id: String) = id.encodeURLPathPart()

/** FastAPI `list[str] = Query()` reads repeated keys: `task_ids=a&task_ids=b`. */
internal fun repeated(key: String, values: List<String>): String =
    values.joinToString("&") { "$key=${it.encodeURLParameter()}" }

/** Paths for every workflow route the phone calls (live contract names). */
object WorkflowPaths {
    fun capability(cid: String) = "/api/containers/${seg(cid)}/workflows/capability"
    fun collection(cid: String) = "/api/containers/${seg(cid)}/workflows"
    fun preview(cid: String) = "/api/containers/${seg(cid)}/workflows/preview"
    fun receipt(cid: String, key: String, operation: String) =
        "/api/containers/${seg(cid)}/workflow-operations/${seg(key)}?operation=${operation.encodeURLParameter()}"
    fun taskSearch(cid: String) = "/api/containers/${seg(cid)}/workflow-task-search"
    fun detail(wid: String) = "/api/workflows/${seg(wid)}"
    fun action(wid: String, action: String) = "/api/workflows/${seg(wid)}/$action"
    fun task(tid: String, action: String) = "/api/tasks/${seg(tid)}/$action"
}

suspend fun OrchaApiClient.getWorkflowCapability(baseUrl: String, cid: String, actorId: String?): WorkflowCapabilityDto =
    workflowGet(baseUrl, WorkflowPaths.capability(cid), actorId)

suspend fun OrchaApiClient.listWorkflows(
    baseUrl: String,
    cid: String,
    actorId: String?,
    status: String?,
    cursor: String?,
    visibility: String? = null,
    limit: Int = 50,
): WorkflowListDto {
    val query = listOfNotNull(
        status?.let { "status=${it.encodeURLParameter()}" },
        cursor?.let { "cursor=${it.encodeURLParameter()}" },
        visibility?.let { "visibility=${it.encodeURLParameter()}" },
        "limit=$limit",
    ).joinToString("&")
    return workflowGet(baseUrl, WorkflowPaths.collection(cid) + "?" + query, actorId)
}

suspend fun OrchaApiClient.getWorkflow(baseUrl: String, wid: String, actorId: String?): WorkflowDetailDto =
    workflowGet(baseUrl, WorkflowPaths.detail(wid), actorId)

suspend fun OrchaApiClient.getWorkflowReceipt(
    baseUrl: String,
    cid: String,
    key: String,
    operation: String,
    actorId: String?,
): WorkflowReceiptDto = workflowGet(baseUrl, WorkflowPaths.receipt(cid, key, operation), actorId)

suspend fun OrchaApiClient.getWorkflowActivity(
    baseUrl: String,
    wid: String,
    actorId: String?,
    beforeAt: String?,
    beforeId: String?,
    limit: Int = 50,
): WorkflowActivityPageDto {
    val query = listOfNotNull(
        beforeAt?.let { "before_at=${it.encodeURLParameter()}" },
        beforeId?.let { "before_id=${it.encodeURLParameter()}" },
        "limit=$limit",
    ).joinToString("&")
    return workflowGet(baseUrl, WorkflowPaths.action(wid, "activity") + "?" + query, actorId)
}

/** start-check, release-check and cancellation-check all answer `WorkflowImpact`. */
suspend fun OrchaApiClient.getWorkflowImpact(
    baseUrl: String,
    wid: String,
    check: String,
    actorId: String?,
    taskIds: List<String> = emptyList(),
    holds: List<String> = emptyList(),
): WorkflowDetailDto {
    val query = listOfNotNull(
        repeated("task_ids", taskIds),
        repeated("holds", holds),
    ).filter { it.isNotEmpty() }.joinToString("&").let { if (it.isEmpty()) "" else "?$it" }
    return workflowGet(baseUrl, WorkflowPaths.action(wid, check) + query, actorId)
}

suspend fun OrchaApiClient.getWorkflowCompletionCheck(baseUrl: String, wid: String, actorId: String?): WorkflowCompletionDto =
    workflowGet(baseUrl, WorkflowPaths.action(wid, "completion-check"), actorId)

suspend fun OrchaApiClient.getWorkflowVisibilityCheck(baseUrl: String, wid: String, actorId: String?): VisibilityCheckDto =
    workflowGet(baseUrl, WorkflowPaths.action(wid, "visibility-check"), actorId)

suspend fun OrchaApiClient.getWorkflowTaskEvidence(
    baseUrl: String,
    wid: String,
    tid: String,
    actorId: String?,
    beforeRevision: Int? = null,
): WorkflowTaskEvidenceDto {
    val query = beforeRevision?.let { "?before_revision=$it" } ?: ""
    return workflowGet(baseUrl, "/api/workflows/${seg(wid)}/tasks/${seg(tid)}/evidence$query", actorId)
}

suspend fun OrchaApiClient.getRoundContext(baseUrl: String, tid: String, actorId: String?): RoundContextDto =
    workflowGet(baseUrl, WorkflowPaths.task(tid, "round-context"), actorId)

suspend fun OrchaApiClient.getTaskApprovals(baseUrl: String, tid: String, actorId: String?): TaskApprovalHistoryDto =
    workflowGet(baseUrl, WorkflowPaths.task(tid, "approvals"), actorId)

suspend fun OrchaApiClient.searchWorkflowTasks(
    baseUrl: String,
    cid: String,
    actorId: String?,
    query: String,
    selected: List<String>,
    limit: Int = 5,
): WorkflowTaskSearchDto {
    val q = listOfNotNull(
        "query=${query.encodeURLParameter()}",
        repeated("selected", selected),
        "limit=$limit",
    ).filter { it.isNotEmpty() }.joinToString("&")
    return workflowGet(baseUrl, WorkflowPaths.taskSearch(cid) + "?" + q, actorId)
}

suspend fun OrchaApiClient.previewWorkflowDraft(baseUrl: String, cid: String, actorId: String?, body: WorkflowDraftBody): WorkflowPreviewDto =
    workflowSend("POST", baseUrl, WorkflowPaths.preview(cid), actorId, body, mutation = false)

suspend fun OrchaApiClient.createWorkflow(baseUrl: String, cid: String, actorId: String?, body: WorkflowCreateBody): WorkflowDetailDto =
    workflowSend("POST", baseUrl, WorkflowPaths.collection(cid), actorId, body)

suspend fun OrchaApiClient.previewWorkflowImport(baseUrl: String, wid: String, actorId: String?, body: WorkflowImportPreviewBody): WorkflowPreviewDto =
    workflowSend("POST", baseUrl, WorkflowPaths.action(wid, "import-preview"), actorId, body, mutation = false)

suspend fun OrchaApiClient.previewTaskOutcome(baseUrl: String, tid: String, actorId: String?, body: WorkflowOutcomeChoiceBody): RoutingPreviewDto =
    workflowSend("POST", baseUrl, WorkflowPaths.task(tid, "outcome/preview"), actorId, body, mutation = false)

suspend fun OrchaApiClient.setTaskAutonomy(baseUrl: String, tid: String, actorId: String, autonomy: String): TaskAutonomyResultDto =
    workflowSend("PUT", baseUrl, WorkflowPaths.task(tid, "autonomy"), actorId, TaskAutonomyUpdateBody(autonomy, actorId))

/**
 * Every workflow write that answers `WorkflowDetail`, by method + path. Each body type is
 * the schema the route declares; [WorkflowWrite] pairs them so the repository can retry
 * the SAME request with the same idempotency key.
 */
suspend fun OrchaApiClient.sendWorkflowWrite(baseUrl: String, actorId: String?, write: WorkflowWrite): WorkflowDetailDto =
    when (val b = write.body) {
        is WorkflowMutationBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowTaskMutationBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowReleaseBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowPrepareBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowRetryBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowDependencyEditBody -> workflowSend("PUT", baseUrl, write.path, actorId, b)
        is WorkflowAcceptTaskBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowOutcomeReportBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowOutsideResultBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowAddEvidenceBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowAcceptBasisBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowTaskBatchBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowImportBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowMoveBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowPatchBody -> workflowSend("PATCH", baseUrl, write.path, actorId, b)
        is WorkflowObjectiveEditBody -> workflowSend("PATCH", baseUrl, write.path, actorId, b)
        is WorkflowTransferOwnerBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowReviewRoundBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowLoopDecisionBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        is WorkflowCreateBody -> workflowSend("POST", baseUrl, write.path, actorId, b)
        else -> throw WorkflowApiException("This change does not match the server's supported fields. Your draft is kept.", 422, "invalid_request")
    }

/**
 * One workflow write: the route, its body and the receipt operation name. [operation] is
 * what `GET …/workflow-operations/{key}?operation=` expects for this write.
 */
data class WorkflowWrite(
    val path: String,
    val operation: String,
    val idempotencyKey: String,
    val body: Any,
)
