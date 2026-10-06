import Foundation

/// D14 project icon writes.
struct ContainerIconResponse: Decodable {
    var containerId: String?
    var icon: ProjectIcon?

    enum CodingKeys: String, CodingKey {
        case icon
        case containerId = "container_id"
    }
}

extension OrchaApiClient {
    /// `PUT /api/containers/{cid}/icon {icon, actor_agent_id}` — nil icon clears it.
    func setContainerIcon(_ base: String, _ cid: String, icon: ProjectIcon?, actor: String?) async throws -> ContainerIconResponse {
        try await putDecoding(base, "/api/containers/\(cid)/icon", [
            "icon": icon?.jsonValue ?? NSNull(),
            "actor_agent_id": actor,
        ])
    }
}
