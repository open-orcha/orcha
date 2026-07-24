import SwiftUI

/// Flow 04 S1 — Settings: Appearance (instant three-way theme), containers, about.
/// A 1:1 port of the Android `SettingsScreen`, presented as a sheet.
struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        appearanceSection
                        notificationsSection
                        containersSection
                        aboutSection
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: appearance

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Appearance")
            OrchaCard {
                Picker("Appearance", selection: themeBinding) {
                    ForEach(ThemeMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                Text("Auto follows the system setting. Changes apply instantly.")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            }
            SectionH(title: "Design")
            OrchaCard {
                Picker("Design", selection: skinBinding) {
                    ForEach(SkinMode.allCases, id: \.self) { skin in
                        Text(skin.label).tag(skin)
                    }
                }
                .pickerStyle(.segmented)
                Text(model.skinMode.blurb)
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
                    .contentTransition(.opacity)
            }
        }
    }

    private var themeBinding: Binding<ThemeMode> {
        Binding(
            get: { model.themeMode },
            set: { model.setThemeMode($0) }
        )
    }

    private var skinBinding: Binding<SkinMode> {
        Binding(
            get: { model.skinMode },
            set: { model.setSkinMode($0) }
        )
    }

    // MARK: notifications

    @State private var testStatus: String?

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Notifications")
            OrchaCard {
                Toggle(isOn: notificationsBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Needs-you alerts")
                            .font(p.uiFont(14, .semibold))
                            .foregroundStyle(p.text)
                        Text("Background checks post an alert when a plan, verification, or request starts waiting on you — tapping opens that exact screen. iOS times the checks: expect minutes to an hour, not instant.")
                            .font(p.uiFont(12))
                            .foregroundStyle(p.muted)
                    }
                }
                .tint(p.accent)
                if model.notificationsEnabled {
                    KitButton(title: "Send test alert (arrives in 3s)", role: .neutral, small: true) {
                        Task { testStatus = await NotificationCoordinator.shared.sendTest(model: model) }
                    }
                    if let testStatus {
                        Text(testStatus)
                            .font(p.uiFont(12))
                            .foregroundStyle(p.muted)
                    }
                }
            }
        }
    }

    private var notificationsBinding: Binding<Bool> {
        Binding(
            get: { model.notificationsEnabled },
            set: { on in
                if on {
                    Task {
                        let granted = await NotificationCoordinator.shared.requestPermission()
                        model.setNotificationsEnabled(granted)
                        if !granted {
                            model.error = "Notifications are blocked for Orcha — enable them in iOS Settings, then flip this back on."
                        }
                    }
                } else {
                    model.setNotificationsEnabled(false)
                }
            }
        )
    }

    // MARK: containers

    private var containersSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Containers", count: "\(model.containers.count)")
            ForEach(model.containers) { container in
                OrchaCard {
                    HStack(spacing: 10) {
                        AgentAvatar(alias: container.displayName)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(container.displayName)
                                .font(p.uiFont(14, .semibold))
                                .foregroundStyle(p.text)
                            Text(container.baseUrl)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(p.muted)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Disconnect") { model.forgetContainer(container.id) }
                            .font(p.uiFont(13, .semibold))
                            .foregroundStyle(p.danger)
                    }
                    HStack(spacing: 8) {
                        Image(systemName: "network")
                            .font(.system(size: 12))
                            .foregroundStyle(container.remoteBaseUrl == nil ? p.faint : p.accent)
                        if let remote = container.remoteBaseUrl, !remote.isEmpty {
                            Text(remote)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(p.text2)
                                .lineLimit(1)
                        } else {
                            Text("Local only")
                                .font(p.uiFont(12))
                                .foregroundStyle(p.faint)
                        }
                        Spacer()
                        Button(container.remoteBaseUrl == nil ? "Add remote…" : "Edit remote…") {
                            remoteDraft = container.remoteBaseUrl ?? ""
                            remoteError = nil
                            remoteEditing = container
                        }
                        .font(p.uiFont(12, .semibold))
                        .foregroundStyle(p.accent)
                    }
                }
            }
            Text("Remote access is optional: install Tailscale (free for personal use) on this iPhone and on the computer, then add the computer's Tailscale address here. The app uses it automatically whenever the local address doesn't answer — leave it empty to stay local-only.")
                .font(p.uiFont(12))
                .foregroundStyle(p.faint)
                .padding(.horizontal, 2)
        }
        .alert("Remote address (Tailscale)", isPresented: remoteAlertShown) {
            TextField("e.g. my-mac.tailnet.ts.net:8001", text: $remoteDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") { saveRemote() }
            Button("Remove", role: .destructive) {
                if let c = remoteEditing { model.setRemoteUrl(c.id, to: nil) }
                remoteEditing = nil
            }
            Button("Cancel", role: .cancel) { remoteEditing = nil }
        } message: {
            Text("The computer's Tailscale name or IP, with the portal port. Tried automatically when the local address is unreachable.")
        }
    }

    @State private var remoteEditing: StoredContainer?
    @State private var remoteDraft = ""
    @State private var remoteError: String?

    private var remoteAlertShown: Binding<Bool> {
        Binding(
            get: { remoteEditing != nil },
            set: { if !$0 { remoteEditing = nil } }
        )
    }

    private func saveRemote() {
        guard let container = remoteEditing else { return }
        defer { remoteEditing = nil }
        let draft = remoteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !draft.isEmpty else {
            model.setRemoteUrl(container.id, to: nil)
            return
        }
        if let normalized = try? OrchaServerAddress.parse(draft).baseUrl {
            model.setRemoteUrl(container.id, to: normalized)
            model.toast = "Remote address saved"
        } else {
            model.error = "That doesn't look like an address — try host:port, e.g. my-mac.tailnet.ts.net:8001."
        }
    }

    // MARK: about

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "About")
            OrchaCard {
                KVRow(key: "Version", value: "0.1.0")
                KVRow(key: "Project", value: "github.com/open-orcha/orcha", mono: true)
                MetaTag(text: "GH #30 · mobile companion")
            }
        }
    }
}
