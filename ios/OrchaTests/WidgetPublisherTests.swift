import Foundation
import Testing
@testable import Orcha

@Suite struct WidgetPublisherTests {
    private let container = StoredContainer(
        id: "workspace-1",
        displayName: "Release",
        baseUrl: "http://127.0.0.1:8001",
        humanAgentId: "human-1"
    )

    @Test func headlineIsKeptOnlyForTheDigestItSummarized() throws {
        WidgetStore.save([])
        defer { WidgetStore.save([]) }

        let initial = snapshot(tasks: [
            TaskDto(id: "plan-1", title: "Review launch plan", status: "in_progress",
                    planMessage: TaskMessageDto(body: "Plan"), planDecision: nil),
        ])

        WidgetPublisher.publish(initial, container: container, headline: "Forge drafted the launch plan.")

        var saved = try #require(WidgetStore.load().first)
        #expect(saved.headline == "Forge drafted the launch plan.")
        #expect(saved.headlineDigest == WorkspaceDigest.make(initial))

        WidgetPublisher.publish(initial, container: container)

        saved = try #require(WidgetStore.load().first)
        #expect(saved.headline == "Forge drafted the launch plan.")
        #expect(saved.headlineDigest == WorkspaceDigest.make(initial))

        let changed = snapshot(tasks: [
            TaskDto(id: "plan-1", title: "Review launch plan", status: "in_progress",
                    planMessage: TaskMessageDto(body: "Plan"), planDecision: nil),
            TaskDto(id: "verify-1", title: "Verify release build", status: "needs_verification"),
        ])

        WidgetPublisher.publish(changed, container: container)

        saved = try #require(WidgetStore.load().first)
        #expect(saved.needsYou == 2)
        #expect(saved.headline == nil)
        #expect(saved.headlineDigest == nil)
    }

    private func snapshot(tasks: [TaskDto]) -> ContainerSnapshot {
        ContainerSnapshot(
            container: ContainerDto(id: "workspace-1", name: "Release"),
            agents: [
                AgentDto(id: "agent-1", alias: "Forge", kind: "ai", status: "working"),
            ],
            tasks: tasks,
            requests: []
        )
    }
}
