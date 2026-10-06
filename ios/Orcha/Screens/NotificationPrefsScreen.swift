import SwiftUI

/// Settings › Notifications › Notification preferences (web Settings › Notifications):
/// pause/snooze, mute this project, the category × channel rules for this project, and
/// quiet hours. This phone edits In-app and Mobile push; Desktop and Slack are shown
/// read-only. The budget in-app switch is locked on (server critical lock).
struct NotificationPrefsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    @State private var prefs: NotificationPrefsDto?
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var notice: String?
    @State private var saving = false
    @State private var showCustomPause = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.xl) {
                if let prefs {
                    loadedContent(prefs)
                } else if let loadError {
                    LEmptyState(icon: "bell.slash", title: "Couldn't load your notification settings", message: loadError, actionTitle: "Try again") {
                        Task { await load() }
                    }
                } else {
                    ProgressView("Loading…").frame(maxWidth: .infinity).padding(.top, LSpace.xl)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.l)
        }
        .background(p.bg)
        .navigationTitle("Notification preferences")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showCustomPause) {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                CustomPauseSheet { date in
                    Task { await setPause(NotifPause(until: date.timeIntervalSince1970.rounded()), note: "Notifications paused.") }
                }
            }
        }
    }

    @ViewBuilder
    private func loadedContent(_ prefs: NotificationPrefsDto) -> some View {
        if let saveError { Banner(kind: .danger, text: "Couldn't save — " + saveError) }
        if let notice { Banner(kind: .info, text: notice) }
        if !prefs.editable {
            Banner(kind: .warn, text: "Notification settings belong to members of this project.")
        }
        Group {
            pauseSection(prefs)
            muteSection(prefs)
            rulesSection(prefs)
            QuietHoursSection(current: prefs.defaults.quietHours, saving: saving) { qh in
                Task { await setQuietHours(qh) }
            }
        }
        .disabled(!prefs.editable || saving)
    }

    // MARK: pause

    private func pauseSection(_ prefs: NotificationPrefsDto) -> some View {
        LSection("Pause notifications") {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    if let text = NotificationPrefsUx.pauseText(prefs.defaults.pause) {
                        Label(text, systemImage: "moon.zzz")
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.warn)
                        LButton("Turn back on", icon: "bell", kind: .primary, size: .small) {
                            Task { await setPause(nil, note: "Notifications are back on.") }
                        }
                    } else {
                        Text("Everything is on.")
                            .ltype(.body)
                            .foregroundStyle(p.text2)
                        Text("Pause all notifications").ltype(.micro).foregroundStyle(p.muted)
                        FlowButtons {
                            ForEach(NotificationPrefsUx.PauseChoice.allCases) { choice in
                                LButton(choice.label, size: .small) {
                                    Task { await setPause(NotificationPrefsUx.pause(for: choice), note: "Notifications paused.") }
                                }
                            }
                            LButton("Custom…", size: .small) { showCustomPause = true }
                        }
                    }
                }
            }
        }
    }

    // MARK: mute

    private func muteSection(_ prefs: NotificationPrefsDto) -> some View {
        LSection("This project") {
            LCard {
                Toggle(isOn: Binding(
                    get: { prefs.project.muted },
                    set: { on in Task { await setMuted(on) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Mute this project").ltype(.bodyEmph).foregroundStyle(p.text)
                        Text("Muting only silences alerts. Anything that needs your decision still waits in Needs you.")
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                    }
                }
                .tint(p.accent)
            }
        }
    }

    // MARK: rules

    private func rulesSection(_ prefs: NotificationPrefsDto) -> some View {
        LSection(
            "Notification rules",
            trailing: prefs.project.stored ? AnyView(
                LButton("Use defaults", kind: .ghost, size: .small) { Task { await resetProject() } }
            ) : nil
        ) {
            VStack(alignment: .leading, spacing: LSpace.s) {
                Text(prefs.project.stored ? "This project has its own rules." : "This project follows your defaults.")
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
                    .padding(.horizontal, 4)
                ForEach(prefs.catalog.categories) { category in
                    CategoryRuleCard(
                        category: category,
                        prefs: prefs,
                        onScope: { scope in Task { await setRule(category.key, scope: scope) } },
                        onChannel: { channel, on in Task { await setRule(category.key, channel: channel, on: on) } }
                    )
                }
            }
        }
    }

    // MARK: writes

    private var ctx: (base: String, cid: String)? {
        model.selectedContainer.map { ($0.baseUrl, $0.id) }
    }

    private func load() async {
        guard let ctx else { return }
        do {
            prefs = try await model.api.notificationPrefs(ctx.base, ctx.cid, actor: model.humanId)
            loadError = nil
        } catch {
            loadError = InboxErrorText.describe(error)
        }
    }

    private func write(_ note: String?, _ op: (String, String) async throws -> NotificationPrefsDto) async {
        guard let ctx else { return }
        saving = true
        defer { saving = false }
        do {
            prefs = try await op(ctx.base, ctx.cid)
            saveError = nil
            notice = note
        } catch {
            saveError = InboxErrorText.describe(error)
            notice = nil
        }
    }

    private func setPause(_ pause: NotifPause?, note: String) async {
        await write(note) { base, cid in
            try await model.api.putDefaultNotificationPrefs(base, cid, actor: model.humanId, pause: .some(pause), quietHours: nil)
        }
    }

    private func setQuietHours(_ qh: NotifQuietHours?) async {
        await write(qh == nil ? "Quiet hours are off." : "Quiet hours saved.") { base, cid in
            try await model.api.putDefaultNotificationPrefs(base, cid, actor: model.humanId, pause: nil, quietHours: .some(qh))
        }
    }

    private func setMuted(_ muted: Bool) async {
        await write(muted ? "This project is muted." : "This project is unmuted.") { base, cid in
            try await model.api.putProjectNotificationPrefs(base, cid, actor: model.humanId, rules: nil, muted: muted)
        }
    }

    private func setRule(_ category: String, scope: String? = nil, channel: String? = nil, on: Bool? = nil) async {
        guard let current = prefs?.project.rules else { return }
        let rules = NotificationPrefsUx.projectRules(current, category: category, scope: scope, channel: channel, on: on)
        await write(nil) { base, cid in
            try await model.api.putProjectNotificationPrefs(base, cid, actor: model.humanId, rules: rules, muted: nil)
        }
    }

    private func resetProject() async {
        await write("This project follows your defaults again.") { base, cid in
            try await model.api.resetProjectNotificationPrefs(base, cid, actor: model.humanId)
        }
    }
}

/// One category: label + description, the scope picker, and its channel switches.
private struct CategoryRuleCard: View {
    @Environment(\.palette) private var p
    let category: NotifCategory
    let prefs: NotificationPrefsDto
    let onScope: (String) -> Void
    let onChannel: (String, Bool) -> Void

    private var rule: NotifRule? { prefs.effective.rules[category.key] }

    var body: some View {
        LCard {
            VStack(alignment: .leading, spacing: LSpace.s) {
                Text(category.label).ltype(.bodyEmph).foregroundStyle(p.text)
                if let d = category.description {
                    Text(d).ltype(.meta).foregroundStyle(p.muted)
                }
                Picker("Notify me about", selection: Binding(
                    get: { rule?.scope ?? "all" },
                    set: { onScope($0) }
                )) {
                    ForEach(prefs.catalog.scopes, id: \.key) { s in
                        Text(s.label).tag(s.key)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Notify me about \(category.label)")

                let off = rule?.scope == "off"
                ForEach(prefs.catalog.channels) { channel in
                    channelRow(channel, off: off)
                }
            }
        }
    }

    @ViewBuilder
    private func channelRow(_ channel: NotifChannel, off: Bool) -> some View {
        let on = rule?.channels[channel.key] ?? false
        let lock = NotificationPrefsUx.lockReason(prefs.catalog, category: category.key, channel: channel.key)
        let availability = prefs.channels[channel.key]
        let unavailable = availability?.available == false
        let editableHere = NotificationPrefsUx.deviceChannels.contains(channel.key)

        if let lock {
            HStack {
                Text(channel.label).ltype(.meta).foregroundStyle(p.text2)
                Spacer()
                Label("Always on", systemImage: "lock.fill")
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
            .accessibilityHint(lock)
        } else if editableHere {
            Toggle(isOn: Binding(get: { on }, set: { onChannel(channel.key, $0) })) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(channel.label).ltype(.meta).foregroundStyle(p.text2)
                    if unavailable, let reason = availability?.reason {
                        Text(reason).ltype(.micro).foregroundStyle(p.faint)
                    } else if off {
                        Text("Turn this category on first").ltype(.micro).foregroundStyle(p.faint)
                    }
                }
            }
            .tint(p.accent)
            .disabled(off)
            .frame(minHeight: 44)
        } else {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(channel.label).ltype(.meta).foregroundStyle(p.text2)
                    Text(unavailable ? (availability?.reason ?? "Not available") : "Change this on the web")
                        .ltype(.micro)
                        .foregroundStyle(p.faint)
                }
                Spacer()
                Text(on && !off ? "On" : "Off").ltype(.micro).foregroundStyle(p.muted)
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        }
    }
}

/// Quiet hours: on/off, from–to, time zone. Edits save with an explicit button.
private struct QuietHoursSection: View {
    @Environment(\.palette) private var p
    let current: NotifQuietHours?
    let saving: Bool
    let onSave: (NotifQuietHours?) -> Void

    @State private var enabled = false
    @State private var start = 22 * 60
    @State private var end = 8 * 60
    @State private var tz = TimeZone.current.identifier

    private var draft: NotifQuietHours {
        NotifQuietHours(start: NotificationPrefsUx.hhmm(start), end: NotificationPrefsUx.hhmm(end), tz: tz)
    }

    private var dirty: Bool { enabled && draft != current }

    var body: some View {
        LSection("Quiet hours") {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    Toggle(isOn: Binding(get: { enabled }, set: { on in
                        enabled = on
                        if !on, current != nil { onSave(nil) }
                    })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Quiet hours").ltype(.bodyEmph).foregroundStyle(p.text)
                            Text("Desktop, mobile and Slack stay silent (they are not sent later); the in-app bell keeps collecting.")
                                .ltype(.meta)
                                .foregroundStyle(p.muted)
                        }
                    }
                    .tint(p.accent)
                    if enabled {
                        DatePicker("Quiet hours start", selection: timeBinding($start), displayedComponents: .hourAndMinute)
                            .ltype(.meta)
                        DatePicker("Quiet hours end", selection: timeBinding($end), displayedComponents: .hourAndMinute)
                            .ltype(.meta)
                        Picker("Time zone", selection: $tz) {
                            ForEach(zones, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.navigationLink)
                        .ltype(.meta)
                        if dirty || (current == nil) {
                            LButton("Save quiet hours", icon: "checkmark", kind: .primary, size: .small) { onSave(draft) }
                                .disabled(saving || start == end)
                        }
                    }
                }
            }
        }
        .onAppear(perform: sync)
        .onChange(of: current) { sync() }
    }

    private var zones: [String] {
        var list = TimeZone.knownTimeZoneIdentifiers
        if !list.contains(tz) { list.insert(tz, at: 0) }
        return list
    }

    private func sync() {
        enabled = current != nil
        if let current {
            start = NotificationPrefsUx.minutes(current.start) ?? start
            end = NotificationPrefsUx.minutes(current.end) ?? end
            tz = current.tz
        }
    }

    private func timeBinding(_ minutes: Binding<Int>) -> Binding<Date> {
        Binding(
            get: { Calendar.current.startOfDay(for: Date()).addingTimeInterval(TimeInterval(minutes.wrappedValue * 60)) },
            set: { date in
                let c = Calendar.current.dateComponents([.hour, .minute], from: date)
                minutes.wrappedValue = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            }
        )
    }
}

/// "Custom…" snooze: pick when notifications come back on.
private struct CustomPauseSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var p
    let onPick: (Date) -> Void
    @State private var until = Date().addingTimeInterval(3 * 3600)

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: LSpace.l) {
                DatePicker("Pause until", selection: $until, in: Date().addingTimeInterval(60)..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
                LButton("Pause notifications", icon: "moon.zzz", kind: .primary) {
                    onPick(until)
                    dismiss()
                }
                Spacer()
            }
            .padding(LSpace.l)
            .background(p.bg)
            .navigationTitle("Pause notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}

/// Wrapping row of small buttons.
private struct FlowButtons<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: LSpace.s) { content }
            VStack(alignment: .leading, spacing: LSpace.s) { content }
        }
    }
}
