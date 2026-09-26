import SwiftUI
import UIKit   // UIResponder keyboard notifications (Issue 2 — scroll composer above keyboard)

/* =============================================================================
   Flow 09 — Agent detail (header, Now, Controls, persona, memory, requests, runs)
             + model / auto-wake pickers, rename alert, retire confirm.
   Flow 10 — Converse (honest presence, day dividers, bubbles, composer, end).
   Both are pushed screens; the parent tab owns the NavigationStack.
   ============================================================================= */

// MARK: - Flow 09: Agent detail

struct AgentDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String

    @State private var personaOpen = false
    @State private var showModelPicker = false
    @State private var showWakePicker = false
    @State private var renaming = false
    @State private var newAlias = ""
    @State private var confirmRetire = false

    private var agent: AgentDto? {
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

    private var dead: Bool {
        let agent = agent
        return agent?.status == "terminated" || agent?.terminatedAt != nil
    }

    // MARK: body

    private func content(_ agent: AgentDto) -> some View {
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

    // MARK: attention banners (flow 09 §1 — gate parity for this agent's tasks)

    @ViewBuilder
    private func attentionBanners(_ agent: AgentDto) -> some View {
        let gated = (model.snapshot?.tasks ?? []).filter { t in
            (t.assignees.contains(agent.alias) || t.ownerAlias == agent.alias) &&
            (t.status == "needs_verification" ||
                (t.status == "in_progress" && t.planMessage != nil && t.planDecision == nil))
        }
        ForEach(gated) { t in
            NavigationLink(value: WorkspaceRoute.task(t.id)) {
                Banner(
                    kind: t.status == "needs_verification" ? .info : .warn,
                    text: t.status == "needs_verification"
                        ? "Task awaiting your verification: \(t.title) — Open"
                        : "Plan awaiting your approval: \(t.title) — Open"
                )
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: header

    private func header(_ agent: AgentDto) -> some View {
        OrchaCard {
            HStack(spacing: 12) {
                AgentAvatar(alias: agent.alias, human: agent.kind == "human", githubLogin: agent.githubLogin, size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.alias).font(p.uiFont(20, .heavy)).foregroundStyle(p.text)
                    Text(humanSubtitle(agent))
                        .font(p.uiFont(13)).foregroundStyle(p.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                StatusPill(status: agent.status ?? agent.kind, domain: .agent)
            }
            HStack(spacing: 8) {
                if let m = agent.model { MetaTag(text: m, mono: true) }
                Spacer()
                Text(MobileUx.agoLabel(agent.lastActive) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.faint)
            }
        }
        .opacity(dead ? 0.55 : 1)
    }

    /// Collab v1 — a human member reads as their GitHub identity + role.
    private func humanSubtitle(_ agent: AgentDto) -> String {
        guard agent.kind == "human" else { return agent.role ?? "agent" }
        var parts: [String] = []
        if let login = agent.githubLogin { parts.append("@\(login)") }
        parts.append(agent.memberRole.map { $0.capitalized } ?? "Human authority")
        return parts.joined(separator: " · ")
    }

    // MARK: Now (flow 09 §4)

    private func nowTile(_ agent: AgentDto) -> (taskId: String?, title: String?, liveRun: RunDto?) {
        let activeRun = agent.activeRun
        let liveRun = activeRun.map { run in
            RunDto(
                runId: run.runId, agentId: agent.id, agentAlias: agent.alias,
                taskId: run.taskId, taskTitle: run.taskTitle,
                status: "running", wakeKind: run.wakeKind, wakeEvent: run.wakeEvent,
                startedAt: run.startedAt
            )
        }
        if let activeRun {
            return (activeRun.taskId, activeRun.taskTitle, liveRun)
        }
        return (agent.currentTask?.taskId, agent.currentTask?.title, liveRun)
    }

    @ViewBuilder
    private func nowSection(_ agent: AgentDto) -> some View {
        let (tid, title, liveRun) = nowTile(agent)
        if let tid {
            SectionH(title: "Now")
            NavigationLink(value: WorkspaceRoute.task(tid)) {
                OrchaCard {
                    HStack(spacing: 8) {
                        Text("▸").font(p.uiFont(15, .heavy)).foregroundStyle(p.accent)
                        Text(title ?? tid)
                            .font(p.uiFont(15, .semibold))
                            .foregroundStyle(p.text)
                            .lineLimit(2)
                    }
                }
            }
            .buttonStyle(.plain)
            liveRunRow(liveRun)
        } else if let liveRun {
            SectionH(title: "Now")
            liveRunRow(liveRun)
        }
    }

    @ViewBuilder
    private func liveRunRow(_ run: RunDto?) -> some View {
        if let run {
            NavigationLink(value: WorkspaceRoute.run(run)) {
                OrchaCard(borderColor: p.accentLine) {
                    HStack(spacing: 8) {
                        Text(run.runId.prefix(6))
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(p.text2)
                        StatusPill(status: "running", domain: .run)
                        MetaTag(text: run.wakeKind ?? "headless")
                        Spacer()
                        Text("streaming").font(p.uiFont(11, .bold)).foregroundStyle(p.accent)
                    }
                }
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: Controls (flow 09 §5 — human authority; AI only, disabled once retired)

    private func controls(_ agent: AgentDto) -> some View {
        // Collab v1: honest grant gating — the same gates the server enforces
        // (model/effort = manage_agents, auto-wake = manage_autonomy).
        let canAgents = model.access.canManage(Grant.manageAgents)
        let canAutonomy = model.access.canManage(Grant.manageAutonomy)
        return VStack(spacing: 10) {
            SectionH(title: "Controls", count: "human authority")
            OrchaCard {
                controlRow(
                    title: "Model", sub: canAgents ? "Applies at the next wake" : "Needs the 'manage agents' permission",
                    tag: MetaTag(text: agent.model ?? "default", mono: true),
                    enabled: !dead && canAgents
                ) { showModelPicker = true }
                controlRow(
                    title: "Auto-wake", sub: canAutonomy ? "Clock-driven wakes while idle" : "Needs the 'manage autonomy' permission",
                    tag: MetaTag(text: agent.autoWakeIntervalSecs.map(cadence) ?? "Off"),
                    enabled: !dead && canAutonomy
                ) { showWakePicker = true }
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Wake daemon").font(p.uiFont(15, .semibold)).foregroundStyle(p.text)
                        Text("Managed from the laptop").font(p.uiFont(13)).foregroundStyle(p.muted)
                    }
                    Spacer()
                    MetaTag(text: agent.wakeEnabled == false ? "off" : "on")
                }
            }
            .opacity(dead ? 0.55 : 1)
        }
    }

    @ViewBuilder
    private func controlRow(title: String, sub: String, tag: MetaTag, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: enabled ? action : {}) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(p.uiFont(15, .semibold)).foregroundStyle(p.text)
                    Text(sub).font(p.uiFont(13)).foregroundStyle(p.muted)
                }
                Spacer()
                tag
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    // MARK: Persona (flow 09 §6 — collapsed preview, expand to full system prompt)

    @ViewBuilder
    private func persona(_ agent: AgentDto) -> some View {
        let full = model.agentExtras.persona?.systemPrompt
        let preview = agent.promptPreview ?? full.map { String($0.prefix(160)) }
        if let preview, !preview.isEmpty {
            HStack {
                SectionH(title: "Persona")
                if let full, !full.isEmpty {
                    Button(personaOpen ? "collapse" : "expand") { personaOpen.toggle() }
                        .font(p.uiFont(11, .bold))
                        .foregroundStyle(p.accent)
                }
            }
            OrchaCard {
                if personaOpen, let full, !full.isEmpty {
                    Text(full)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(p.text2)
                } else {
                    Text(preview)
                        .font(p.uiFont(13))
                        .foregroundStyle(p.text2)
                        .lineLimit(2)
                }
            }
        }
    }

    // MARK: Memory (flow 09 §7 — digest FOCUS / DECISIONS / OPEN THREADS)

    @ViewBuilder
    private func memory() -> some View {
        if let d = model.agentExtras.digest {
            SectionH(title: "Memory", count: MobileUx.agoLabel(d.createdAt) ?? "")
            OrchaCard {
                if let focus = d.currentFocus, !focus.isEmpty {
                    Text("FOCUS").font(p.uiFont(11, .bold)).tracking(0.6).foregroundStyle(p.accent)
                    Text(focus).font(p.uiFont(13)).foregroundStyle(p.text)
                }
                if !d.decisions.isEmpty {
                    Text("DECISIONS · \(d.decisions.count)").font(p.uiFont(11, .bold)).tracking(0.6).foregroundStyle(p.muted)
                    ForEach(Array(d.decisions.prefix(3).enumerated()), id: \.offset) { _, item in
                        Text("• \(item.text)").font(p.uiFont(13)).foregroundStyle(p.text2)
                    }
                }
                if !d.openThreads.isEmpty {
                    Text("OPEN THREADS · \(d.openThreads.count)").font(p.uiFont(11, .bold)).tracking(0.6).foregroundStyle(p.muted)
                    ForEach(Array(d.openThreads.prefix(3).enumerated()), id: \.offset) { _, item in
                        Text("• \(item.text)").font(p.uiFont(13)).foregroundStyle(p.text2)
                    }
                }
            }
        }
    }

    // MARK: Requests summary (flow 09 §8)

    @ViewBuilder
    private func requestsSummary() -> some View {
        let extras = model.agentExtras
        if extras.inboxCount != nil || extras.outboxOpen != nil {
            SectionH(title: "Requests")
            OrchaCard {
                KVRow(key: "Incoming open", value: "\(extras.inboxCount ?? 0)")
                if let preview = extras.inboxPreview {
                    Text("“\(preview)”").font(p.uiFont(13)).foregroundStyle(p.muted).lineLimit(1)
                }
                KVRow(key: "Outgoing open / answered", value: "\(extras.outboxOpen ?? 0) / \(extras.outboxAnswered ?? 0)")
            }
        }
    }

    // MARK: Recent runs

    @ViewBuilder
    private func recentRuns(_ agent: AgentDto) -> some View {
        SectionH(title: "Recent runs", count: "\(model.agentRuns.count)")
        if model.agentRuns.isEmpty {
            OrchaCard { Text("No recent runs.").foregroundStyle(p.muted) }
        } else {
            ForEach(Array(model.agentRuns.prefix(5))) { run in
                let normalized = normalize(run, agent: agent)
                NavigationLink(value: WorkspaceRoute.run(normalized)) {
                    RunRowCard(run: normalized)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: toolbar (rename / retire — AI only, while alive)

    @ToolbarContentBuilder
    private var toolbarMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            // Collab v1: rename/retire are manage_agents writes — hidden when the
            // acting member doesn't hold the gate (server enforces regardless).
            if let agent, agent.kind == "ai", !dead, model.access.canManage(Grant.manageAgents) {
                Menu {
                    Button("Rename") { newAlias = agent.alias; renaming = true }
                    Button("Retire agent…", role: .destructive) { confirmRetire = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    private func cadence(_ secs: Int) -> String {
        secs < 3600 ? "Every \(secs / 60)m" : "Every \(secs / 3600)h"
    }

    /// Fill in agent identity on a run row (headless runs may omit it) so the row
    /// and the pushed run-log route both resolve the owning agent.
    private func normalize(_ run: RunDto, agent: AgentDto) -> RunDto {
        var r = run
        r.agentId = r.agentId ?? agent.id
        r.agentAlias = r.agentAlias ?? agent.alias
        return r
    }
}

/// A non-interactive KitButton-styled label — used inside a `NavigationLink` so the
/// whole primary "Converse" affordance pushes the conversation route.
private struct KitButtonLabel: View {
    @Environment(\.palette) private var p
    let title: String
    let role: KitButtonRole

    var body: some View {
        Text(title)
            .font(p.uiFont(15, .bold))
            .foregroundStyle(role == .primary ? p.accentInk : p.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .padding(.horizontal, 18)
            .background(role == .primary ? p.accent : p.accentSoft, in: RoundedRectangle(cornerRadius: 12))
    }
}

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
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("MODEL").font(p.uiFont(11, .bold)).tracking(0.8).foregroundStyle(p.accent)
                        Text("Applies at the next wake.").font(p.uiFont(13)).foregroundStyle(p.muted)
                        ForEach(groups, id: \.0) { group, rows in
                            SectionH(title: group)
                            ForEach(rows) { m in
                                Button { picked = m.id } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: picked == m.id ? "largecircle.fill.circle" : "circle")
                                            .foregroundStyle(picked == m.id ? p.accent : p.border2)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(m.name ?? m.id).font(p.uiFont(15, .semibold)).foregroundStyle(p.text)
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
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("AUTO-WAKE").font(p.uiFont(11, .bold)).tracking(0.8).foregroundStyle(p.accent)
                        Text("Wakes the agent on a clock while idle. Off relies on events only.")
                            .font(p.uiFont(13)).foregroundStyle(p.muted)
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

struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String

    @State private var draft = ""
    @State private var confirmEnd = false
    /// Issue 4 — client-side reveal window over the already-fetched turns (web parity:
    /// start at the last 10, +20 per "Load earlier" tap). No refetch; the fetch window is 80.
    @State private var revealed = 10
    private static let revealStep = 20
    /// GH #140 — a tapped task-id link pushes onto the tab's NavigationStack.
    @State private var linkedTaskId: String?

    private var agent: AgentDto? {
        model.snapshot?.agents.first { $0.id == agentId }
    }
    private var working: Bool { agent?.status == "working" }
    private let hints = ["What are you working on?", "Any blockers?", "Status update, please"]

    var body: some View {
        // Issue 2: composer pinned via `.safeAreaInset(edge: .bottom)` (like TaskThreadScreen)
        // so SwiftUI lifts it directly above the keyboard and shrinks the scroll area — no gap,
        // no obscured transcript. The "working" banner is a top inset so it never scrolls away.
        transcript
            .safeAreaInset(edge: .top, spacing: 0) { workingBanner }
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle(agent?.alias ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("End conversation", role: .destructive) { confirmEnd = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("End this conversation?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End conversation", role: .destructive) { Task { await model.endConversation(agentId) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(agent?.alias ?? "The agent") goes back to their own work. The transcript stays here.")
        }
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        .task { await model.loadConversation(agentId) }
    }

    // MARK: working banner (top inset)

    @ViewBuilder
    private var workingBanner: some View {
        if working, agent?.currentTask != nil {
            Banner(
                kind: .info,
                text: "\(agent?.alias ?? "The agent") is working on a task — your message queues."
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(p.bg)
        }
    }

    // MARK: transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    // Issue 4: "Load earlier" widens the reveal window over the already-fetched
                    // turns (no refetch); it changes only the TOP, so it must not scroll to bottom.
                    if model.turns.count > revealed {
                        Button { revealed += Self.revealStep } label: {
                            Text("Load earlier messages")
                                .font(p.uiFont(12, .bold))
                                .foregroundStyle(p.accent)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                    }
                    if model.turns.isEmpty {
                        OrchaCard {
                            Text("No conversation yet. Send a message to wake \(agent?.alias ?? "the agent").")
                                .foregroundStyle(p.muted)
                        }
                        // The hint chips feed the composer — hidden for read-only
                        // roles right along with it (collab v1).
                        if model.access.canWrite {
                            HStack(spacing: 8) {
                                ForEach(hints, id: \.self) { hint in
                                    PillChip(label: hint, selected: false) { draft = hint }
                                }
                            }
                        }
                    }
                    turnRows
                    if model.sendFlow.showsPendingBubble {
                        pendingBubble
                    }
                    // One status row at a time: awaiting-reply (just sent) is the most
                    // specific, then the overdue note, then the ambient "working" pulse.
                    if model.sendFlow.showsAwaitingReply {
                        PulsingNoteRow(text: awaitingReplyCopy)
                    } else if model.sendFlow.showsOverdueNote {
                        Text("No reply yet — \(agent?.alias ?? "the agent") may still be starting up. Pull down to refresh.")
                            .font(p.uiFont(13))
                            .foregroundStyle(p.muted)
                    } else if working {
                        PulsingNoteRow(text: "\(agent?.alias ?? "The agent") is working…")
                    }
                    if let error = model.error {
                        Banner(kind: .danger, text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            // Scroll to bottom on a NEW/sent turn (newest seq changes), on any send-flow
            // step (pending bubble / indicator appearing), or when the keyboard opens —
            // never on a "Load earlier" reveal (which only widens the top).
            .onChange(of: model.turns.last?.seq) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: model.sendFlow.phase) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .refreshable { await model.refreshConversationDelta(agentId) }
        }
    }

    /// Turns as bubbles, with a `.system` day-divider bubble inserted at each new day.
    @ViewBuilder
    private var turnRows: some View {
        let humanId = model.humanId
        let alias = agent?.alias ?? "agent"
        let rows = withDayDividers(Array(model.turns.suffix(revealed)))
        ForEach(rows) { row in
            switch row {
            case let .day(label):
                Bubble(.system, label)
            case let .turn(turn):
                turnBubble(turn, humanId: humanId, alias: alias)
            }
        }
    }

    @ViewBuilder
    private func turnBubble(_ turn: TurnDto, humanId: String?, alias: String) -> some View {
        let mine = turn.authorAgentId == humanId || turn.role == "human"
        let tasks = model.snapshot?.tasks ?? []
        if turn.role == "system" {
            Bubble(.system, turn.content, tasks: tasks, onTapTask: { linkedTaskId = $0 })
        } else if mine {
            Bubble(.mine, turn.content, time: MobileUx.agoLabel(turn.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 })
        } else if ChatSendFlow.isBlankReply(turn.content) {
            // A blank agent turn (the session restarted mid-reply and no output was
            // captured) must never render as an empty bubble — show a muted notice.
            emptyReplyNotice(turn, alias: alias)
        } else {
            // Web parity: agent turn content renders as chat-scale markdown
            // (headings, bold/italic, code, lists, links, rules).
            Bubble(.theirs, turn.content, author: alias, time: MobileUx.agoLabel(turn.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 }, markdown: true) {
                if let rid = turn.runId {
                    workLogLink(rid, alias: alias)
                }
            }
        }
    }

    /// The "theirs"-side muted notice replacing a blank agent bubble.
    private func emptyReplyNotice(_ turn: TurnDto, alias: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("No reply captured — \(alias)'s session may have restarted.")
                    .font(p.uiFont(12))
                    .foregroundStyle(p.muted)
                if let time = MobileUx.agoLabel(turn.createdAt) {
                    Text(time)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(p.faint)
                }
                if let rid = turn.runId {
                    workLogLink(rid, alias: alias)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(p.border2, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .allowsHitTesting(false)
            )
            Spacer(minLength: 60)
        }
    }

    /// The existing run-log link, shared by real replies and the blank-reply notice.
    private func workLogLink(_ runId: String, alias: String) -> some View {
        NavigationLink(value: WorkspaceRoute.run(RunDto(runId: runId, agentId: agentId, agentAlias: alias, status: "exited"))) {
            Text("Open work log →")
                .font(p.uiFont(11, .bold))
                .foregroundStyle(p.accent)
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
    }

    // MARK: optimistic send (pending bubble + awaiting-reply copy)

    private var awaitingReplyCopy: String {
        let alias = agent?.alias ?? "the agent"
        return model.sendFlow.isFirstTurn
            ? "Starting \(alias)'s session — the first reply can take a minute."
            : "\(alias) is waking…"
    }

    /// The composed message, rendered the moment the send begins: "sending…" while the
    /// POST is in flight (and until the poll echoes the real turn back — which then
    /// replaces this bubble), or "tap to retry" when the POST failed. Never both this
    /// and the echoed turn: `ChatSendFlow.observe` dedupes by content + seq recency.
    private var pendingBubble: some View {
        let flow = model.sendFlow
        return Bubble(.mine, flow.content) {
            if flow.isFailed {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Not sent — tap to retry")
                        .font(p.uiFont(11, .bold))
                    if let reason = flow.failureReason {
                        Text(reason)
                            .font(p.uiFont(10.5))
                            .opacity(0.75)
                    }
                }
                .foregroundStyle(p.accentInk)
                .padding(.top, 2)
            } else {
                Text("sending…")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.accentInk.opacity(0.55))
            }
        }
        .opacity(flow.isFailed ? 1 : 0.75)
        .contentShape(Rectangle())
        .onTapGesture {
            guard model.sendFlow.isFailed, let restored = model.takeFailedSendContent() else { return }
            draft = draft.isEmpty ? restored : restored + "\n\n" + draft
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            flow.isFailed
                ? "Message not sent: \(flow.content)"
                : "Sending message: \(flow.content)"
        )
        .accessibilityHint(flow.isFailed ? "Double-tap to restore the message so you can send it again." : "")
        .accessibilityAddTraits(flow.isFailed ? .isButton : [])
    }

    // MARK: composer

    /// Collab v1: a read-only role (viewer / trusted non-member) gets the honest
    /// note instead of the composer — the server would 403 the turn anyway.
    @ViewBuilder
    private var composer: some View {
        if let reason = model.access.writeDenialReason {
            Banner(kind: .info, text: reason)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(p.bg)
        } else {
            composerField
        }
    }

    private var composerField: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Chat with \(agent?.alias ?? "the agent")…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
            DictationMicButton(text: $draft)
            Button {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                draft = ""
                Task { await model.sendTurn(agentId, content: text) }
            } label: {
                Group {
                    if model.sendFlow.isSending {
                        ProgressView()
                            .tint(p.accentInk)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(p.uiFont(16, .semibold))
                            .foregroundStyle(p.accentInk)
                    }
                }
                .frame(width: 40, height: 40)
                .background(p.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .opacity(canSend || model.sendFlow.isSending ? 1 : 0.45)
            .disabled(!canSend)
            .accessibilityLabel(model.sendFlow.isSending ? "Sending" : "Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(p.bg)
    }

    /// Send gate: non-empty draft, no global action in flight, and the send machine
    /// allows re-entry (never mid-POST, never over an unretried failed bubble).
    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.actionInFlight
            && model.sendFlow.canBegin
    }

    // MARK: day dividers

    private enum ChatRow: Identifiable {
        case day(String)
        case turn(TurnDto)

        var id: String {
            switch self {
            case let .day(label): "day-\(label)"
            case let .turn(t): t.id ?? "seq-\(t.seq)"
            }
        }
    }

    /// Insert a `.day` row (a `.system` divider bubble) whenever the calendar day changes.
    private func withDayDividers(_ turns: [TurnDto]) -> [ChatRow] {
        var rows: [ChatRow] = []
        var lastDay: String?
        for turn in turns {
            if let day = MobileUx.dayKey(turn.createdAt), day != lastDay {
                lastDay = day
                rows.append(.day(MobileUx.dayLabel(turn.createdAt) ?? day))
            }
            rows.append(.turn(turn))
        }
        return rows
    }
}

/// A muted, gently pulsing status line under the transcript (awaiting-reply /
/// agent-working). Owns its pulse state so each appearance animates afresh;
/// Reduce Motion renders it static. VoiceOver reads the text as-is.
private struct PulsingNoteRow: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let text: String
    @State private var pulse = false

    var body: some View {
        Text(text)
            .font(p.uiFont(13))
            .foregroundStyle(p.muted)
            .opacity(!reduceMotion && pulse ? 0.4 : 1)
            .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulse)
            .onAppear { if !reduceMotion { pulse = true } }
    }
}
