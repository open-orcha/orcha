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
                        identitySection
                        appearanceSection
                        notificationsSection
                        membersSection
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
            .task {
                if model.selectedContainer != nil { await model.loadMembers() }
            }
        }
    }

    // MARK: acting identity (collab v1)

    /// Who the deployment sees acting from this phone: the proxy-verified GitHub
    /// identity (avatar + login + role + grants), the honest "signed in but not a
    /// member" state, or — self-host, trust off — the paired human, unchanged.
    @ViewBuilder
    private var identitySection: some View {
        if model.selectedContainer != nil {
            VStack(alignment: .leading, spacing: 6) {
                SectionH(title: "Acting as")
                OrchaCard {
                    if let identity = model.identity {
                        HStack(spacing: 10) {
                            AgentAvatar(alias: identity.alias, human: true, githubLogin: identity.githubLogin)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(identity.githubLogin.map { "@\($0)" } ?? identity.alias)
                                    .font(p.uiFont(15, .semibold))
                                    .foregroundStyle(p.text)
                                Text("GitHub identity · verified by the deployment")
                                    .font(p.uiFont(12))
                                    .foregroundStyle(p.muted)
                            }
                            Spacer()
                            MetaTag(text: identity.memberRole, tint: identity.memberRole == "owner" ? p.violet : nil)
                        }
                        if !model.access.isOwner, !identity.grants.isEmpty {
                            HStack(spacing: 6) {
                                ForEach(identity.grants, id: \.self) { grant in
                                    MetaTag(text: grant.replacingOccurrences(of: "_", with: " "))
                                }
                            }
                        }
                    } else if model.identityTrusted {
                        Text("Signed in via GitHub, but not a member of this project — ask an owner for an invite.")
                            .font(p.uiFont(13))
                            .foregroundStyle(p.muted)
                    } else {
                        HStack(spacing: 10) {
                            AgentAvatar(alias: model.selectedContainer?.humanAlias ?? "H", human: true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.selectedContainer?.humanAlias ?? "Paired human")
                                    .font(p.uiFont(15, .semibold))
                                    .foregroundStyle(p.text)
                                Text("Self-hosted — acting as the paired human")
                                    .font(p.uiFont(12))
                                    .foregroundStyle(p.muted)
                            }
                        }
                    }
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
            if model.prefsActive {
                Text("Appearance follows your GitHub account — changes here sync to the portal and your other devices.")
                    .font(p.uiFont(12))
                    .foregroundStyle(p.faint)
                    .padding(.horizontal, 2)
            }
        }
    }

    // MARK: members (collab v1, read parity — no invite/role editing on iOS)

    @ViewBuilder
    private var membersSection: some View {
        if model.selectedContainer != nil {
            VStack(alignment: .leading, spacing: 6) {
                switch model.membersState {
                case .idle:
                    EmptyView()
                case .loading:
                    SectionH(title: "Members")
                    SkeletonBlock(height: 64)
                case let .failed(reason):
                    SectionH(title: "Members")
                    OrchaCard {
                        Text(reason)
                            .font(p.uiFont(13))
                            .foregroundStyle(p.muted)
                    }
                case let .loaded(members, restricted):
                    SectionH(title: "Members", count: restricted ? nil : "\(members.count)")
                    ForEach(members) { member in
                        memberCard(member)
                    }
                    if restricted {
                        Text("The roster is private on this project — you can see your own membership; owners see everyone.")
                            .font(p.uiFont(12))
                            .foregroundStyle(p.faint)
                            .padding(.horizontal, 2)
                    } else {
                        Text("Invites and role changes are managed from the portal.")
                            .font(p.uiFont(12))
                            .foregroundStyle(p.faint)
                            .padding(.horizontal, 2)
                    }
                }
            }
        }
    }

    private func memberCard(_ member: MemberDto) -> some View {
        OrchaCard {
            HStack(spacing: 10) {
                AgentAvatar(alias: member.alias, human: true, githubLogin: member.githubLogin)
                VStack(alignment: .leading, spacing: 2) {
                    Text(member.githubLogin.map { "@\($0)" } ?? member.alias)
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                        .lineLimit(1)
                    if member.githubLogin != nil, member.alias != member.githubLogin {
                        Text(member.alias)
                            .font(p.uiFont(12))
                            .foregroundStyle(p.muted)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if member.pending {
                    MetaTag(text: "pending", tint: p.warn)
                }
                MetaTag(text: member.memberRole, tint: member.memberRole == "owner" ? p.violet : nil)
            }
        }
        .accessibilityElement(children: .combine)
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
                        Image(systemName: "key.horizontal")
                            .font(.system(size: 12))
                            .foregroundStyle(container.accessToken == nil ? p.faint : p.accent)
                        Text(container.accessToken == nil ? "No access token" : "Access token set")
                            .font(p.uiFont(12))
                            .foregroundStyle(container.accessToken == nil ? p.faint : p.text2)
                        Spacer()
                        Button(container.accessToken == nil ? "Add token…" : "Update token…") {
                            tokenDraft = ""
                            tokenEditing = container
                        }
                        .font(p.uiFont(12, .semibold))
                        .foregroundStyle(p.accent)
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
                            Text("No second address")
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
            Text("Cloud deployments authenticate every request with the team access token — update it here when your admin rotates it; it applies to every project at that address. The remote address is for self-hosted boxes only: add the computer's Tailscale address and the app fails over to whichever answers.")
                .font(p.uiFont(12))
                .foregroundStyle(p.faint)
                .padding(.horizontal, 2)
                .alert("Access token", isPresented: tokenAlertShown) {
                    SecureField("Paste the team access token", text: $tokenDraft)
                    Button("Save") { saveToken() }
                    Button("Remove", role: .destructive) {
                        if let c = tokenEditing { model.setAccessToken(c.id, to: nil) }
                        tokenEditing = nil
                    }
                    Button("Cancel", role: .cancel) { tokenEditing = nil }
                } message: {
                    Text("Sent as the bearer credential on every request to this Orcha, and applied to all its projects. Needed for cloud deployments; leave unset for an unprotected local server.")
                }
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
    @State private var tokenEditing: StoredContainer?
    @State private var tokenDraft = ""

    private var remoteAlertShown: Binding<Bool> {
        Binding(
            get: { remoteEditing != nil },
            set: { if !$0 { remoteEditing = nil } }
        )
    }

    private var tokenAlertShown: Binding<Bool> {
        Binding(
            get: { tokenEditing != nil },
            set: { if !$0 { tokenEditing = nil } }
        )
    }

    private func saveToken() {
        guard let container = tokenEditing else { return }
        defer { tokenEditing = nil }
        let draft = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !draft.isEmpty else { return }
        model.setAccessToken(container.id, to: draft)
        model.toast = "Access token saved"
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
