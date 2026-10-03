import SwiftUI
import UIKit   // UIResponder keyboard notifications (Issue 2 — scroll composer above keyboard)

/* =============================================================================
   Flow 05 — Task detail + thread. Flow 06 — worker runs + streaming log.
   Linear redesign: calm header (breadcrumb · title · meta row), verification
   card, markdown description, Properties, Activity / Runs timeline, and a
   bottom comment composer. The tab's NavigationStack owns navigation.
   ============================================================================= */

/// Flow 05 T4 — task detail. Destructive close path: impact preview → confirm (+ optional reason) → cancelTask.
struct TaskDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let taskId: String

    @State private var pane: DetailPane = .activity
    @State private var confirmClose = false
    @State private var closeReason = ""
    @State private var closeImpact: CloseImplicationsDto?
    @State private var loadingImpact = false
    @State private var verifySheetTask: TaskDto?
    @State private var rejectSheetTask: TaskDto?
    @State private var planSheetTask: TaskDto?
    @State private var reviewerPickerTask: TaskDto?
    @State private var reassignSheetTask: TaskDto?
    @State private var recurringSheetTask: TaskDto?
    @State private var acceptTick = 0
    @State private var linkedTaskId: String?
    /// Portal-link chips in the description (task / request / agent / GitHub) push here.
    @State private var portalRoute: WorkspaceRoute?
    @Environment(\.openURL) private var openURL

    private var task: TaskDto? { model.snapshot?.tasks.first { $0.id == taskId } }

    private var closable: Bool {
        guard let task else { return false }
        return !task.isRoot && task.status != "completed" && task.status != "cancelled"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.xl) {
                if let task {
                    detail(task)
                } else {
                    LEmptyState(
                        icon: "questionmark.circle",
                        title: "Task not found",
                        message: "Pull to refresh the workspace."
                    )
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            TaskCommentComposer(taskId: taskId, assignee: task?.assignees.first ?? task?.ownerAlias)
        }
        .navigationTitle(task.map { $0.shortId } ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(p.surface, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    NavigationLink(value: WorkspaceRoute.thread(taskId)) {
                        Label("Open full thread", systemImage: "bubble.left.and.bubble.right")
                    }
                    if let task, !task.isRoot {
                        Button("Reassign…", systemImage: "person.crop.circle.badge.arrow.forward") { reassignSheetTask = task }
                            .disabled(!model.access.canWrite || !ReassignUx.canReassign(task))
                        Button("Make recurring…", systemImage: "clock.arrow.circlepath") { recurringSheetTask = task }
                            .disabled(!model.access.canManage(Grant.manageAgents))
                    }
                    Button("Close task…", systemImage: "xmark.circle", role: .destructive) { prepareClose() }
                        .disabled(!closable || loadingImpact)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Task actions")
            }
        }
        // Android TaskCloseDialog parity: one confirm listing the blast radius, with the
        // reason field inline (recommended, routed to the assignee).
        .alert("Close \(task?.title ?? "task")?", isPresented: $confirmClose) {
            TextField("Reason (recommended)", text: $closeReason)
            Button("Close task", role: .destructive) {
                let trimmed = closeReason.trimmingCharacters(in: .whitespacesAndNewlines)
                close(reason: trimmed.isEmpty ? nil : trimmed)
            }
            Button("Keep task", role: .cancel) {}
        } message: {
            Text(CloseImplicationsUx.message(closeImpact))
        }
        .sheet(item: $verifySheetTask) { VerifySheet(task: $0) }
        .sheet(item: $rejectSheetTask) { VerifySheet(task: $0, startRejecting: true) }
        .sheet(item: $planSheetTask) { PlanApprovalSheet(task: $0) }
        .sheet(item: $reviewerPickerTask) { ReviewerPickerSheet(task: $0) }
        .sheet(item: $reassignSheetTask) { ReassignTaskSheet(task: $0) }
        .sheet(item: $recurringSheetTask) { MakeRecurringSheet(task: $0) }
        .sensoryFeedback(.success, trigger: acceptTick)
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        .portalLinkNavigation($portalRoute)
        .task { await model.loadTaskDetail(taskId) }
        .refreshable {
            await model.refresh()
            await model.loadTaskDetail(taskId)
        }
    }

    private func openPortal(_ link: PortalLink) {
        switch model.portalDestination(link) {
        case let .route(route): portalRoute = route
        case let .browser(url): openURL(url)
        case .none: break
        }
    }

    @ViewBuilder
    private func detail(_ task: TaskDto) -> some View {
        let agents = model.snapshot?.agents ?? []
        TaskGoalChainBar(taskId: task.id)
        TaskDetailHeader(task: task, projectName: model.snapshot?.container.name, agents: agents)
        if task.status == "needs_verification" {
            VerificationCard(
                task: task,
                canWrite: model.access.canWrite,
                busy: model.actionInFlight,
                reviewTag: MobileUx.reviewTag(for: task, identity: model.identity),
                onReview: { verifySheetTask = task },
                onReject: { rejectSheetTask = task },
                onAccept: { accept(task) }
            )
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
        if task.planMessage != nil, task.planDecision == nil, task.status == "in_progress" {
            PlanWaitingCard(task: task) { planSheetTask = task }
        }
        if let description = task.description,
           !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ChatMarkdownView(
                text: description, tasks: model.snapshot?.tasks ?? [],
                onTapTask: { linkedTaskId = $0 },
                portalBase: model.portalBase, onTapPortal: openPortal
            )
                .ltype(.body)
                .foregroundStyle(p.text2)
        }
        if task.status != "needs_verification" {
            DoneWhenBlock(definitionOfDone: task.definitionOfDone)
        }
        TaskPropertiesSection(
            task: task,
            agents: agents,
            canAssignReviewer: model.access.canManage(Grant.assignReviewers),
            onPickReviewer: { reviewerPickerTask = task }
        )
        if !task.dependsOn.isEmpty {
            DependenciesSection(dependsOn: task.dependsOn, tasks: model.snapshot?.tasks ?? [])
        }
        TaskDeliverablesSection(task: task)
        VStack(alignment: .leading, spacing: LSpace.m) {
            LSegmented(
                [(DetailPane.activity, "Activity \(ActivityTimeline.entries(task: task, messages: model.taskMessages).count)"),
                 (DetailPane.runs, "Runs \(model.taskRuns.count)")],
                selection: $pane
            )
            switch pane {
            case .activity:
                ActivityTimeline(task: task, messages: model.taskMessages, agents: agents, taskId: taskId)
            case .runs:
                RunsTimeline(runs: model.taskRuns)
            }
        }
        .animation(.lQuick, value: pane)
    }

    private func accept(_ task: TaskDto) {
        Task {
            if await model.verifyTask(task.id, approve: true, feedback: nil) {
                acceptTick += 1
            }
        }
    }

    /// Read the close's blast radius (dependents, agents mid-run, open requests) first,
    /// so the confirm lists what will be affected; a slow/failed read keeps the generic copy.
    private func prepareClose() {
        loadingImpact = true
        closeReason = ""
        Task {
            closeImpact = await model.fetchCloseImplications(taskId)
            loadingImpact = false
            confirmClose = true
        }
    }

    private func close(reason: String?) {
        Task {
            if await model.cancelTask(taskId, reason: reason) { dismiss() }
        }
    }
}

enum DetailPane: Hashable { case activity, runs }

// MARK: - header

/// Breadcrumb (project › id), large title, and the meta row. The status glyph
/// morphs (scale + fade) when the status changes; a completed status lands with a haptic.
private struct TaskDetailHeader: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let task: TaskDto
    let projectName: String?
    let agents: [AgentDto]

    private var assignee: String? { task.assignees.first ?? task.ownerAlias }

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.s) {
            HStack(spacing: 6) {
                Text(projectName ?? "Project")
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .accessibilityHidden(true)
                Text(task.shortId)
                    .ltype(.mono)
                if task.isRoot { LTag("Root") }
            }
            .ltype(.meta)
            .foregroundStyle(p.faint)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(projectName ?? "Project"), task \(task.shortId)")

            Text(task.title)
                .ltype(.display)
                .foregroundStyle(p.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: LSpace.s) { metaItems(dots: true, showAgo: true) }
                HStack(spacing: LSpace.s) { metaItems(dots: true, showAgo: false) }
                VStack(alignment: .leading, spacing: 6) { metaItems(dots: false, showAgo: true) }
            }
            .ltype(.meta)
        }
        .sensoryFeedback(trigger: task.status) { _, new in
            new == "completed" ? .success : (new == "needs_verification" ? .impact(weight: .light) : nil)
        }
    }

    @ViewBuilder
    private func metaItems(dots: Bool, showAgo: Bool) -> some View {
        HStack(spacing: 6) {
            ZStack {
                LStatusGlyph(status: task.status, size: 15)
                    .id(task.status)
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .scale(scale: 0.3).combined(with: .opacity),
                        removal: .scale(scale: 1.6).combined(with: .opacity)
                    ))
            }
            .animation(reduceMotion ? .lQuick : .lSpring, value: task.status)
            Text(MobileUx.statusCopy(task.status).prefix(1).uppercased() + MobileUx.statusCopy(task.status).dropFirst())
                .contentTransition(.opacity)
                .foregroundStyle(p.text2)
        }
        if dots { dot }
        HStack(spacing: 6) {
            LPriorityGlyph(priority: task.priority, size: 13)
            Text(priorityLabel(task.priority))
                .foregroundStyle(p.text2)
        }
        if dots { dot }
        HStack(spacing: 6) {
            if let assignee {
                LAvatar(name: assignee, isAI: !MobileUx.isHumanAlias(assignee, in: agents), size: 18)
                Text(assignee).foregroundStyle(p.text2).lineLimit(1)
            } else {
                Text("Unassigned").foregroundStyle(p.faint)
            }
        }
        if showAgo, let ago = MobileUx.agoLabel(task.completedAt ?? task.startedAt ?? task.createdAt) {
            if dots { dot }
            Text(ago).foregroundStyle(p.faint)
        }
    }

    private var dot: some View {
        Text("·").foregroundStyle(p.faint).accessibilityHidden(true)
    }
}

/// Web-matching priority buckets: <=5 urgent, <=20 high, <=100 normal, else low.
func priorityLabel(_ priority: Int?) -> String {
    let value = priority ?? 100
    if value <= 5 { return "Urgent" }
    if value <= 20 { return "High" }
    if value <= 100 { return "Normal" }
    return "Low"
}

// MARK: - verification + plan cards

private struct VerificationCard: View {
    @Environment(\.palette) private var p
    let task: TaskDto
    let canWrite: Bool
    let busy: Bool
    let reviewTag: String?
    let onReview: () -> Void
    let onReject: () -> Void
    let onAccept: () -> Void

    var body: some View {
        LCard(padding: LSpace.l) {
            VStack(alignment: .leading, spacing: LSpace.m) {
                HStack(spacing: LSpace.s) {
                    LStatusGlyph(status: "needs_verification", size: 14)
                    Text("Awaiting your verification")
                        .ltype(.headline)
                        .foregroundStyle(p.text)
                    Spacer()
                    if let reviewTag { LTag("Review: \(reviewTag)", tint: p.accent) }
                }
                if let result = task.result ?? task.messageSummary?.last.map({ ActivityCopy.humanize($0.body) }) {
                    VStack(alignment: .leading, spacing: 4) {
                        caption("Result")
                        Text(ChatMarkdown.inline(result))
                            .ltype(.body)
                            .foregroundStyle(p.text2)
                            .lineLimit(6)
                    }
                }
                TaskProofOfWork(taskId: task.id, reloadKey: task.status)
                ManagerReviewRow(task: task)
                DoneWhenBlock(definitionOfDone: task.definitionOfDone, compact: true)
                Button("See full review", action: onReview)
                    .buttonStyle(.plain)
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 44, alignment: .leading)
                HStack(spacing: LSpace.s) {
                    Spacer()
                    LButton("Reject…", kind: .secondary, action: onReject)
                        .disabled(!canWrite || busy)
                    LButton("Accept", icon: "checkmark", kind: .primary, action: onAccept)
                        .disabled(!canWrite || busy)
                }
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).ltype(.micro).foregroundStyle(p.faint)
    }
}

private struct PlanWaitingCard: View {
    @Environment(\.palette) private var p
    let task: TaskDto
    let onReview: () -> Void

    var body: some View {
        LCard(padding: LSpace.l) {
            VStack(alignment: .leading, spacing: LSpace.s) {
                HStack(spacing: LSpace.s) {
                    Image(systemName: "doc.text")
                        .foregroundStyle(p.violet)
                        .accessibilityHidden(true)
                    Text("Plan waiting for approval")
                        .ltype(.headline)
                        .foregroundStyle(p.text)
                    Spacer()
                    if let author = task.planMessage?.authorAlias {
                        LAvatar(name: author, isAI: true, size: 20)
                    }
                }
                Text(task.planMessage?.body ?? "")
                    .ltype(.body)
                    .foregroundStyle(p.text2)
                    .lineLimit(4)
                HStack {
                    Spacer()
                    LButton("Review plan", kind: .primary, size: .small, action: onReview)
                }
            }
        }
    }
}

/// "Done when" — the definition of done as green-check lines.
private struct DoneWhenBlock: View {
    @Environment(\.palette) private var p
    let definitionOfDone: String?
    var compact = false

    private var lines: [String] {
        (definitionOfDone ?? "")
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .map { $0.hasPrefix("- ") ? String($0.dropFirst(2)) : $0 }
            .filter { !$0.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Done when")
                .ltype(compact ? .micro : .meta)
                .foregroundStyle(p.faint)
                .accessibilityAddTraits(.isHeader)
            if lines.isEmpty {
                Text("No definition of done was provided.")
                    .ltype(.body)
                    .foregroundStyle(p.faint)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                    Image(systemName: "checkmark.circle")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(p.ok)
                        .accessibilityHidden(true)
                    Text(line)
                        .ltype(.body)
                        .foregroundStyle(p.text)
                }
            }
        }
    }
}

// MARK: - properties

private struct TaskPropertiesSection: View {
    @Environment(\.palette) private var p
    let task: TaskDto
    let agents: [AgentDto]
    let canAssignReviewer: Bool
    let onPickReviewer: () -> Void

    var body: some View {
        LSection("Properties") {
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    PropertyRow(label: "Status") {
                        LStatusGlyph(status: task.status, size: 13)
                        Text(MobileUx.statusCopy(task.status)).foregroundStyle(p.text)
                    }
                    LDivider()
                    PropertyRow(label: "Priority") {
                        LPriorityGlyph(priority: task.priority, size: 13)
                        Text("\(priorityLabel(task.priority)) · P\(task.priority ?? 100)").foregroundStyle(p.text)
                    }
                    LDivider()
                    PropertyRow(label: "Assignee") {
                        if let a = task.assignees.first ?? task.ownerAlias {
                            LAvatar(name: a, isAI: !MobileUx.isHumanAlias(a, in: agents), size: 18)
                            Text(a).foregroundStyle(p.text).lineLimit(1)
                        } else {
                            Text("Unassigned").foregroundStyle(p.faint)
                        }
                    }
                    LDivider()
                    reviewerRow
                    if let created = MobileUx.agoLabel(task.createdAt) {
                        LDivider()
                        PropertyRow(label: "Created") {
                            Text(created).foregroundStyle(p.text2)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var reviewerRow: some View {
        let content = PropertyRow(label: "Reviewer") {
            if let reviewer = task.reviewer {
                LAvatar(name: reviewer.githubLogin ?? reviewer.alias ?? "?", size: 18)
                Text(reviewer.githubLogin ?? reviewer.alias ?? "member")
                    .foregroundStyle(p.text)
                    .lineLimit(1)
            } else {
                Text("Anyone").foregroundStyle(p.faint)
            }
            if canAssignReviewer {
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(p.faint)
                    .accessibilityHidden(true)
            }
        }
        if canAssignReviewer {
            Button(action: onPickReviewer) { content }
                .buttonStyle(.plain)
                .accessibilityHint(task.reviewer == nil ? "Assign a reviewer" : "Change the reviewer")
        } else {
            content
        }
    }
}

private struct PropertyRow<Value: View>: View {
    @Environment(\.palette) private var p
    let label: String
    @ViewBuilder let value: Value

    var body: some View {
        HStack(spacing: LSpace.s) {
            Text(label)
                .foregroundStyle(p.faint)
                .frame(width: 96, alignment: .leading)
            HStack(spacing: 6) { value }
            Spacer(minLength: 0)
        }
        .ltype(.meta)
        .padding(.horizontal, LSpace.m)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct DependenciesSection: View {
    @Environment(\.palette) private var p
    let dependsOn: [String]
    let tasks: [TaskDto]

    var body: some View {
        LSection("Depends on", count: dependsOn.count) {
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(dependsOn.enumerated()), id: \.element) { index, depId in
                        let dep = tasks.first { $0.id == depId }
                        if index > 0 { LDivider() }
                        NavigationLink(value: WorkspaceRoute.task(depId)) {
                            HStack(spacing: 10) {
                                LStatusGlyph(status: dep?.status ?? "pending", size: 14)
                                Text(dep?.title ?? depId)
                                    .ltype(.body)
                                    .foregroundStyle(p.text)
                                    .lineLimit(1)
                                Spacer()
                                Text(dep?.shortId ?? "")
                                    .ltype(.mono)
                                    .foregroundStyle(p.faint)
                            }
                            .padding(.horizontal, LSpace.m)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

// MARK: - activity + runs

/// A clean vertical timeline: lifecycle events from the task's timestamps merged with
/// the thread's latest messages. Small glyphs, muted times.
private struct ActivityTimeline: View {
    @Environment(\.palette) private var p
    let task: TaskDto
    let messages: [TaskMessageDto]
    let agents: [AgentDto]
    let taskId: String

    fileprivate struct Entry: Identifiable {
        let id: String
        let date: Date?
        let time: String?
        let actor: String?
        let isAI: Bool
        let glyph: String?
        let text: String
        let isMessage: Bool
    }

    private var entries: [Entry] { Self.entries(task: task, messages: messages) }

    /// The rows the timeline lists — the "Activity N" pill counts exactly these.
    fileprivate static func entries(task: TaskDto, messages: [TaskMessageDto]) -> [Entry] {
        var out: [Entry] = []
        if let c = task.createdAt {
            out.append(Entry(id: "created", date: MobileUx.parseInstant(c), time: MobileUx.agoLabel(c),
                             actor: nil, isAI: false, glyph: "pending", text: "Task created", isMessage: false))
        }
        if let s = task.startedAt {
            out.append(Entry(id: "started", date: MobileUx.parseInstant(s), time: MobileUx.agoLabel(s),
                             actor: nil, isAI: false, glyph: "in_progress", text: "Work started", isMessage: false))
        }
        if let d = task.completedAt {
            out.append(Entry(id: "completed", date: MobileUx.parseInstant(d), time: MobileUx.agoLabel(d),
                             actor: nil, isAI: false, glyph: task.status == "cancelled" ? "cancelled" : "completed",
                             text: task.status == "cancelled" ? "Closed" : "Completed", isMessage: false))
        }
        for (i, m) in messages.suffix(8).enumerated() {
            let author = m.authorAlias ?? (m.isHuman ? "you" : "system")
            out.append(Entry(id: m.messageId ?? "m\(i)", date: MobileUx.parseInstant(m.createdAt),
                             time: MobileUx.agoLabel(m.createdAt), actor: author,
                             isAI: !m.isHuman && m.authorId != nil, glyph: nil, text: ActivityCopy.humanize(m.body), isMessage: true))
        }
        return out.sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !messages.isEmpty {
                NavigationLink(value: WorkspaceRoute.thread(taskId)) {
                    Text(messages.count > 8 ? "Show all \(messages.count) messages" : "Open thread")
                        .ltype(.meta)
                        .foregroundStyle(p.accent)
                        .frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
            ForEach(entries) { entry in
                row(entry)
            }
            if messages.isEmpty {
                Text("No comments yet. Say hi below.")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                    .padding(.top, LSpace.s)
            }
        }
    }

    private func row(_ entry: Entry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                if let glyph = entry.glyph {
                    LStatusGlyph(status: glyph, size: 12)
                } else {
                    LAvatar(name: entry.actor ?? "?", isAI: entry.isAI, size: 18)
                }
            }
            .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let actor = entry.actor {
                        Text(actor).ltype(.bodyEmph).foregroundStyle(p.text)
                    } else {
                        Text(entry.text).ltype(.meta).foregroundStyle(p.text2)
                    }
                    Spacer(minLength: 0)
                    Text(entry.time ?? "").ltype(.micro).foregroundStyle(p.faint)
                }
                if entry.isMessage {
                    Text(entry.text)
                        .ltype(.body)
                        .foregroundStyle(p.text2)
                        .lineLimit(5)
                }
            }
        }
        .padding(.vertical, LSpace.s)
        .accessibilityElement(children: .combine)
    }
}

private struct RunsTimeline: View {
    @Environment(\.palette) private var p
    let runs: [RunDto]
    @State private var showAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if runs.isEmpty {
                Text("No runs yet. One appears when a worker wakes for this task.")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                    .padding(.top, LSpace.s)
            }
            ForEach(showAll ? runs : Array(runs.prefix(5))) { run in
                NavigationLink(value: WorkspaceRoute.run(run)) {
                    RunRowCard(run: run)
                }
                .buttonStyle(.plain)
                LDivider()
            }
            if !showAll, runs.count > 5 {
                Button("All runs (\(runs.count))") { showAll = true }
                    .buttonStyle(.plain)
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 44)
            }
        }
    }
}

/// Flow 05/06 — a single worker-run row (Linear timeline row). Top-level so
/// AgentDetailScreen can reuse it.
struct RunRowCard: View {
    @Environment(\.palette) private var p
    let run: RunDto

    private var glyphStatus: String {
        switch run.status {
        case "running": "in_progress"
        case "completed", "succeeded", "ok", "done", "exited": "completed"
        case "killed", "failed", "error": "failed"
        case "stopped", "cancelled": "cancelled"
        // Anything else (orphaned, terminated, …) has its own web StatusIcon shape.
        default: run.status
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            LStatusGlyph(status: glyphStatus, size: 14)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(run.runId.prefix(6))
                        .ltype(.mono)
                        .foregroundStyle(p.text)
                    Text(MobileUx.statusCopy(run.status))
                        .ltype(.meta)
                        .foregroundStyle(run.status == "running" ? p.warn : p.text2)
                }
                Text(run.taskTitle ?? run.wakeEvent.map(ActivityCopy.humanize) ?? "Worker run")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                    .lineLimit(1)
            }
            Spacer(minLength: LSpace.s)
            if let alias = run.agentAlias {
                LAvatar(name: alias, isAI: true, size: 18)
            }
            Text(MobileUx.agoLabel(run.startedAt) ?? "")
                .ltype(.micro)
                .foregroundStyle(p.faint)
        }
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - comment composer

/// Bottom composer on the task detail — posts to the task thread. Read-only roles
/// get the honest note instead (the server would 403 the post anyway).
private struct TaskCommentComposer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String
    let assignee: String?

    @State private var draft = ""
    @State private var failed: String?
    @State private var sentTick = 0
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.actionInFlight
    }

    var body: some View {
        VStack(spacing: 0) {
            LDivider()
            if let reason = model.access.writeDenialReason {
                Text(reason)
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(LSpace.m)
            } else {
                if let failed {
                    Button("Not sent · Tap to retry") { send(failed) }
                        .buttonStyle(.plain)
                        .ltype(.micro)
                        .foregroundStyle(p.danger)
                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .trailing)
                        .padding(.horizontal, LSpace.l)
                }
                HStack(alignment: .bottom, spacing: LSpace.s) {
                    TextField("Leave a comment…", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .ltype(.body)
                        .focused($focused)
                        .padding(.horizontal, LSpace.m)
                        .padding(.vertical, 9)
                        .background(p.surface2, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused ? p.accentLine : p.border, lineWidth: 1))
                        .accessibilityLabel("Comment to \(assignee ?? "the thread")")
                    DictationMicButton(text: $draft)
                    Button(action: sendDraft) {
                        Image(systemName: "arrow.up")
                            .font(.callout.weight(.bold))
                            .foregroundStyle(canSend ? p.lPrimaryText : p.faint)
                            .frame(width: 36, height: 36)
                            .background(canSend ? p.lPrimaryFill : p.surface2, in: Circle())
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityLabel("Send comment")
                }
                .padding(.horizontal, LSpace.m)
                .padding(.vertical, LSpace.xs)
            }
        }
        .background(p.surface)
        .sensoryFeedback(.impact(weight: .light), trigger: sentTick)
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        send(text)
    }

    private func send(_ text: String) {
        failed = nil
        Task {
            if await model.sendTaskMessage(taskId, body: text) {
                sentTick += 1
            } else {
                failed = text
            }
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
    /// GH #140 — a tapped task-id link pushes here, in addition to the tab's own
    /// `WorkspaceRoute.task` destination; both target the same `TaskDetailScreen`.
    @State private var linkedTaskId: String?
    /// Portal-link chips in a message (task / request / agent / GitHub) push here.
    @State private var portalRoute: WorkspaceRoute?
    @Environment(\.openURL) private var openURL

    private var task: TaskDto? { model.snapshot?.tasks.first { $0.id == taskId } }
    private var assignee: String? { task?.assignees.first ?? task?.ownerAlias }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    // Issue 4: "Load earlier" reveals the previous keyset page at the TOP; it
                    // prepends older messages and must NOT scroll the view to the bottom.
                    if model.threadHasMore {
                        Button {
                            Task { await model.loadEarlierThreadMessages(taskId) }
                        } label: {
                            if model.threadLoadingEarlier {
                                ProgressView().frame(maxWidth: .infinity)
                            } else {
                                Text("Load earlier messages")
                                    .font(p.uiFont(12, .bold))
                                    .foregroundStyle(p.accent)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                        .disabled(model.threadLoadingEarlier)
                    }
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
                                    .font(p.uiFont(11, .bold))
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
            // Scroll to bottom only when the NEWEST message changes (a new/sent message) or a
            // pending bubble appears — never on a "Load earlier" prepend (which changes the top).
            .onChange(of: model.taskMessages.last?.messageId) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: pendingSend) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
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
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                    if let title = task?.title {
                        Text(title)
                            .font(p.uiFont(11))
                            .foregroundStyle(p.muted)
                            .lineLimit(1)
                    }
                }
            }
        }
        .task { await model.loadTaskDetail(taskId) }
        .refreshable { await model.loadTaskDetail(taskId) }
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        .portalLinkNavigation($portalRoute)
    }

    private func openPortal(_ link: PortalLink) {
        switch model.portalDestination(link) {
        case let .route(route): portalRoute = route
        case let .browser(url): openURL(url)
        case .none: break
        }
    }

    @ViewBuilder
    private func threadBubble(_ msg: TaskMessageDto) -> some View {
        let tasks = model.snapshot?.tasks ?? []
        if msg.authorId == nil, !msg.isHuman {
            Bubble(
                .system, ActivityCopy.humanize(msg.body), tasks: tasks, onTapTask: { linkedTaskId = $0 },
                portalBase: model.portalBase, onTapPortal: openPortal
            )
        } else if msg.authorId != nil, msg.authorId == model.humanId {
            Bubble(
                .mine, msg.body, time: MobileUx.agoLabel(msg.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 },
                portalBase: model.portalBase, onTapPortal: openPortal
            )
        } else {
            Bubble(
                .theirs, msg.body,
                author: msg.authorAlias ?? (msg.isHuman ? "human" : "agent"),
                time: MobileUx.agoLabel(msg.createdAt),
                tasks: tasks, onTapTask: { linkedTaskId = $0 },
                portalBase: model.portalBase, onTapPortal: openPortal
            )
        }
    }

    /// `.composer` — rounded field + circular send button. Collab v1: a read-only
    /// role (viewer / trusted non-member) gets the honest note instead — the
    /// server would 403 the post anyway.
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
            TextField("Message \(assignee ?? "the thread")…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .font(p.uiFont(14.5))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(p.border2, lineWidth: 1))
            Button(action: sendDraft) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(p.uiFont(32))
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

    private enum RunPane: String, CaseIterable {
        case log = "Log", changes = "Changes"
    }

    @State private var pane: RunPane = .log

    var body: some View {
        VStack(spacing: 10) {
            header
            Picker("View", selection: $pane) {
                ForEach(RunPane.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            if run.status != "running" {
                terminalBanner
            }
            if let note = model.runStreamNote {
                Banner(kind: .info, text: note)
            }
            switch pane {
            case .log:
                if run.status != "running" {
                    RunDigestCard(feed: model.runFeed)
                }
                logCard
                if let error = model.error {
                    Banner(kind: .danger, text: error, action: "Retry") {
                        model.startRunLog(run)
                    }
                }
            case .changes:
                changesPane
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
        // Issue 3: a running run streams live over SSE; a finished run keeps the one-shot fetch.
        // The collector is cancelled when the screen goes away.
        .task { model.startRunLog(run) }
        .onDisappear { model.stopRunLogStream() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            StatusPill(status: run.status, domain: .run)
            if let wakeKind = run.wakeKind { MetaTag(text: ActivityCopy.humanize(wakeKind)) }
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

    /// GitHub-style "Changes" pane — the run's net unified diff, parsed and
    /// rendered per file with hunks, line numbers, and add/del row tints.
    @ViewBuilder
    private var changesPane: some View {
        if let agentId = run.agentId {
            // Live changes (web LiveChangesPanel): polls while running, one read once finished.
            ScrollView {
                AgentLiveChangesSection(agentId: agentId, runId: run.runId, live: run.status == "running")
                    .padding(.bottom, 12)
            }
        } else if let diff = run.diff, !diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ScrollView {
                DiffViewer(diff: diff)
                    .padding(.bottom, 12)
            }
        } else if run.status == "running" {
            OrchaCard {
                Text("The diff lands when the worker finishes — watch the log meanwhile.")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            }
            Spacer()
        } else {
            OrchaCard {
                Text("No diff captured for this run.")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            }
            Spacer()
        }
    }

    private var logCard: some View {
        OrchaCard {
            if model.runFeed.isEmpty {
                ScrollView {
                    Text(emptyLogText)
                        .font(p.uiFont(13))
                        .foregroundStyle(p.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { model.startRunLog(run) }
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .bottom) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(model.runFeed.enumerated()), id: \.offset) { _, row in
                                    FeedRow(row: row)
                                }
                                Color.clear.frame(height: 1).id("log-bottom")
                            }
                        }
                        .refreshable { model.startRunLog(run) }
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
                                    .font(p.uiFont(11, .bold))
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
                    .onChange(of: model.runFeed.count) {
                        if pinned {
                            proxy.scrollTo("log-bottom", anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private var emptyLogText: String {
        if model.runLogStreaming { return "Waiting for the worker to emit output…" }
        if model.loading { return "Loading stream…" }
        return "No log lines yet."
    }

    private func stopRun() {
        Task { await model.stopRun(run) }
    }
}
