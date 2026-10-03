package io.openorcha.mobile.data

/* Plan usage slice DTOs: the snapshot the Embodent desktop app publishes to each portal
   (GET /api/plan-usage). Plan names, window labels, used %, reset times and today's
   tokens/cost only: no credentials ever travel in it. Every field is tolerant. */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class PlanUsageListResponse(
    val snapshots: List<PlanUsageSnapshotDto> = emptyList(),
)

@Serializable
data class PlanUsageSnapshotDto(
    val host: String = "",
    @SerialName("captured_at") val capturedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val providers: List<PlanUsageProviderDto> = emptyList(),
)

@Serializable
data class PlanUsageProviderDto(
    val provider: String = "",
    val plan: String? = null,
    val headline: String? = null,
    val windows: List<PlanUsageWindowDto> = emptyList(),
    val today: PlanUsageTodayDto? = null,
)

@Serializable
data class PlanUsageWindowDto(
    val key: String = "",
    val label: String = "",
    @SerialName("used_pct") val usedPct: Double = 0.0,
    @SerialName("resets_at") val resetsAt: String? = null,
)

@Serializable
data class PlanUsageTodayDto(
    val tokens: Long? = null,
    @SerialName("cost_usd") val costUsd: Double? = null,
)
