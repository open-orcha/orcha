import SwiftUI

/// GH #148 — the Notifier (`wakes_enabled`) and Autonomy (`autonomy_level`) controls, split
/// into two independent surfaces per Dana's design spec
/// (docs/design/autonomy-notifier-split-gh148/spec.md). Mental model: Notifier = the power
/// switch, Autonomy = the gearbox — flipping one never re-shifts the other. No backend change:
/// both endpoints already exist and are human-only.
struct ContainerControlsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    /// The target value pending a confirmation tap — snaps back to the real value if the
    /// control's own binding re-renders before the user confirms (same "flip, confirm, or
    /// bounce back" shape as a native destructive Settings switch).
    @State private var pendingWakes: Bool?
    @State private var pendingLevel: String?

    private var container: ContainerDto? { model.snapshot?.container }
    /// Spec §6.3 — pre-SPEC-1 snapshots may omit this; treat unknown as Running.
    private var wakesEnabled: Bool { container?.wakesEnabled ?? true }
    /// Spec §6.3 — treat unknown autonomy_level as plan.
    private var autonomyLevel: String { container?.autonomyLevel ?? "plan" }
    /// Spec §6.2 — a DIFFERENT, higher state than the notifier: the laptop-level container
    /// lifecycle (`/orcha-pause`), not the in-container wake switch.
    private var laptopPaused: Bool { (container?.status ?? "active") != "active" }
    private var readOnly: Bool { model.humanId == nil || laptopPaused }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if laptopPaused {
                            Banner(kind: .info, text: "This Orcha is paused or stopped on the laptop — controls are disabled until it resumes.")
                        }
                        notifierSection
                        autonomySection
                        if model.humanId == nil {
                            Text("Change autonomy from the laptop.")
                                .font(.system(size: 12.5))
                                .foregroundStyle(p.muted)
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Autonomy & Notifier")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium])
        .confirmationDialog(
            (pendingWakes ?? true) ? "Resume agent wakes?" : "Pause all agent wakes?",
            isPresented: Binding(get: { pendingWakes != nil }, set: { if !$0 { pendingWakes = nil } }),
            titleVisibility: .visible
        ) {
            if let enabled = pendingWakes {
                Button(enabled ? "Resume" : "Pause all wakes", role: enabled ? nil : .destructive) {
                    pendingWakes = nil
                    Task { await model.setWakes(enabled: enabled) }
                }
                Button("Cancel", role: .cancel) { pendingWakes = nil }
            }
        } message: {
            Text((pendingWakes ?? true)
                ? "Agents resume waking at the current autonomy level."
                : "Agents stop waking immediately. In-flight work finishes; nothing new starts. Humans & live terminals still work.")
        }
        .confirmationDialog(
            "Switch to \(MobileUx.autonomyLabel(pendingLevel ?? autonomyLevel))?",
            isPresented: Binding(get: { pendingLevel != nil }, set: { if !$0 { pendingLevel = nil } }),
            titleVisibility: .visible
        ) {
            if let level = pendingLevel {
                Button(MobileUx.autonomyLabel(level), role: level == "full" ? .destructive : nil) {
                    pendingLevel = nil
                    Task { await model.setAutonomy(level: level) }
                }
                Button("Cancel", role: .cancel) { pendingLevel = nil }
            }
        } message: {
            Text(MobileUx.autonomyBlurb(pendingLevel ?? autonomyLevel))
        }
    }

    // MARK: Notifier — the power switch

    private var notifierSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Notifier — the power switch")
            OrchaCard {
                Toggle(isOn: Binding(get: { wakesEnabled }, set: { pendingWakes = $0 })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notifier").font(.system(size: 14, weight: .bold)).foregroundStyle(p.text)
                        Text(wakesEnabled ? "Running — agents wake normally" : "Paused — nothing wakes")
                            .font(.system(size: 13))
                            .foregroundStyle(wakesEnabled ? p.ok : p.danger)
                    }
                }
                .tint(p.ok)
                .disabled(readOnly || model.actionInFlight)
            }
        }
    }

    // MARK: Autonomy — the gearbox

    private var autonomySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Autonomy — the gearbox")
            OrchaCard {
                Picker("Autonomy", selection: Binding(
                    get: { autonomyLevel },
                    set: { newValue in if newValue != autonomyLevel { pendingLevel = newValue } }
                )) {
                    Text("Plan-only").tag("plan")
                    Text("Build to PR").tag("pr")
                    Text("Full").tag("full")
                }
                .pickerStyle(.segmented)
                .disabled(readOnly || model.actionInFlight)
                .opacity(wakesEnabled ? 1 : 0.6)
                Text(autonomyFooter)
                    .font(.system(size: 12.5))
                    .foregroundStyle(p.muted)
            }
        }
    }

    private var autonomyFooter: String {
        guard !laptopPaused else { return " " }
        if !wakesEnabled { return "Applies when running." }
        return MobileUx.autonomyBlurb(autonomyLevel)
    }
}
