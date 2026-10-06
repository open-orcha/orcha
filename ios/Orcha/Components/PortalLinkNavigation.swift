import SwiftUI

/// Opens tapped portal-link chips: task / request / agent / GitHub links push the in-app
/// screen; anything the phone has no screen for opens the paired portal in the browser.
/// Attach to a pushed screen and pass the returned handler to `Bubble` / `ChatMarkdownView`.
struct PortalLinkNavigation: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var route: WorkspaceRoute?

    func body(content: Content) -> some View {
        content.navigationDestination(item: $route) { route in
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                switch route {
                case let .task(id): TaskDetailScreen(taskId: id)
                case let .request(id): RequestDetailScreen(requestId: id)
                case let .agent(id): AgentDetailScreen(agentId: id)
                case let .githubPull(n): GitHubPullDetailScreen(number: n)
                case let .githubIssue(n): GitHubIssueDetailScreen(number: n)
                default: EmptyView()
                }
            }
        }
    }
}

extension View {
    func portalLinkNavigation(_ route: Binding<WorkspaceRoute?>) -> some View {
        modifier(PortalLinkNavigation(route: route))
    }
}

extension AppModel {
    /// The paired portal's base URL (portal links on this host open in the app).
    var portalBase: String? { selectedContainer?.baseUrl }

    /// Resolve a tapped portal link against the current snapshot.
    func portalDestination(_ link: PortalLink) -> PortalLinkRouting.Destination {
        PortalLinkRouting.resolve(
            link,
            tasks: snapshot?.tasks ?? [],
            requestIds: snapshot?.requests.map(\.id) ?? [],
            agents: snapshot?.agents.map { ($0.id, $0.alias) } ?? [],
            portalBase: portalBase
        )
    }
}
