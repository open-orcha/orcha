import SwiftUI

// Responsibility: Model and automatic-wake configuration sheets for an agent.

// MARK: - Flow 09 A2: model picker

/// Grouped-by-runtime model rows, radio selection, confirm-on-change.
struct ModelPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let current: String?
    let onConfirm: (String) -> Void

    @State private var picked: String?

    private var groups: [(String, [ModelDto])] {
        Dictionary(grouping: model.models) { $0.runtime ?? $0.provider ?? "models" }
            .sorted { $0.key < $1.key }
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("MODEL").font(.system(size: 11, weight: .bold)).tracking(0.8).foregroundStyle(p.accent)
                        Text("Applies at the next wake.").font(.system(size: 13)).foregroundStyle(p.muted)
                        ForEach(groups, id: \.0) { group, rows in
                            SectionH(title: group)
                            ForEach(rows) { m in
                                Button { picked = m.id } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: picked == m.id ? "largecircle.fill.circle" : "circle")
                                            .foregroundStyle(picked == m.id ? p.accent : p.border2)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(m.name ?? m.id).font(.system(size: 15, weight: .semibold)).foregroundStyle(p.text)
                                            Text(m.id).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(p.muted)
                                        }
                                        Spacer()
                                        if m.id == current { MetaTag(text: "current") }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        let name = model.models.first { $0.id == picked }.map { $0.name ?? $0.id }
                        KitButton(
                            title: (picked != nil && picked != current) ? "Change to \(name ?? "model")" : "Pick a different model",
                            role: .primary,
                            enabled: picked != nil && picked != current && !model.actionInFlight
                        ) {
                            if let picked { onConfirm(picked) }
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .onAppear { picked = current }
    }
}

// MARK: - Flow 09: auto-wake cadence picker

/// Off / 5m / 15m / 1h presets (secs 300 / 900 / 3600); apply on change.
struct AutoWakeSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let current: Int?
    let onConfirm: (Int?) -> Void

    @State private var picked: Int?

    private let presets: [(String, Int?)] = [("Off", nil), ("5m", 300), ("15m", 900), ("1h", 3600)]

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("AUTO-WAKE").font(.system(size: 11, weight: .bold)).tracking(0.8).foregroundStyle(p.accent)
                        Text("Wakes the agent on a clock while idle. Off relies on events only.")
                            .font(.system(size: 13)).foregroundStyle(p.muted)
                        HStack(spacing: 8) {
                            ForEach(presets, id: \.0) { label, secs in
                                PillChip(label: label, selected: picked == secs) { picked = secs }
                            }
                        }
                        KitButton(title: "Apply", role: .primary, enabled: picked != current && !model.actionInFlight) {
                            onConfirm(picked)
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .onAppear { picked = current }
    }
}

// MARK: - Flow 10: Conversation
