import Foundation

/// D14 project icons — read from the open snapshot (current project) or the containers-home
/// health probe (other projects); written with `PUT /api/containers/{cid}/icon`.
extension AppModel {
    /// The icon for a paired project (nil = unset / not yet probed → default glyph).
    func projectIcon(for cid: String?) -> ProjectIcon? {
        guard let cid else { return nil }
        if cid == selectedContainer?.id, let snap = snapshot, snap.container.id == cid {
            return snap.container.icon
        }
        return containerHealth[cid]?.icon
    }

    /// Whether this phone's identity may change the open project's icon (owner or
    /// `manage_autonomy`, the server's `enforce_grant` rule).
    var canEditProjectIcon: Bool { access.canManage(Grant.manageAutonomy) }

    /// Saves (or with nil clears) the open project's icon. Returns nil on success, else the
    /// message to show in the sheet (the server's 422 text when it sent one).
    func setProjectIcon(_ icon: ProjectIcon?) async -> String? {
        guard let sel = selectedContainer else { return "No project is open." }
        actionInFlight = true
        defer { actionInFlight = false }
        do {
            let saved = try await api.setContainerIcon(sel.baseUrl, sel.id, icon: icon, actor: sel.humanAgentId)
            containerHealth[sel.id]?.icon = saved.icon
            toast = saved.icon == nil ? "Project icon removed" : "Project icon updated"
            await refresh()
            return nil
        } catch let e as OrchaApiError where e.status == 422 {
            return ProjectIconUx.serverDetail(e.body) ?? friendly(e)
        } catch {
            return friendly(error)
        }
    }
}
