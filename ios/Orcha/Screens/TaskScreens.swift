import SwiftUI

/* =============================================================================
   Flow 05 — Task detail + thread. Flow 06 — worker runs + streaming log.
   A 1:1 port of the Android `TaskScreens.kt`. These are plain pushed screens:
   the tab's NavigationStack (WorkspaceScreen) owns navigation + destinations.
   ============================================================================= */

/// Flow 05 T4 — task detail: header, flow-08 gate cards, DoD, deps, thread, runs,
/// and the destructive close path (dialog → optional reason alert → cancelTask).
struct TaskDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let taskId: String

    @State private var allRuns = false
    @State private var confirmClose = false
    @State private var reasonAlert = false
    @State private var closeReason = ""
    @State private var verifySheetTask: TaskDto?
    @State private var planSheetTask: TaskDto?

    private var task: TaskDto? { model.snapshot?.tasks.first { $0.id == taskId } }

    private var closable: Bool {
        guard let task else { return false }
        return !task.isRoot && task.status != "completed" && task.status != "cancelled"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let task {
                    detail(task)
                } else {
                    OrchaCard {
                        Text("Task not found — refresh the workspace.")
                            .foregroundStyle(p.muted)
                    }
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(16)
        }
        .navigationTitle(task?.title ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Close task…", role: .destructive) { confirmClose = true }
                        .disabled(!closable)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Task actions")
            }
        }
        .confirmationDialog(
            "Close \(task?.title ?? "task")?",
            isPresented: $confirmClose,
            titleVisibility: .visible
        ) {
            Button("Close task", role: .destructive) { close(reason: nil) }
            Button("Add reason & close…") { reasonAlert = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The task is force-closed and anything waiting on it unblocks. A reason is routed to the assignee.")
        }
        .alert("Close task", isPresented: $reasonAlert) {
            TextField("Reason (recommended)", text: $closeReason)
            Button("Close task", role: .destructive) {
                let trimmed = closeReason.trimmingCharacters(in: .whitespacesAndNewlines)
                close(reason: trimmed.isEmpty ? nil : trimmed)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The assignee sees this reason on their next wake.")
        }
        .sheet(item: $verifySheetTask) { VerifySheet(task: $0) }
        .sheet(item: $planSheetTask) { PlanApprovalSheet(task: $0) }
        .task { await model.loadTaskDetail(taskId) }
        .refreshable {
            await model.refresh()
            await model.loadTaskDetail(taskId)
        }
    }

    private func close(reason: String?) {
        Task {
            if await model.cancelTask(taskId, reason: reason) { dismiss() }
        }
    }

    @ViewBuilder
    private func detail(_ task: TaskDto) -> some View {
        headerCard(task)
        gateCards(task)
        descriptionSection(task)
        dodSection(task)
        dependenciesSection(task)
        threadSection
        runsSection
    }

    // MARK: header

    private func headerCard(_ task: TaskDto) -> some View {
        OrchaCard {
            HStack(spacing: 8) {
                StatusPill(status: task.status, domain: .task)
                let band = MobileUx.priorityBand(task.priority)
                MetaTag(
                    text: "P\(task.priority ?? 100)",
                    tint: band == .high ? p.danger : band == .elevated ? p.warn : nil
                )
                if task.isRoot { MetaTag(text: "root") }
                Spacer()
            }
            Text(task.title)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(p.text)
            HStack(spacing: 8) {
                if let assignee = task.assignees.first ?? task.ownerAlias {
                    AgentAvatar(alias: assignee, size: 30)
                    Text(assignee)
                        .font(.system(size: 13))
                        .foregroundStyle(p.text2)
                } else {
                    Text("unassigned")
                        .font(.system(size: 13))
                        .foregroundStyle(p.faint)
                }
            }
        }
    }

    // MARK: flow-08 violet gate cards

    @ViewBuilder
    private func gateCards(_ task: TaskDto) -> some View {
        if task.status == "needs_verification" {
            OrchaCard(borderColor: p.violetLine) {
                Text("AWAITING YOUR VERIFICATION")
                    .font(.system(size: 11, weight: .bold)).tracking(0.8)
                    .foregroundStyle(p.violet)
                Text(task.result ?? "The agent marked this done — review against the definition of done.")
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.text2)
                    .lineLimit(4)
                KitButton(title: "Review & verify", small: true) { verifySheetTask = task }
            }
        }
        if task.planMessage != nil, task.planDecision == nil, task.status == "in_progress" {
            OrchaCard(borderColor: p.violetLine) {
                Text("PLAN AWAITING YOUR APPROVAL")
                    .font(.system(size: 11, weight: .bold)).tracking(0.8)
                    .foregroundStyle(p.violet)
                Text(task.planMessage?.body ?? "")
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.text2)
                    .lineLimit(4)
                KitButton(title: "Review plan", small: true) { planSheetTask = task }
            }
        }
    }

    // MARK: description

    @ViewBuilder
    private func descriptionSection(_ task: TaskDto) -> some View {
        if let description = task.description,
           !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            SectionH(title: "Description")
            OrchaCard {
                Text(description)
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.text2)
            }
        }
    }

    // MARK: definition of done

    @ViewBuilder
    private func dodSection(_ task: TaskDto) -> some View {
        SectionH(title: "Definition of done")
        OrchaCard(borderColor: p.accentLine, container: p.surface2) {
            let lines = (task.definitionOfDone ?? "No definition of done was provided.")
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("✓")
                        .font(.system(size: 14.5, weight: .heavy))
                        .foregroundStyle(p.accent)
                    Text(line)
                        .font(.system(size: 14.5))
                        .foregroundStyle(p.text)
                }
            }
        }
    }

    // MARK: dependencies

    @ViewBuilder
    private func dependenciesSection(_ task: TaskDto) -> some View {
        if !task.dependsOn.isEmpty {
            SectionH(title: "Depends on", count: "\(task.dependsOn.count)")
            ForEach(task.dependsOn, id: \.self) { depId in
                let dep = model.snapshot?.tasks.first { $0.id == depId }
                NavigationLink(value: WorkspaceRoute.task(depId)) {
                    OrchaCard {
                        HStack(spacing: 8) {
                            Text(dep?.status == "completed" ? "✓" : "🔒")
                                .font(.system(size: 14, weight: .heavy))
                                .foregroundStyle(dep?.status == "completed" ? p.ok : p.warn)
                            Text(dep?.title ?? depId)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(p.text)
                                .lineLimit(1)
                            Spacer()
                            if let dep {
                                StatusPill(status: dep.status, domain: .task)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: thread

    @ViewBuilder
    private var threadSection: some View {
        SectionH(title: "Thread", count: "\(model.taskMessages.count)")
        NavigationLink(value: WorkspaceRoute.thread(taskId)) {
            OrchaCard {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Thread · \(model.taskMessages.count) messages")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(p.text)
                        if let last = model.taskMessages.last {
                            Text("\(last.authorAlias ?? (last.isHuman ? "you" : "agent")): \(last.body)")
                                .font(.system(size: 13))
                                .foregroundStyle(p.muted)
                                .lineLimit(1)
                        } else {
                            Text("No messages yet — say hi.")
                                .font(.system(size: 13))
                                .foregroundStyle(p.faint)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(p.faint)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: worker runs

    @ViewBuilder
    private var runsSection: some View {
        HStack {
            SectionH(title: "Worker runs", count: "\(model.taskRuns.count)")
            if model.taskRuns.contains(where: { $0.status == "running" }) {
                StatusPill(status: "running", domain: .run)
            }
        }
        if model.taskRuns.isEmpty {
            OrchaCard {
                Text("No runs yet — appears when a worker wakes for this task.")
                    .foregroundStyle(p.muted)
            }
        }
        ForEach(allRuns ? model.taskRuns : Array(model.taskRuns.prefix(3))) { run in
            NavigationLink(value: WorkspaceRoute.run(run)) {
                RunRowCard(run: run)
            }
            .buttonStyle(.plain)
        }
        if !allRuns, model.taskRuns.count > 3 {
            Button("All runs (\(model.taskRuns.count))") { allRuns = true }
                .buttonStyle(.plain)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(p.accent)
        }
    }
}

/// Flow 05/06 — a single worker-run row. Top-level so AgentDetailScreen can reuse it.
struct RunRowCard: View {
    @Environment(\.palette) private var p
    let run: RunDto

    var body: some View {
        OrchaCard {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(p.accent)
                Text(run.runId.prefix(6))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(p.text)
                if let alias = run.agentAlias {
                    AgentAvatar(alias: alias, size: 26)
                }
                StatusPill(status: run.status, domain: .run)
                Spacer()
                Text(MobileUx.agoLabel(run.startedAt) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.faint)
            }
            Text(run.taskTitle ?? run.wakeEvent ?? "worker run")
                .font(.system(size: 13))
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
    }
}

/* ---------- flow 05 T8 — the task thread (chat surface + composer) ---------- */

/// Flow 05 T8 — chat surface: scrolling bubbles (auto-pin to bottom) + a composer
/// pinned above the keyboard. A failed send keeps its text as a retryable bubble.
struct TaskThreadScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String

    @State private var draft = ""
    @State private var pendingSend: String?

    private var task: TaskDto? { model.snapshot?.tasks.first { $0.id == taskId } }
    private var assignee: String? { task?.assignees.first ?? task?.ownerAlias }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if model.taskMessages.isEmpty, pendingSend == nil {
                        OrchaCard {
                            Text("No messages yet — say hi to \(assignee ?? "the assignee").")
                                .foregroundStyle(p.muted)
                        }
                    }
                    ForEach(Array(model.taskMessages.enumerated()), id: \.offset) { _, msg in
                        threadBubble(msg)
                    }
                    if let unsent = pendingSend {
                        VStack(alignment: .trailing, spacing: 2) {
                            Bubble(.mine, unsent)
                            if !model.actionInFlight {
                                Button("Not sent · Tap to retry") { send(unsent) }
                                    .buttonStyle(.plain)
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(p.danger)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    } else if let error = model.error {
                        Banner(kind: .danger, text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            .onChange(of: model.taskMessages.count) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("Thread")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(p.text)
                    if let title = task?.title {
                        Text(title)
                            .font(.system(size: 11))
                            .foregroundStyle(p.muted)
                            .lineLimit(1)
                    }
                }
            }
        }
        .task { await model.loadTaskDetail(taskId) }
        .refreshable { await model.loadTaskDetail(taskId) }
    }

    @ViewBuilder
    private func threadBubble(_ msg: TaskMessageDto) -> some View {
        if msg.authorId == nil, !msg.isHuman {
            Bubble(.system, msg.body)
        } else if msg.authorId != nil, msg.authorId == model.humanId {
            Bubble(.mine, msg.body, time: MobileUx.agoLabel(msg.createdAt))
        } else {
            Bubble(
                .theirs, msg.body,
                author: msg.authorAlias ?? (msg.isHuman ? "human" : "agent"),
                time: MobileUx.agoLabel(msg.createdAt)
            )
        }
    }

    /// `.composer` — rounded field + circular send button.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(assignee ?? "the thread")…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .font(.system(size: 14.5))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(p.border2, lineWidth: 1))
            Button(action: sendDraft) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? p.accent : p.faint)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(p.bg)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.actionInFlight
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        send(text)
    }

    /// A send that errors keeps its text as an unsent bubble with a retry chip.
    private func send(_ text: String) {
        pendingSend = text
        Task {
            if await model.sendTaskMessage(taskId, body: text) {
                pendingSend = nil
            }
        }
    }
}

/* ---------- flow 06 R2 — run detail: mono log, pin-to-bottom, stop-run ---------- */

/// Flow 06 R2 — run detail: header + stop-run, terminal banner, and the streaming
/// mono log filling the remaining space with pragmatic pin-to-bottom tracking.
struct RunDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let run: RunDto

    @State private var confirmStop = false
    @State private var pinned = true

    var body: some View {
        VStack(spacing: 10) {
            header
            if run.status != "running" {
                terminalBanner
            }
            logCard
            if let error = model.error {
                Banner(kind: .danger, text: error, action: "Retry") {
                    Task { await model.loadRunLog(run) }
                }
            }
        }
        .padding(16)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(run.runId.prefix(6))
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .foregroundStyle(p.text)
            }
        }
        .task { await model.loadRunLog(run) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            StatusPill(status: run.status, domain: .run)
            if let wakeKind = run.wakeKind { MetaTag(text: wakeKind) }
            if let alias = run.agentAlias { MetaTag(text: alias) }
            Spacer()
            if run.status == "running" {
                KitButton(title: "Stop run", role: .dangerTonal, small: true, enabled: !model.actionInFlight) {
                    confirmStop = true
                }
                .fixedSize()
                .confirmationDialog("Stop this run?", isPresented: $confirmStop, titleVisibility: .visible) {
                    Button("Stop run", role: .destructive, action: stopRun)
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The worker is interrupted mid-turn. The log so far is kept and the run is marked stopped.")
                }
            }
        }
    }

    private var terminalBanner: some View {
        let kind: BannerKind = ["killed", "failed", "error"].contains(run.status) ? .danger : .info
        let ago = MobileUx.agoLabel(run.endedAt).map { " · \($0)" } ?? ""
        return Banner(kind: kind, text: "Run \(MobileUx.statusCopy(run.status))\(ago)")
    }

    private var logCard: some View {
        OrchaCard {
            if model.runLines.isEmpty {
                ScrollView {
                    Text(model.loading ? "Loading stream…" : "No log lines yet.")
                        .font(.system(size: 13))
                        .foregroundStyle(p.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { await model.loadRunLog(run) }
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .bottom) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(model.runLines.enumerated()), id: \.offset) { _, line in
                                    LogLine(line: line)
                                }
                                Color.clear.frame(height: 1).id("log-bottom")
                            }
                        }
                        .refreshable { await model.loadRunLog(run) }
                        // pragmatic pin tracking (flow 06 §auto-scroll): a downward
                        // drag (scrolling back through history) pauses auto-scroll.
                        .simultaneousGesture(
                            DragGesture().onChanged { value in
                                if value.translation.height > 12 { pinned = false }
                            }
                        )
                        if !pinned {
                            Button {
                                pinned = true
                                withAnimation { proxy.scrollTo("log-bottom", anchor: .bottom) }
                            } label: {
                                Text("Auto-scroll paused · Jump to latest")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(p.accent)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(p.surface3, in: Capsule())
                                    .overlay(Capsule().strokeBorder(p.border2, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .padding(.bottom, 6)
                        }
                    }
                    .onChange(of: model.runLines.count) {
                        if pinned {
                            proxy.scrollTo("log-bottom", anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private func stopRun() {
        Task { await model.stopRun(run) }
    }
}
