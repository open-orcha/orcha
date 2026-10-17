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
    /// Collab v1: both switches are `manage_autonomy` writes server-side — the
    /// same gate applies here, honestly (self-host stays permissive).
    private var lacksGrant: Bool { !model.access.canManage(Grant.manageAutonomy) }
    private var readOnly: Bool { model.humanId == nil || laptopPaused || lacksGrant }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.xl) {
                        if laptopPaused {
                            Banner(kind: .info, text: "This Embodent is paused or stopped on the laptop — controls are disabled until it resumes.")
                        }
                        if lacksGrant {
                            Banner(kind: .info, text: model.access.manageDenialReason(Grant.manageAutonomy, action: "Changing the notifier or autonomy")
                                ?? "These controls need the owner role or the 'manage autonomy' permission.")
                        }
                        notifierSection
                        autonomySection
                        dangerZone
                        if model.humanId == nil {
                            Text("Change autonomy from the laptop.")
                                .ltype(.meta)
                                .foregroundStyle(p.muted)
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(LSpace.l)
                }
                .background(p.bg)
            }
            .navigationTitle("Execution")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(p.bg)
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

    private var wakesSelection: Binding<Bool> {
        Binding(
            get: { wakesEnabled },
            set: { newValue in if newValue != wakesEnabled { pendingWakes = newValue } }
        )
    }

    private var notifierSection: some View {
        LSection("Execution state") {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    LSegmented([(true, "Running"), (false, "Paused")], selection: wakesSelection)
                        .disabled(readOnly || model.actionInFlight)
                        .accessibilityLabel("Execution state")
                    consequence(
                        icon: wakesEnabled ? "play.circle" : "pause.circle",
                        tint: wakesEnabled ? p.ok : p.warn,
                        title: wakesEnabled ? "Running — agents wake normally" : "Paused — nothing wakes",
                        detail: wakesEnabled
                            ? "Agents pick up work at the current autonomy level. Pausing stops new wakes; in-flight work finishes."
                            : "No agent starts new work. Humans and live terminals still work. Resume to pick up where they left off."
                    )
                }
            }
        }
    }

    private func consequence(icon: String, tint: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: LSpace.s) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                Text(detail)
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .contentTransition(.opacity)
        .lAnimation(value: title)
    }

    // MARK: Autonomy — the gearbox

    private var levelSelection: Binding<String> {
        Binding(
            get: { autonomyLevel },
            set: { newValue in if newValue != autonomyLevel { pendingLevel = newValue } }
        )
    }

    private var autonomySection: some View {
        LSection("Autonomy") {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    LSegmented([("plan", "Plan-only"), ("pr", "Build to PR"), ("full", "Full")], selection: levelSelection)
                        .disabled(readOnly || model.actionInFlight)
                        .opacity(wakesEnabled ? 1 : 0.6)
                        .accessibilityLabel("Autonomy")
                    Text(autonomyFooter)
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                }
            }
        }
    }

    // MARK: Danger zone — calm, hairline danger border, one explicit action

    @ViewBuilder
    private var dangerZone: some View {
        if wakesEnabled {
            LSection("Danger zone") {
                HStack(alignment: .center, spacing: LSpace.m) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pause all agent wakes")
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                        Text("Stops every agent immediately. Nothing new starts until you resume.")
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    LButton("Pause", icon: "pause.fill", kind: .danger, size: .small) {
                        pendingWakes = false
                    }
                    .disabled(readOnly || model.actionInFlight)
                }
                .padding(LSpace.m)
                .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous)
                        .strokeBorder(p.dangerLine, lineWidth: 1)
                )
            }
        }
    }

    private var autonomyFooter: String {
        guard !laptopPaused else { return " " }
        if !wakesEnabled { return "Applies when running." }
        return MobileUx.autonomyBlurb(autonomyLevel)
    }
}
