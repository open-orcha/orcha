import SwiftUI

// Responsibility: Request response, close, conversion, and filter-chip sheet components.

struct RequestTextSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let kicker: String
    let title: String
    let label: String
    let required: Bool
    let confirm: String
    var destructive: Bool = false
    let onConfirm: (String) async -> Bool

    @State private var text = ""

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canConfirm: Bool {
        (!required || !trimmed.isEmpty) && !model.actionInFlight
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(kicker)
                            .font(.system(size: 11, weight: .bold)).tracking(0.8)
                            .foregroundStyle(destructive ? p.danger : p.accent)
                        Text(title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(p.text2)
                        TextField(label, text: $text, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(12)
                            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                        HStack(spacing: 8) {
                            KitButton(
                                title: confirm,
                                role: destructive ? .dangerTonal : .primary,
                                enabled: canConfirm,
                                action: submit
                            )
                            KitButton(title: "Cancel", role: .neutral, enabled: !model.actionInFlight) { dismiss() }
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() {
        Task { if await onConfirm(trimmed) { dismiss() } }
    }
}

/// Flow 07 — Convert-to-task sheet: Title + DoD + assignee picker (live AI agents),
/// same validation as Create task. Assignee defaults to unassigned.
struct ConvertSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let requestId: String

    @State private var title = ""
    @State private var dod = ""
    @State private var assignee: String?

    private var agents: [String] {
        (model.snapshot?.agents ?? [])
            .filter { $0.kind == "ai" && $0.terminatedAt == nil }
            .map(\.alias)
    }

    private var canConfirm: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !dod.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !model.actionInFlight
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("CONVERT TO TASK")
                            .font(.system(size: 11, weight: .bold)).tracking(0.8)
                            .foregroundStyle(p.violet)
                        field("Task title", text: $title, multiline: false)
                        field("Definition of done", text: $dod, multiline: true)
                        SectionH(title: "Assign to", count: assignee ?? "unassigned")
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                PillChip(label: "Unassigned", selected: assignee == nil) { assignee = nil }
                                ForEach(agents, id: \.self) { alias in
                                    PillChip(label: alias, selected: assignee == alias) { assignee = alias }
                                }
                            }
                        }
                        KitButton(title: "Convert", role: .primary, enabled: canConfirm, action: submit)
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func field(_ label: String, text: Binding<String>, multiline: Bool) -> some View {
        TextField(label, text: text, axis: multiline ? .vertical : .horizontal)
            .lineLimit(multiline ? 3...6 : 1...1)
            .padding(12)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
    }

    private func submit() {
        Task {
            let ok = await model.convertRequest(
                requestId,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                dod: dod.trimmingCharacters(in: .whitespacesAndNewlines),
                assignee: assignee
            )
            if ok { dismiss() }
        }
    }
}

/// A pill chip for assignee / cadence / fresh-chat hint selection (Android's `AssigneeChip`).
struct PillChip: View {
    @Environment(\.palette) private var p
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(selected ? p.accent : p.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? p.accentSoft : p.surface2, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? p.accentLine : p.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
