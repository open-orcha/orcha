import Foundation

/// Plan usage slice: the desktop-published Claude / Codex plan-limit snapshots.
extension OrchaApiClient {

    /// `GET /api/plan-usage` — every desktop host's snapshot, newest first. Portals
    /// older than the endpoint answer 404; that reads as "no snapshots", not an error.
    func planUsage(_ base: String) async throws -> PlanUsageListDto {
        do {
            return try await get(base, "/api/plan-usage")
        } catch let error as OrchaApiError where error.status == 404 {
            return PlanUsageListDto(snapshots: [])
        }
    }
}
