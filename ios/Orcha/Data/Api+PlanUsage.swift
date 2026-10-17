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

/// Plan usage display setting (portal-wide show / providers choice).
extension OrchaApiClient {

    /// `GET /api/plan-usage/display`. A portal older than the endpoint answers 404 → nil
    /// (ignored by the merge, like a network error).
    func planUsageDisplay(_ base: String) async throws -> PlanUsageDisplayDto? {
        do {
            return try await get(base, "/api/plan-usage/display")
        } catch let error as OrchaApiError where error.status == 404 {
            return nil
        }
    }

    /// `PUT /api/plan-usage/display` — exactly `show` + `providers` (the portal 422s extra fields).
    func putPlanUsageDisplay(_ base: String, show: Bool, providers: String) async throws -> PlanUsageDisplayDto {
        try await putDecoding(base, "/api/plan-usage/display", ["show": show, "providers": providers])
    }
}
