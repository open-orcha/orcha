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
                AgentReportsToRow(agentId: agent.id, alias: agent.alias, retired: dead)
                if agent.kind == "ai" && !dead {
                    NavigationLink(value: WorkspaceRoute.converse(agent.id)) {
                        Label("Converse", systemImage: "bubble.left.and.text.bubble.right")
                            .ltype(.bodyEmph)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(LButtonStyle(kind: .primary))
                }
                nowSection(agent)
                if agent.kind == "ai" {
                    controls(agent)
                    AgentBudgetSection(agentId: agent.id, alias: agent.alias)
                    historyLink(agent)
                }
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
        let status = dead ? "retired" : (agent.status ?? agent.kind)
        return LCard(padding: LSpace.l) {
            HStack(spacing: LSpace.m) {
                if agent.kind == "human" {
                    AgentAvatar(alias: agent.alias, human: true, githubLogin: agent.githubLogin, size: 44)
                } else {
                    LAvatar(name: agent.alias, isAI: true, size: 44, status: status)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.alias).ltype(.title).foregroundStyle(p.text)
                    Text(humanSubtitle(agent))
                        .ltype(.meta).foregroundStyle(p.muted).lineLimit(1)
                }
                Spacer(minLength: LSpace.xs)
                AgentStatusCapsule(status: status)
            }
            HStack(spacing: LSpace.s) {
                if let m = agent.model { LTag(m, markModel: m) }
                Spacer()
                if let ago = MobileUx.agoLabel(agent.lastActive) {
                    Text("Active \(ago)").ltype(.micro).foregroundStyle(p.faint)
                }
            }
            .padding(.top, LSpace.s)
        }
        .opacity(dead ? 0.55 : 1)
        .accessibilityElement(children: .combine)
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
                LCard {
                    HStack(spacing: LSpace.s) {
                        LStatusGlyph(status: "in_progress")
                        Text(title ?? tid)
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.faint)
                            .accessibilityHidden(true)
                    }
                }
            }
            .buttonStyle(.plain)
            liveRunRow(liveRun)
            liveChanges(agent, liveRun)
        } else if let liveRun {
            SectionH(title: "Now")
            liveRunRow(liveRun)
            liveChanges(agent, liveRun)
        }
    }

    /// Live changes while the agent works — the running run's changed files.
    @ViewBuilder
    private func liveChanges(_ agent: AgentDto, _ run: RunDto?) -> some View {
        if let run {
            AgentLiveChangesSection(agentId: agent.id, runId: run.runId)
        }
    }

    /// Config history ("History") — revisions with restore.
    private func historyLink(_ agent: AgentDto) -> some View {
        NavigationLink {
            AgentConfigHistoryScreen(agentId: agent.id, alias: agent.alias)
        } label: {
            LCard {
                HStack(spacing: LSpace.s) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(p.text2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("History").ltype(.bodyEmph).foregroundStyle(p.text)
                        Text("Every settings change, with restore").ltype(.meta).foregroundStyle(p.muted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(p.faint)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 32)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func liveRunRow(_ run: RunDto?) -> some View {
        if let run {
            NavigationLink(value: WorkspaceRoute.run(run)) {
                LCard {
                    HStack(spacing: LSpace.s) {
                        Image(systemName: "terminal")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(p.text2)
                            .accessibilityHidden(true)
                        Text(run.runId.prefix(6))
                            .ltype(.mono)
                            .foregroundStyle(p.text2)
                        LTag(ActivityCopy.humanize(run.wakeKind ?? "headless"))
                        Spacer()
                        Text("Live").ltype(.micro).foregroundStyle(p.accent)
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
                    tag: MetaTag(text: agent.model ?? "default", mono: true, markModel: agent.model),
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
                    Label("Agent actions", systemImage: "ellipsis.circle")
                        .labelStyle(.iconOnly)
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
        Dictionary(grouping: model.models) { m in
            let raw = m.runtime ?? m.provider
            return ModelProvider.for(raw ?? m.id)?.label ?? raw ?? "Other models"
        }
        .sorted { $0.key < $1.key }
    }

    private var canConfirm: Bool { picked != nil && picked != current && !model.actionInFlight }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        Text("Applies at the next wake.")
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                        ForEach(groups, id: \.0) { group, rows in
                            LSection(group, count: rows.count, markModel: group) {
                                LCard(padding: 0) {
                                    VStack(spacing: 0) {
                                        ForEach(rows) { m in
                                            if m.id != rows.first?.id { LDivider(inset: LSpace.m) }
                                            modelRow(m)
                                        }
                                    }
                                }
                            }
                        }
                        let name = model.models.first { $0.id == picked }.map { $0.name ?? $0.id }
                        LButton(
                            (picked != nil && picked != current) ? "Change to \(name ?? "model")" : "Pick a different model",
                            kind: .primary
                        ) {
                            if let picked { onConfirm(picked) }
                        }
                        .disabled(!canConfirm)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .padding(LSpace.l)
                }
                .background(p.bg)
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(p.bg)
        .onAppear { picked = current }
    }

    private func modelRow(_ m: ModelDto) -> some View {
        let isPicked = picked == m.id
        return Button { picked = m.id } label: {
            LRow(title: m.name ?? m.id, subtitle: m.id) {
                Image(systemName: isPicked ? "largecircle.fill.circle" : "circle")
                    .font(.body)
                    .foregroundStyle(isPicked ? p.accent : p.border2)
                    .accessibilityHidden(true)
            } trailing: {
                HStack(spacing: LSpace.s) {
                    if m.id == current { LTag("current") }
                    ModelProviderMark(model: m.runtime ?? m.provider ?? m.id)
                }
            }
        }
        .buttonStyle(.lRow)
        .accessibilityAddTraits(isPicked ? .isSelected : [])
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
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        Text("Wakes the agent on a clock while idle. Off relies on events only.")
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                        LSegmented(presets.map { ($0.1, $0.0) }, selection: $picked)
                        LButton("Apply", kind: .primary) { onConfirm(picked) }
                            .disabled(picked == current || model.actionInFlight)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .padding(LSpace.l)
                }
                .background(p.bg)
            }
            .navigationTitle("Auto-wake")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(p.bg)
        .onAppear { picked = current }
    }
}

// MARK: - Flow 10: Conversation

/// Linear live chat (web parity): your messages right-aligned in a subtle surface
/// bubble; agent turns full-width with rendered markdown, a "Worked for …" line and a
/// compact work-log row; a shimmering live "Working…" row; a composer pinned to the
/// bottom; auto-scroll with a "New messages" pill when you've scrolled up.
struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let agentId: String

    @State private var draft = ""
    @State private var confirmEnd = false
    /// Issue 4 — client-side reveal window over the already-fetched turns (web parity:
    /// start at the last 10, +20 per "Load earlier" tap). No refetch; the fetch window is 80.
    @State private var revealed = 10
    private static let revealStep = 20
    /// GH #140 — a tapped task-id link pushes onto the tab's NavigationStack.
    @State private var linkedTaskId: String?
    /// Portal-link chips in a message (task / request / agent / GitHub) push here.
    @State private var portalRoute: WorkspaceRoute?
    @Environment(\.openURL) private var openURL
    /// Whether the bottom sentinel is on screen — drives auto-scroll vs the "New messages" pill.
    @State private var atBottom = true
    @State private var hasUnseen = false
    /// Set once the first `loadConversation` for this screen finishes — the empty state
    /// (and its hint chips) only shows after that, so it never flashes over loading turns.
    @State private var hasLoaded = false
    /// Live chat streaming: follows the agent's running run over SSE while a reply is due.
    @State private var stream = ChatRunStream()

    private var agent: AgentDto? {
        model.snapshot?.agents.first { $0.id == agentId }
    }
    private var alias: String { agent?.alias ?? "the agent" }
    private var working: Bool { agent?.status == "working" }
    private let hints = ["What are you working on?", "Any blockers?", "Status update, please"]

    var body: some View {
        // Issue 2: composer pinned via `.safeAreaInset(edge: .bottom)` so SwiftUI lifts it
        // directly above the keyboard and shrinks the scroll area. The "working" strip is a
        // top inset so it never scrolls away.
        transcript
            .background(p.bg)
            .safeAreaInset(edge: .top, spacing: 0) { workingStrip }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .navigationTitle(agent?.alias ?? "Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        ModelProviderMark(model: agent?.model)
                        Text(agent?.alias ?? "Conversation")
                            .font(p.uiFont(15, .semibold))
                            .foregroundStyle(p.text)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("End conversation", role: .destructive) { confirmEnd = true }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                            .labelStyle(.iconOnly)
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
            .portalLinkNavigation($portalRoute)
            .task {
                await model.loadConversation(agentId)
                hasLoaded = true
            }
            .task(id: streamActive) {
                guard streamActive else { return }
                await stream.follow(model: model, agentId: agentId)
            }
    }

    /// A reply is in flight (just sent) or the agent is working: stream its run.
    private var streamActive: Bool {
        model.sendFlow.showsAwaitingReply || working
    }

    // MARK: working strip (top inset)

    @ViewBuilder
    private var workingStrip: some View {
        if working, agent?.currentTask != nil {
            HStack(spacing: LSpace.s) {
                LStatusGlyph(status: "in_progress", size: 12)
                Text("\(agent?.alias ?? "The agent") is on a task — your message queues.")
                    .ltype(.meta)
                    .foregroundStyle(p.text2)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.s)
            .background(p.bg)
            .overlay(alignment: .bottom) { LDivider() }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    // Issue 4: "Load earlier" widens the reveal window over the already-fetched
                    // turns (no refetch); it changes only the TOP, so it must not scroll to bottom.
                    if model.turns.count > revealed {
                        LButton("Load earlier messages", icon: "arrow.up", kind: .ghost, size: .small) {
                            revealed += Self.revealStep
                        }
                        .frame(maxWidth: .infinity)
                    }
                    if model.turns.isEmpty {
                        if hasLoaded {
                            emptyConversation
                        } else {
                            ProgressView()
                                .controlSize(.small)
                                .frame(maxWidth: .infinity, minHeight: 120)
                                .accessibilityLabel("Loading conversation")
                        }
                    }
                    turnRows
                    if model.sendFlow.showsPendingBubble {
                        pendingBubble
                            .transition(insertion)
                    }
                    // One status row at a time: awaiting-reply (just sent) is the most
                    // specific, then the overdue note, then the ambient "working" pulse.
                    if model.sendFlow.showsAwaitingReply {
                        LiveWorkingRow(alias: agent?.alias ?? "Agent", text: stream.headline ?? awaitingReplyCopy)
                            .transition(insertion)
                        ChatLiveSteps(rows: stream.rows)
                    } else if model.sendFlow.showsOverdueNote {
                        Text("No reply yet — \(alias) may still be starting up. Pull down to refresh.")
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                    } else if working {
                        LiveWorkingRow(alias: agent?.alias ?? "Agent", text: stream.headline ?? "Working…")
                            .transition(insertion)
                        ChatLiveSteps(rows: stream.rows)
                    }
                    if let error = model.error {
                        Banner(kind: .danger, text: error)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                        .onAppear { atBottom = true; hasUnseen = false }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, LSpace.l)
                .padding(.vertical, LSpace.l)
                .lAnimation(.lSpring, value: model.turns.last?.seq)
                .lAnimation(.lSpring, value: model.sendFlow.phase)
            }
            .scrollDismissesKeyboard(.interactively)
            .overlay(alignment: .bottom) {
                if hasUnseen {
                    NewMessagesPill { scrollToBottom(proxy) }
                        .padding(.bottom, LSpace.m)
                        .transition(.opacity.combined(with: .scale(scale: 0.92)))
                }
            }
            .lAnimation(.lQuick, value: hasUnseen)
            // Scroll to bottom on a NEW/sent turn (newest seq changes) when already at the
            // bottom or when it's yours; otherwise surface the "New messages" pill. Also on
            // any send-flow step and when the keyboard opens — never on a "Load earlier" reveal.
            .onChange(of: model.turns.last?.seq) {
                let mine = model.turns.last.map(isMine) ?? false
                if atBottom || mine {
                    scrollToBottom(proxy)
                } else {
                    hasUnseen = true
                }
            }
            .onChange(of: model.sendFlow.phase) { scrollToBottom(proxy) }
            // Streamed steps grow the live row without a new turn: stay pinned if at bottom.
            .onChange(of: stream.rows) { if atBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                scrollToBottom(proxy)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .refreshable { await model.refreshConversationDelta(agentId) }
        }
    }

    private var insertion: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .move(edge: .bottom).combined(with: .opacity),
            removal: .opacity
        )
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        hasUnseen = false
        if reduceMotion {
            proxy.scrollTo("bottom", anchor: .bottom)
        } else {
            withAnimation(.lSpring) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    @ViewBuilder
    private var emptyConversation: some View {
        LEmptyState(
            icon: "bubble.left.and.text.bubble.right",
            title: "No conversation yet",
            message: "Send a message to wake \(alias)."
        )
        // The hint chips feed the composer — hidden for read-only roles right along
        // with it (collab v1).
        if model.access.canWrite {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: LSpace.s) {
                    ForEach(hints, id: \.self) { hint in
                        LChip(hint, icon: "sparkles") { draft = hint }
                    }
                }
            }
        }
    }

    /// Turns as messages, with a `.system` day divider inserted at each new day.
    @ViewBuilder
    private var turnRows: some View {
        let humanId = model.humanId
        let rows = withDayDividers(Array(model.turns.suffix(revealed)), all: model.turns)
        ForEach(rows) { row in
            switch row {
            case let .day(label):
                Bubble(.system, label)
                    .accessibilityAddTraits(.isHeader)
            case let .turn(turn, workedFor):
                turnBubble(turn, humanId: humanId, workedFor: workedFor)
                    .transition(insertion)
            }
        }
    }

    private func isMine(_ turn: TurnDto) -> Bool {
        turn.authorAgentId == model.humanId || turn.role == "human"
    }

    @ViewBuilder
    private func turnBubble(_ turn: TurnDto, humanId: String?, workedFor: String?) -> some View {
        let mine = turn.authorAgentId == humanId || turn.role == "human"
        let tasks = model.snapshot?.tasks ?? []
        let author = agent?.alias ?? "agent"
        if turn.role == "system" {
            Bubble(.system, turn.content, tasks: tasks, onTapTask: { linkedTaskId = $0 }, portalBase: model.portalBase, onTapPortal: openPortal)
        } else if mine {
            Bubble(.mine, turn.content, time: MobileUx.agoLabel(turn.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 }, portalBase: model.portalBase, onTapPortal: openPortal)
        } else if ChatSendFlow.isBlankReply(turn.content) {
            // A blank agent turn (the session restarted mid-reply and no output was
            // captured) must never render as an empty message — show a muted notice.
            EmptyReplyNotice(
                alias: author,
                time: MobileUx.agoLabel(turn.createdAt),
                runRoute: turn.runId.map(workLogRoute)
            )
        } else {
            // Web parity: agent turn content renders as chat-scale markdown
            // (headings, bold/italic, code, lists, links, rules).
            Bubble(.theirs, turn.content, author: author, time: MobileUx.agoLabel(turn.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 }, markdown: true, portalBase: model.portalBase, onTapPortal: openPortal) {
                TurnFooter(workedFor: workedFor, runRoute: turn.runId.map(workLogRoute))
            }
        }
    }

    private func openPortal(_ link: PortalLink) {
        switch model.portalDestination(link) {
        case let .route(route): portalRoute = route
        case let .browser(url): openURL(url)
        case .none: break
        }
    }

    private func workLogRoute(_ runId: String) -> WorkspaceRoute {
        .run(RunDto(runId: runId, agentId: agentId, agentAlias: agent?.alias ?? "agent", status: "exited"))
    }

    // MARK: optimistic send (pending bubble + awaiting-reply copy)

    private var awaitingReplyCopy: String {
        model.sendFlow.isFirstTurn
            ? "Starting \(alias)'s session — the first reply can take a minute."
            : "Waking…"
    }

    /// The composed message, rendered the moment the send begins: "Sending…" while the
    /// POST is in flight (and until the poll echoes the real turn back — which then
    /// replaces this bubble), or "Not sent — tap to retry" when the POST failed. Never both
    /// this and the echoed turn: `ChatSendFlow.observe` dedupes by content + seq recency.
    private var pendingBubble: some View {
        let flow = model.sendFlow
        return Bubble(.mine, flow.content, trailing: {
            if flow.isFailed {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Not sent — tap to retry", systemImage: "exclamationmark.circle")
                        .ltype(.micro)
                        .foregroundStyle(p.danger)
                    if let reason = flow.failureReason {
                        Text(reason)
                            .ltype(.micro)
                            .foregroundStyle(p.muted)
                    }
                }
                .padding(.top, 2)
            } else {
                Text("Sending…")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
            }
        })
        .opacity(flow.isFailed ? 1 : 0.7)
        .contentShape(Rectangle())
        .onTapGesture(perform: restoreFailedSend)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            flow.isFailed
                ? "Message not sent: \(flow.content)"
                : "Sending message: \(flow.content)"
        )
        .accessibilityHint(flow.isFailed ? "Double-tap to restore the message so you can send it again." : "")
        .accessibilityAddTraits(flow.isFailed ? .isButton : [])
    }

    private func restoreFailedSend() {
        guard model.sendFlow.isFailed, let restored = model.takeFailedSendContent() else { return }
        draft = draft.isEmpty ? restored : restored + "\n\n" + draft
    }

    // MARK: composer

    /// Collab v1: a read-only role (viewer / trusted non-member) gets the honest
    /// note instead of the composer — the server would 403 the turn anyway.
    @ViewBuilder
    private var composer: some View {
        if let reason = model.access.writeDenialReason {
            HStack(spacing: LSpace.s) {
                Image(systemName: "lock")
                    .foregroundStyle(p.muted)
                    .accessibilityHidden(true)
                Text(reason)
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
            .background(p.bg)
            .overlay(alignment: .top) { LDivider() }
        } else {
            ChatComposer(
                draft: $draft,
                placeholder: "Message \(alias)…",
                canSend: canSend,
                isSending: model.sendFlow.isSending,
                onSend: send
            )
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        Task { await model.sendTurn(agentId, content: text) }
    }

    /// Send gate: non-empty draft, no global action in flight, and the send machine
    /// allows re-entry (never mid-POST, never over an unretried failed bubble).
    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.actionInFlight
            && model.sendFlow.canBegin
    }

    // MARK: day dividers + "worked for"

    private enum ChatRow: Identifiable {
        case day(String)
        case turn(TurnDto, workedFor: String?)

        var id: String {
            switch self {
            case let .day(label): "day-\(label)"
            case let .turn(t, _): t.id ?? "seq-\(t.seq)"
            }
        }
    }

    /// Insert a `.day` row whenever the calendar day changes, and attach a "Worked for …"
    /// label to each agent reply (time since the human turn it answers, from `all`).
    private func withDayDividers(_ turns: [TurnDto], all: [TurnDto]) -> [ChatRow] {
        var lastHumanAt: [Int: Date] = [:]
        var latestHuman: Date?
        for turn in all {
            if isMine(turn) { latestHuman = MobileUx.parseInstant(turn.createdAt) }
            else if let latestHuman { lastHumanAt[turn.seq] = latestHuman }
            if !isMine(turn), turn.role != "system" { latestHuman = nil }
        }
        var rows: [ChatRow] = []
        var lastDay: String?
        for turn in turns {
            if let day = MobileUx.dayKey(turn.createdAt), day != lastDay {
                lastDay = day
                rows.append(.day(MobileUx.dayLabel(turn.createdAt) ?? day))
            }
            var worked: String?
            if let start = lastHumanAt[turn.seq], let end = MobileUx.parseInstant(turn.createdAt) {
                worked = Self.workedForLabel(end.timeIntervalSince(start))
            }
            rows.append(.turn(turn, workedFor: worked))
        }
        return rows
    }

    /// "Worked for 47 sec" / "Worked for 3 min" — nil for non-positive or > 2h gaps
    /// (a reply that late isn't an honest "work" span).
    private static func workedForLabel(_ secs: TimeInterval) -> String? {
        guard secs >= 1, secs < 7200 else { return nil }
        let s = Int(secs.rounded())
        if s < 60 { return "Worked for \(s) sec" }
        let m = s / 60
        return m < 60 ? "Worked for \(m) min" : "Worked for \(m / 60) h \(m % 60) min"
    }
}

// MARK: - Conversation pieces

/// Compact footer under an agent turn: "Worked for …" + a work-log row.
private struct TurnFooter: View {
    @Environment(\.palette) private var p
    let workedFor: String?
    let runRoute: WorkspaceRoute?

    var body: some View {
        if workedFor != nil || runRoute != nil {
            HStack(spacing: LSpace.s) {
                if let workedFor {
                    Label(workedFor, systemImage: "clock")
                        .labelStyle(CompactLabelStyle())
                        .ltype(.micro)
                        .foregroundStyle(p.faint)
                }
                if let runRoute {
                    WorkLogRow(route: runRoute)
                }
            }
            .padding(.top, 2)
        }
    }
}

/// The run-log link as a compact tool-summary row ("Work log ›").
private struct WorkLogRow: View {
    @Environment(\.palette) private var p
    let route: WorkspaceRoute

    var body: some View {
        NavigationLink(value: route) {
            HStack(spacing: 5) {
                Image(systemName: "terminal")
                    .font(.system(size: 10, weight: .semibold))
                    .accessibilityHidden(true)
                Text("Work log")
                    .ltype(.micro)
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .bold))
                    .accessibilityHidden(true)
            }
            .foregroundStyle(p.text2)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(p.surface, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(p.border, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open work log")
    }
}

private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.imageScale(.small).accessibilityHidden(true)
            configuration.title
        }
    }
}

/// The agent-side muted notice replacing a blank agent reply.
private struct EmptyReplyNotice: View {
    @Environment(\.palette) private var p
    let alias: String
    let time: String?
    let runRoute: WorkspaceRoute?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                LAvatar(name: alias, isAI: true, size: 20)
                    .accessibilityHidden(true)
                Text(alias).ltype(.bodyEmph).foregroundStyle(p.text)
                if let time { Text(time).ltype(.micro).foregroundStyle(p.faint) }
            }
            Text("No reply captured — \(alias)'s session may have restarted.")
                .ltype(.meta)
                .foregroundStyle(p.muted)
            if let runRoute { WorkLogRow(route: runRoute) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The live agent row: avatar, name and a shimmering "Working…" line with a gently
/// pulsing dot. Reduce Motion renders it static; VoiceOver reads the text as-is.
private struct LiveWorkingRow: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let alias: String
    let text: String
    @State private var phase: CGFloat = -1
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                LAvatar(name: alias, isAI: true, size: 20, status: "working")
                    .accessibilityHidden(true)
                Text(alias).ltype(.bodyEmph).foregroundStyle(p.text)
            }
            HStack(spacing: LSpace.s) {
                Circle()
                    .fill(p.accent)
                    .frame(width: 7, height: 7)
                    .scaleEffect(!reduceMotion && pulse ? 1.35 : 1)
                    .opacity(!reduceMotion && pulse ? 0.45 : 1)
                    .accessibilityHidden(true)
                Text(text)
                    .ltype(.body)
                    .foregroundStyle(p.muted)
                    .overlay { shimmer.mask(Text(text).ltype(.body)) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .onAppear(perform: start)
    }

    /// A soft highlight band sweeping across the text (the "streaming" feel).
    @ViewBuilder
    private var shimmer: some View {
        if !reduceMotion {
            GeometryReader { geo in
                LinearGradient(
                    colors: [.clear, p.text.opacity(0.9), .clear],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(width: geo.size.width * 0.5)
                .offset(x: phase * geo.size.width)
            }
            .allowsHitTesting(false)
        }
    }

    private func start() {
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { pulse = true }
        withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1.5 }
    }
}

/// Floating "New messages ↓" pill shown when a reply lands while you're scrolled up.
private struct NewMessagesPill: View {
    @Environment(\.palette) private var p
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 11, weight: .bold))
                    .accessibilityHidden(true)
                Text("New messages").ltype(.meta).fontWeight(.medium)
            }
            .foregroundStyle(p.lPrimaryText)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(p.lPrimaryFill, in: Capsule())
            .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Scrolls to the newest message")
    }
}

/// Composer pinned to the bottom: a rounded surface holding the growing field,
/// dictation mic and the send button.
private struct ChatComposer: View {
    @Environment(\.palette) private var p
    @Binding var draft: String
    let placeholder: String
    let canSend: Bool
    let isSending: Bool
    let onSend: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: LSpace.xs) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .ltype(.body)
                .foregroundStyle(p.text)
                .lineLimit(1...6)
                .focused($focused)
                .accessibilityLabel("Message")
                .accessibilityHint(placeholder)
                .padding(.leading, LSpace.m)
                .padding(.vertical, 10)
            DictationMicButton(text: $draft)
            Button(action: onSend) {
                Group {
                    if isSending {
                        ProgressView().tint(p.lPrimaryText).controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(canSend ? p.lPrimaryText : p.faint)
                    }
                }
                .frame(width: 30, height: 30)
                .background(canSend || isSending ? p.lPrimaryFill : p.surface3, in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(isSending ? "Sending" : "Send")
            .lAnimation(.lQuick, value: canSend)
        }
        .padding(.trailing, 2)
        .background(p.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(focused ? p.border2 : p.border, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .padding(.horizontal, LSpace.m)
        .padding(.top, LSpace.s)
        .padding(.bottom, LSpace.s)
        .background(p.bg)
        .overlay(alignment: .top) { LDivider() }
    }
}
