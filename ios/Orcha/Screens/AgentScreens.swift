import SwiftUI

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
                AgentAvatar(alias: agent.alias, human: agent.kind == "human", size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.alias).font(.system(size: 20, weight: .heavy)).foregroundStyle(p.text)
                    Text(agent.role ?? (agent.kind == "human" ? "Human authority" : "agent"))
                        .font(.system(size: 13)).foregroundStyle(p.muted).lineLimit(1)
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

    // MARK: Now (flow 09 §4)

    @ViewBuilder
    private func nowSection(_ agent: AgentDto) -> some View {
        let liveRun = model.agentRuns.first { $0.status == "running" }
        if let tid = agent.currentTask?.taskId {
            SectionH(title: "Now")
            NavigationLink(value: WorkspaceRoute.task(tid)) {
                OrchaCard {
                    HStack(spacing: 8) {
                        Text("▸").font(.system(size: 15, weight: .heavy)).foregroundStyle(p.accent)
                        Text(agent.currentTask?.title ?? tid)
                            .font(.system(size: 15, weight: .semibold))
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
                        Text("streaming").font(.system(size: 11, weight: .bold)).foregroundStyle(p.accent)
                    }
                }
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: Controls (flow 09 §5 — human authority; AI only, disabled once retired)

    private func controls(_ agent: AgentDto) -> some View {
        VStack(spacing: 10) {
            SectionH(title: "Controls", count: "human authority")
            OrchaCard {
                controlRow(
                    title: "Model", sub: "Applies at the next wake",
                    tag: MetaTag(text: agent.model ?? "default", mono: true),
                    enabled: !dead
                ) { showModelPicker = true }
                controlRow(
                    title: "Auto-wake", sub: "Clock-driven wakes while idle",
                    tag: MetaTag(text: agent.autoWakeIntervalSecs.map(cadence) ?? "Off"),
                    enabled: !dead
                ) { showWakePicker = true }
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Wake daemon").font(.system(size: 15, weight: .semibold)).foregroundStyle(p.text)
                        Text("Managed from the laptop").font(.system(size: 13)).foregroundStyle(p.muted)
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
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(p.text)
                    Text(sub).font(.system(size: 13)).foregroundStyle(p.muted)
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
                        .font(.system(size: 11, weight: .bold))
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
                        .font(.system(size: 13))
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
                    Text("FOCUS").font(.system(size: 11, weight: .bold)).tracking(0.6).foregroundStyle(p.accent)
                    Text(focus).font(.system(size: 13)).foregroundStyle(p.text)
                }
                if !d.decisions.isEmpty {
                    Text("DECISIONS · \(d.decisions.count)").font(.system(size: 11, weight: .bold)).tracking(0.6).foregroundStyle(p.muted)
                    ForEach(Array(d.decisions.prefix(3).enumerated()), id: \.offset) { _, item in
                        Text("• \(item.text)").font(.system(size: 13)).foregroundStyle(p.text2)
                    }
                }
                if !d.openThreads.isEmpty {
                    Text("OPEN THREADS · \(d.openThreads.count)").font(.system(size: 11, weight: .bold)).tracking(0.6).foregroundStyle(p.muted)
                    ForEach(Array(d.openThreads.prefix(3).enumerated()), id: \.offset) { _, item in
                        Text("• \(item.text)").font(.system(size: 13)).foregroundStyle(p.text2)
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
                    Text("“\(preview)”").font(.system(size: 13)).foregroundStyle(p.muted).lineLimit(1)
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
            if let agent, agent.kind == "ai", !dead {
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
            .font(.system(size: 15, weight: .bold))
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

struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let agentId: String

    @State private var draft = ""
    @State private var confirmEnd = false
    @State private var pulse = false

    private var agent: AgentDto? {
        model.snapshot?.agents.first { $0.id == agentId }
    }
    private var working: Bool { agent?.status == "working" }
    private let hints = ["What are you working on?", "Any blockers?", "Status update, please"]

    var body: some View {
        VStack(spacing: 0) {
            if working, agent?.currentTask != nil {
                Banner(
                    kind: .info,
                    text: "\(agent?.alias ?? "The agent") is working on a task — your message queues."
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            transcript
            composer
        }
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
        .task { await model.loadConversation(agentId) }
    }

    // MARK: transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.turns.isEmpty {
                        OrchaCard {
                            Text("No conversation yet. Send a message to wake \(agent?.alias ?? "the agent").")
                                .foregroundStyle(p.muted)
                        }
                        HStack(spacing: 8) {
                            ForEach(hints, id: \.self) { hint in
                                PillChip(label: hint, selected: false) { draft = hint }
                            }
                        }
                    }
                    turnRows
                    if working {
                        Text("\(agent?.alias ?? "The agent") is working…")
                            .font(.system(size: 13))
                            .foregroundStyle(p.muted)
                            .opacity(!reduceMotion && pulse ? 0.4 : 1)
                            .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulse)
                            .onAppear { if !reduceMotion { pulse = true } }
                    }
                    if let error = model.error {
                        Banner(kind: .danger, text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            .onChange(of: model.turns.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    /// Turns as bubbles, with a `.system` day-divider bubble inserted at each new day.
    @ViewBuilder
    private var turnRows: some View {
        let humanId = model.humanId
        let alias = agent?.alias ?? "agent"
        let rows = withDayDividers(model.turns)
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
        if turn.role == "system" {
            Bubble(.system, turn.content)
        } else if mine {
            Bubble(.mine, turn.content, time: MobileUx.agoLabel(turn.createdAt))
        } else {
            Bubble(.theirs, turn.content, author: alias, time: MobileUx.agoLabel(turn.createdAt)) {
                if let rid = turn.runId {
                    NavigationLink(value: WorkspaceRoute.run(RunDto(runId: rid, agentId: agentId, agentAlias: alias, status: "exited"))) {
                        Text("Open work log →")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(p.accent)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
            }
        }
    }

    // MARK: composer

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Chat with \(agent?.alias ?? "the agent")…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
            Button {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                draft = ""
                Task { await model.sendTurn(agentId, content: text) }
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(p.accentInk)
                    .frame(width: 40, height: 40)
                    .background(p.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .opacity(canSend ? 1 : 0.45)
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(p.bg)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.actionInFlight
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
