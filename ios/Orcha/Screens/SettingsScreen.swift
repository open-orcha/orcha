import SwiftUI

/// Flow 04 S1 — Settings, grouped like the web portal's settings: Project
/// (General, Execution), Access (Members, Devices and pairing) and Personal
/// (Appearance, Notifications, Interface). Linear rows on panel cards, muted
/// caption headers, Embodent branding in the footer. Presented as a sheet.
struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @State private var showExecution = false
    @State private var showProjectIcon = false

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.xl) {
                        if model.selectedContainer != nil {
                            groupHeader("Project")
                            identitySection
                            executionSection
                            groupHeader("Access")
                            membersSection
                        } else {
                            groupHeader("Access")
                        }
                        containersSection
                        groupHeader("Personal")
                        planUsageSection
                        appearanceSection
                        notificationsSection
                        interfaceSection
                        aboutSection
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.l)
                }
                .background(p.bg)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.bg, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                if model.selectedContainer != nil { await model.loadMembers() }
            }
            .sheet(isPresented: $showExecution) {
                ContainerControlsSheet()
            }
            .sheet(isPresented: $showProjectIcon) {
                ProjectIconSheet()
            }
        }
    }

    /// The web's group label (PROJECT / ACCESS / PERSONAL) above its sections.
    private func groupHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .ltype(.micro)
            .fontWeight(.semibold)
            .tracking(0.6)
            .foregroundStyle(p.faint)
            .padding(.horizontal, 4)
            .padding(.bottom, -LSpace.m)
            .accessibilityAddTraits(.isHeader)
    }

    /// Hairline-separated rows on one panel card.
    private func rowsCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        LCard(padding: 0) {
            VStack(spacing: 0) { content() }
        }
    }

    private func chevron() -> some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(p.faint)
            .accessibilityHidden(true)
    }

    private func rowIcon(_ name: String, tint: Color? = nil) -> some View {
        Image(systemName: name)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(tint ?? p.text2)
            .frame(width: 26, height: 26)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(p.border, lineWidth: 1))
            .accessibilityHidden(true)
    }

    // MARK: Project → General (acting identity, collab v1)

    /// Who the deployment sees acting from this phone: the proxy-verified GitHub
    /// identity (avatar + login + role + grants), the honest "signed in but not a
    /// member" state, or — self-host, trust off — the paired human, unchanged.
    @ViewBuilder
    private var identitySection: some View {
        LSection("General") {
            rowsCard {
                if let identity = model.identity {
                    LRow(
                        title: identity.githubLogin.map { "@\($0)" } ?? identity.alias,
                        subtitle: "GitHub identity · verified by the deployment"
                    ) {
                        LAvatar(name: identity.githubLogin ?? identity.alias, size: 28)
                    } trailing: {
                        LTag(identity.memberRole, tint: identity.memberRole == "owner" ? p.violet : nil)
                    }
                    .accessibilityElement(children: .combine)
                    if !model.access.isOwner, !identity.grants.isEmpty {
                        LDivider()
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(identity.grants, id: \.self) { grant in
                                    LTag(grant.replacingOccurrences(of: "_", with: " "))
                                }
                            }
                            .padding(.horizontal, LSpace.m)
                            .padding(.vertical, LSpace.s)
                        }
                    }
                } else if model.identityTrusted {
                    Text("Signed in via GitHub, but not a member of this project — ask an owner for an invite.")
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                        .padding(LSpace.m)
                } else {
                    LRow(
                        title: model.selectedContainer?.humanAlias ?? "Paired human",
                        subtitle: "Self-hosted — acting as the paired human"
                    ) {
                        LAvatar(name: model.selectedContainer?.humanAlias ?? "H", size: 28)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let container = model.selectedContainer {
                    LDivider()
                    Button { showProjectIcon = true } label: {
                        LRow(title: "Project", subtitle: container.displayName) {
                            ProjectIconView(icon: model.projectIcon(for: container.id), size: 26)
                        } trailing: {
                            HStack(spacing: 6) {
                                Text("Icon")
                                chevron()
                            }
                        }
                    }
                    .buttonStyle(.lRow)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint(model.canEditProjectIcon ? "Change the project icon" : "View the project icon")
                }
            }
        }
    }

    // MARK: Project → Execution

    private var executionSection: some View {
        LSection("Execution") {
            rowsCard {
                Button { showExecution = true } label: {
                    LRow(title: "Notifier & autonomy", subtitle: "Pause agent wakes, choose how far agents go") {
                        rowIcon("bolt.horizontal", tint: executionTint)
                    } trailing: {
                        HStack(spacing: 6) {
                            Text(executionValue)
                            chevron()
                        }
                    }
                }
                .buttonStyle(.lRow)
                LDivider(inset: LSpace.m)
                NavigationLink {
                    OrchaThemed(mode: model.themeMode, skin: model.skinMode) { RoutinesScreen() }
                } label: {
                    LRow(title: "Routines", subtitle: "Tasks created on a schedule") {
                        rowIcon("repeat")
                    } trailing: {
                        chevron()
                    }
                }
                .buttonStyle(.lRow)
                LDivider(inset: LSpace.m)
                NavigationLink {
                    OrchaThemed(mode: model.themeMode, skin: model.skinMode) { ProjectBudgetLimitsScreen() }
                } label: {
                    LRow(title: "Budget & limits", subtitle: "Project monthly budget and agent limit") {
                        rowIcon("dollarsign.circle")
                    } trailing: {
                        chevron()
                    }
                }
                .buttonStyle(.lRow)
                LDivider(inset: LSpace.m)
                NavigationLink {
                    OrchaThemed(mode: model.themeMode, skin: model.skinMode) { AgentWorktreesScreen() }
                } label: {
                    LRow(title: "Agent worktrees", subtitle: "Automatic clean-up and grace period") {
                        rowIcon("arrow.triangle.branch")
                    } trailing: {
                        chevron()
                    }
                }
                .buttonStyle(.lRow)
            }
        }
    }

    private var executionValue: String {
        guard let c = model.snapshot?.container else { return "" }
        if (c.wakesEnabled ?? true) == false { return "Paused" }
        return MobileUx.autonomyLabel(c.autonomyLevel ?? "plan")
    }

    private var executionTint: Color {
        (model.snapshot?.container.wakesEnabled ?? true) ? p.ok : p.warn
    }

    // MARK: Personal → Plan usage

    private var planUsageSection: some View {
        LSection("Usage") {
            rowsCard {
                NavigationLink {
                    OrchaThemed(mode: model.themeMode, skin: model.skinMode) { PlanUsageScreen() }
                } label: {
                    LRow(title: "Plan usage", subtitle: "Claude and Codex limits from your desktop") {
                        rowIcon("gauge.with.dots.needle.33percent")
                    } trailing: {
                        HStack(spacing: 6) {
                            if let overall = PlanUsageUx.overallPercent(model.planUsage.providers) {
                                Text("\(overall)%").monospacedDigit()
                            }
                            chevron()
                        }
                    }
                }
                .buttonStyle(.lRow)
            }
        }
    }

    // MARK: Personal → Appearance

    private var appearanceSection: some View {
        LSection("Appearance") {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    LSegmented(
                        ThemeMode.allCases.map { ($0, $0 == .auto ? "System" : $0.label) },
                        selection: themeBinding
                    )
                    .accessibilityLabel("Theme")
                    Text("System follows your iPhone's setting. Changes apply instantly.")
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                    if model.prefsActive {
                        Text("Appearance follows your GitHub account — changes here sync to the portal and your other devices.")
                            .ltype(.micro)
                            .foregroundStyle(p.muted)
                    }
                }
            }
        }
    }

    // MARK: Personal → Interface

    private var interfaceSection: some View {
        LSection("Interface") {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    LSegmented(SkinMode.allCases.map { ($0, $0.label) }, selection: skinBinding)
                        .accessibilityLabel("Design")
                    Text(model.skinMode.blurb)
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                        .contentTransition(.opacity)
                }
            }
        }
    }

    // MARK: Access → Members (collab v1, read parity — no invite/role editing on iOS)

    @ViewBuilder
    private var membersSection: some View {
        switch model.membersState {
        case .idle:
            EmptyView()
        case .loading:
            LSection("Members") {
                SkeletonBlock(height: 104)
            }
        case let .failed(reason):
            LSection("Members") {
                LCard {
                    Text(reason)
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                }
            }
        case let .loaded(members, restricted):
            LSection("Members", count: restricted ? nil : members.count) {
                VStack(alignment: .leading, spacing: LSpace.s) {
                    rowsCard {
                        ForEach(Array(members.enumerated()), id: \.element.id) { index, member in
                            if index > 0 { LDivider() }
                            memberRow(member)
                        }
                    }
                    Text(restricted
                         ? "The roster is private on this project — you can see your own membership; owners see everyone."
                         : "Invites and role changes are managed from the portal.")
                        .ltype(.micro)
                        .foregroundStyle(p.muted)
                        .padding(.horizontal, 4)
                }
            }
        }
    }

    private func memberRow(_ member: MemberDto) -> some View {
        LRow(
            title: member.githubLogin.map { "@\($0)" } ?? member.alias,
            subtitle: (member.githubLogin != nil && member.alias != member.githubLogin) ? member.alias : nil
        ) {
            LAvatar(name: member.githubLogin ?? member.alias, size: 28)
        } trailing: {
            HStack(spacing: 6) {
                if member.pending { LTag("pending", tint: p.warn) }
                LTag(member.memberRole, tint: member.memberRole == "owner" ? p.violet : nil)
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

    // MARK: Personal → Notifications

    @State private var testStatus: String?

    private var notificationsSection: some View {
        LSection("Notifications") {
            rowsCard {
                Toggle(isOn: notificationsBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Needs-you alerts")
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                        Text("Background checks post an alert when a plan, verification, or request starts waiting on you — tapping opens that exact screen. iOS times the checks: expect minutes to an hour, not instant.")
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                    }
                }
                .tint(p.accent)
                .padding(LSpace.m)
                if model.notificationsEnabled {
                    LDivider()
                    HStack(spacing: LSpace.s) {
                        LButton("Send test alert", icon: "bell.badge", kind: .secondary, size: .small) {
                            Task { testStatus = await NotificationCoordinator.shared.sendTest(model: model) }
                        }
                        Text(testStatus ?? "Arrives in about 3 seconds")
                            .ltype(.micro)
                            .foregroundStyle(p.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(LSpace.m)
                }
                if model.selectedContainer != nil {
                    LDivider()
                    NavigationLink {
                        OrchaThemed(mode: model.themeMode, skin: model.skinMode) { NotificationPrefsScreen() }
                    } label: {
                        LRow(title: "Notification preferences", subtitle: "What you're notified about, pause, quiet hours") {
                            rowIcon("bell.badge")
                        } trailing: {
                            chevron()
                        }
                    }
                    .buttonStyle(.lRow)
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
                            model.error = "Notifications are blocked for Embodent — enable them in iOS Settings, then flip this back on."
                        }
                    }
                } else {
                    model.setNotificationsEnabled(false)
                }
            }
        )
    }

    // MARK: Access → Devices and pairing

    /// Projects paired from one server share its token, remote address and
    /// connection, so each server appears once with its projects listed.
    private var serverGroups: [ServerGroup] {
        var order: [String] = []
        var byBase: [String: [StoredContainer]] = [:]
        for container in model.containers {
            if byBase[container.baseUrl] == nil { order.append(container.baseUrl) }
            byBase[container.baseUrl, default: []].append(container)
        }
        return order.compactMap { base in
            byBase[base].flatMap { list in list.first.map { ServerGroup(primary: $0, projects: list) } }
        }
    }

    private var containersSection: some View {
        let groups = serverGroups
        return LSection("Devices and pairing", count: groups.count) {
            VStack(alignment: .leading, spacing: LSpace.s) {
                ForEach(groups) { group in
                    serverCard(group)
                }
                Text("Cloud deployments authenticate every request with the team access token — update it here when your admin rotates it; it applies to every project on that server. The remote address is for self-hosted boxes only: add the computer's Tailscale address and the app fails over to whichever answers.")
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
                    .padding(.horizontal, 4)
            }
        }
        .alert("Access token", isPresented: tokenAlertShown) {
            SecureField("Paste the team access token", text: $tokenDraft)
            Button("Save") { saveToken() }
            Button("Remove", role: .destructive) {
                if let c = tokenEditing { model.setAccessToken(c.id, to: nil) }
                tokenEditing = nil
            }
            Button("Cancel", role: .cancel) { tokenEditing = nil }
        } message: {
            Text("Sent as the bearer credential on every request to this Embodent, and applied to all its projects. Needed for cloud deployments; leave unset for an unprotected local server.")
        }
        .alert("Remote address (Tailscale)", isPresented: remoteAlertShown) {
            TextField("e.g. my-mac.tailnet.ts.net:8001", text: $remoteDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") { saveRemote() }
            Button("Remove", role: .destructive) {
                if let c = remoteEditing { setRemote(for: c, to: nil) }
                remoteEditing = nil
            }
            Button("Cancel", role: .cancel) { remoteEditing = nil }
        } message: {
            Text("The computer's Tailscale name or IP, with the portal port. Tried automatically when the local address is unreachable.")
        }
    }

    private func serverCard(_ group: ServerGroup) -> some View {
        let container = group.primary
        let remote = container.remoteBaseUrl.flatMap { $0.isEmpty ? nil : $0 }
        return rowsCard {
            LRow(title: group.title, subtitle: group.subtitle) {
                LAvatar(name: group.title, size: 28)
            } trailing: {
                Button("Disconnect", role: .destructive) { model.forgetContainer(container.id) }
                    .ltype(.meta)
                    .fontWeight(.medium)
                    .foregroundStyle(p.danger)
                    .frame(minHeight: 44)
            }
            LDivider()
            Button {
                tokenDraft = ""
                tokenEditing = container
            } label: {
                LRow(title: "Access token") {
                    rowIcon("key.horizontal", tint: container.accessToken == nil ? nil : p.accent)
                } trailing: {
                    HStack(spacing: 6) {
                        Text(container.accessToken == nil ? "Not set" : "Set")
                        chevron()
                    }
                }
            }
            .buttonStyle(.lRow)
            .accessibilityHint(container.accessToken == nil ? "Adds a token" : "Updates the token")
            LDivider()
            Button {
                remoteDraft = remote ?? ""
                remoteError = nil
                remoteEditing = container
            } label: {
                LRow(title: "Remote address") {
                    rowIcon("network", tint: remote == nil ? nil : p.accent)
                } trailing: {
                    HStack(spacing: 6) {
                        Text(remote ?? "None")
                            .monospaced(remote != nil)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        chevron()
                    }
                }
            }
            .buttonStyle(.lRow)
        }
    }

    /// Applies a remote address to every project paired from the same server.
    private func setRemote(for container: StoredContainer, to url: String?) {
        for sibling in model.containers where sibling.baseUrl == container.baseUrl {
            model.setRemoteUrl(sibling.id, to: url)
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
            setRemote(for: container, to: nil)
            return
        }
        if let normalized = try? OrchaServerAddress.parse(draft).baseUrl {
            setRemote(for: container, to: normalized)
            model.toast = "Remote address saved"
        } else {
            model.error = "That doesn't look like an address — try host:port, e.g. my-mac.tailnet.ts.net:8001."
        }
    }

    // MARK: about — Embodent branding

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(short) (\($0))" } ?? short
    }

    private var aboutSection: some View {
        VStack(spacing: LSpace.s) {
            BrandMark(size: 36)
                .accessibilityHidden(true)
            Text("Embodent")
                .ltype(.headline)
                .foregroundStyle(p.text)
            Text("Version \(appVersion)")
                .ltype(.micro)
                .monospacedDigit()
                .foregroundStyle(p.faint)
            Text("github.com/open-orcha/orcha")
                .ltype(.micro)
                .monospaced()
                .foregroundStyle(p.faint)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, LSpace.l)
        .accessibilityElement(children: .combine)
    }
}

/// One paired server and the projects stored from it.
private struct ServerGroup: Identifiable {
    let primary: StoredContainer
    let projects: [StoredContainer]

    var id: String { primary.baseUrl }

    /// A lone project keeps its own name; a shared server shows its address.
    var title: String {
        projects.count == 1 ? primary.displayName : primary.baseUrl
    }

    var subtitle: String {
        projects.count == 1
            ? primary.baseUrl
            : projects.map(\.displayName).joined(separator: ", ")
    }
}
