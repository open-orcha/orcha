import Foundation
import WidgetKit

/// App-side writer for the widget's shared state. Called from the foreground
/// refresh (per viewed workspace) and the background notification sweep (all
/// workspaces). The Decision Assist headline is only ever GENERATED elsewhere
/// (sweep / Home card, iOS 26); here we thread through whatever is provided,
/// falling back to the previously published headline so it never flickers away.
enum WidgetPublisher {
    static func publish(
        _ snap: ContainerSnapshot,
        container: StoredContainer,
        headline: String? = nil
    ) {
        let verify = snap.tasks.filter { $0.status == "needs_verification" }.count
        let plans = snap.tasks.filter {
            $0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil
        }.count
        let escalations = snap.requests.filter {
            $0.status == "open" && ($0.targetId == container.humanAgentId || $0.targetId == nil)
        }.count
        let agents = snap.agents
            .filter { $0.kind == "ai" }
            .map { WidgetAgent(alias: $0.alias, status: $0.status ?? "idle") }
        let previous = WidgetStore.load().first { $0.id == container.id }
        let next = WidgetWorkspace(
            id: container.id,
            name: container.displayName,
            verify: verify,
            plans: plans,
            escalations: escalations,
            agents: agents,
            headline: headline ?? previous?.headline,
            updatedAt: previous?.updatedAt ?? .now
        )
        // The foreground poll fires every few seconds; only touch the store and
        // the WidgetKit reload budget when something the widget shows changed.
        if next == previous { return }
        WidgetStore.update(WidgetWorkspace(
            id: next.id, name: next.name, verify: next.verify, plans: next.plans,
            escalations: next.escalations, agents: next.agents,
            headline: next.headline, updatedAt: .now
        ))
        WidgetCenter.shared.reloadAllTimelines()
    }
}
