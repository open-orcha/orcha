package io.openorcha.mobile.data

/* Plan usage slice API (read-only): GET /api/plan-usage on each paired portal. Per-portal,
   not per-project, so no container id. A 404 means an older portal without the route:
   it reads as "no snapshots", never an error. Own client instance (same bearer auth). */

import io.ktor.client.call.body
import io.ktor.client.plugins.ResponseException
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout

object PlanUsageApi {
    private val client by lazy { createOrchaHttpClient() }

    /** Snapshots on one portal; empty for a portal that predates the route (404). */
    suspend fun snapshots(baseUrl: String): List<PlanUsageSnapshotDto> = try {
        withTimeout(8_000) {
            client.get("${baseUrl.endpoint()}/api/plan-usage").body<PlanUsageListResponse>().snapshots
        }
    } catch (e: ResponseException) {
        if (e.response.status == HttpStatusCode.NotFound) emptyList() else throw e
    }

    /** Reads every distinct portal once, in parallel. Unreachable portals are skipped;
     *  returns null only when every portal failed (so the UI can say so). */
    suspend fun allSnapshots(baseUrls: Collection<String>): List<PlanUsageSnapshotDto>? = coroutineScope {
        val distinct = baseUrls.map { it.endpoint() }.distinct()
        if (distinct.isEmpty()) return@coroutineScope emptyList()
        val results = distinct.map { url -> async { runCatching { snapshots(url) }.getOrNull() } }.map { it.await() }
        if (results.all { it == null }) null else results.filterNotNull().flatten()
    }
}
