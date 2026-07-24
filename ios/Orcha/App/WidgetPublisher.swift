import Foundation
import WidgetKit

/// App-side writer for the widget's shared state. Called from the foreground
/// refresh (per viewed workspace) and the background notification sweep (all
/// workspaces). The Decision Assist headline is only ever GENERATED elsewhere
/// (sweep / Home card, iOS 26); here we thread through whatever is provided,
/// falling back to the previous headline only while the workspace digest still
/// matches the state it summarized.
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
        var items: [WidgetItem] = []
        for t in snap.tasks where t.status == "in_progress" && t.planMessage != nil && t.planDecision == nil {
            items.append(WidgetItem(id: t.id, kind: "plan", title: t.title))
        }
        for t in snap.tasks where t.status == "needs_verification" {
            items.append(WidgetItem(id: t.id, kind: "verify", title: t.title))
        }
        for r in snap.requests where r.status == "open" && (r.targetId == container.humanAgentId || r.targetId == nil) {
            items.append(WidgetItem(id: r.id, kind: "request", title: String(r.payload.prefix(80))))
        }
        let previous = WidgetStore.load().first { $0.id == container.id }
        let digest = WorkspaceDigest.make(snap)
        let nextHeadline: String?
        let nextHeadlineDigest: String?
        if let headline {
            nextHeadline = headline
            nextHeadlineDigest = digest
        } else if previous?.headlineDigest == digest {
            nextHeadline = previous?.headline
            nextHeadlineDigest = previous?.headlineDigest
        } else {
            nextHeadline = nil
            nextHeadlineDigest = nil
        }
        let next = WidgetWorkspace(
            id: container.id,
            name: container.displayName,
            verify: verify,
            plans: plans,
            escalations: escalations,
            agents: agents,
            headline: nextHeadline,
            headlineDigest: nextHeadlineDigest,
            updatedAt: previous?.updatedAt ?? .now,
            items: Array(items.prefix(6))
        )
        // The foreground poll fires every few seconds; only touch the store and
        // the WidgetKit reload budget when something the widget shows changed.
        if next == previous { return }
        WidgetStore.update(WidgetWorkspace(
            id: next.id, name: next.name, verify: next.verify, plans: next.plans,
            escalations: next.escalations, agents: next.agents,
            headline: next.headline, headlineDigest: next.headlineDigest,
            updatedAt: .now, items: next.items
        ))
        WidgetCenter.shared.reloadAllTimelines()
    }
}
