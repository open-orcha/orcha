import SwiftUI

/// Edit the project's objective (web Settings › General › Objective):
/// `PUT /api/containers/{cid}/objective`. Saving it empty clears it. The snapshot is
/// refreshed after a save so Home shows the new objective straight away.
struct ObjectiveEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let current: String

    @State private var draft = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var next: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { next != current.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var left: Int { ProjectLimitsUx.objectiveMax - draft.count }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                Form {
                    Section {
                        TextField("What should this project achieve?", text: $draft, axis: .vertical)
                            .lineLimit(3...12)
                            .focused($focused)
                            .accessibilityLabel("Project objective")
                            .onChange(of: draft) {
                                if draft.count > ProjectLimitsUx.objectiveMax {
                                    draft = String(draft.prefix(ProjectLimitsUx.objectiveMax))
                                }
                                error = nil
                            }
                    } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("What this project is for. Shown on the Overview and above every task.")
                            if left <= 400 { Text("\(left) characters left") }
                            if next.isEmpty && !current.isEmpty { Text("Saving empty clears it.") }
                        }
                    }
                    if let error {
                        Section { Banner(kind: .danger, text: error) }
                    }
                }
                .scrollContentBackground(.hidden)
                .background(p.surface)
            }
            .navigationTitle("Objective")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!dirty)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(dirty)
        .onAppear {
            draft = current
            focused = true
        }
    }

    private func save() async {
        guard let sel = model.selectedContainer, dirty, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await model.api.putObjective(sel.baseUrl, sel.id, actor: model.humanId, objective: next.isEmpty ? nil : next)
            await model.refresh()
            model.toast = next.isEmpty ? "Objective cleared." : "Objective saved."
            dismiss()
        } catch {
            self.error = ProjectLimitsUx.objectiveSaveError(error)
        }
    }
}
