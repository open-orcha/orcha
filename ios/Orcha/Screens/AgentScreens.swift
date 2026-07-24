import SwiftUI
import UIKit   // UIResponder keyboard notifications (Issue 2 — scroll composer above keyboard)

// Responsibility: Agent detail presentation, status, controls, memory, and recent activity.

/* =============================================================================
   Flow 09 — Agent detail (header, Now, Controls, persona, memory, requests, runs)
             + model / auto-wake pickers, rename alert, retire confirm.
   Flow 10 — Converse (honest presence, day dividers, bubbles, composer, end).
   Both are pushed screens; the parent tab owns the NavigationStack.
   ============================================================================= */

// MARK: - Flow 09: Agent detail

struct AgentDetailScreen: View {
    @Environment(AppModel.self) var model
    @Environment(\.palette) var p
    let agentId: String

    @State var personaOpen = false
    @State var showModelPicker = false
    @State var showWakePicker = false
    @State var renaming = false
    @State var newAlias = ""
    @State var confirmRetire = false

    var agent: AgentDto? {
        model.snapshot?.agents.first { $0.id == agentId }
    }

    var body: some View {
        Group {
            if let agent {
                content(agent)
            } else {
                OrchaCard {
                    Text("Agent not found — refresh the workspace.")
                        .foregroundStyle(p.muted)
                }
                .padding(16)
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .navigationTitle(agent?.alias ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarMenu }
        .task { await model.loadAgentDetail(agentId) }
    }

    var dead: Bool {
        let agent = agent
        return agent?.status == "terminated" || agent?.terminatedAt != nil
    }

    // MARK: body

    func content(_ agent: AgentDto) -> some View {
        ScrollView {
            VStack(spacing: 10) {
                if dead {
                    Banner(
                        kind: .danger,
                        text: "Retired\(MobileUx.agoLabel(agent.terminatedAt).map { " \($0)" } ?? "") — this agent no longer wakes."
                    )
                }
                attentionBanners(agent)
                header(agent)
                if agent.kind == "ai" && !dead {
                    NavigationLink(value: WorkspaceRoute.converse(agent.id)) {
                        KitButtonLabel(title: "Converse", role: .primary)
                    }
                    .buttonStyle(.plain)
                }
                nowSection(agent)
                if agent.kind == "ai" { controls(agent) }
                persona(agent)
                memory()
                requestsSummary()
                recentRuns(agent)
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(16)
        }
        .refreshable { await model.loadAgentDetail(agentId) }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(current: agent.model) { picked in
                Task { if await model.changeModel(agent.id, model: picked) { showModelPicker = false } }
            }
        }
        .sheet(isPresented: $showWakePicker) {
            AutoWakeSheet(current: agent.autoWakeIntervalSecs) { secs in
                Task { if await model.changeAutoWake(agent.id, intervalSecs: secs) { showWakePicker = false } }
            }
        }
        .alert("Rename \(agent.alias)", isPresented: $renaming) {
            TextField("Alias", text: $newAlias)
            Button("Rename") {
                let alias = newAlias.trimmingCharacters(in: .whitespaces)
                if !alias.isEmpty { Task { await model.renameAgent(agent.id, alias: alias) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Renaming orphans the laptop's CLI binding for the old alias — the agent re-binds on its next registration.")
        }
        .confirmationDialog(
            "Retire \(agent.alias) — they stop waking.",
            isPresented: $confirmRetire,
            titleVisibility: .visible
        ) {
            Button("Retire", role: .destructive) { Task { await model.retireAgent(agent.id) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Their tasks stay assigned and history stays visible. This can't be undone from the app.")
        }
    }

}
