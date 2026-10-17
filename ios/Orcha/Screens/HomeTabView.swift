import SwiftUI

/// Flow 04 H5/H6 — the Home tab, Linear-style: a calm project header (name,
/// objective, agent stack, one-line task tally), then "Needs you", "Active
/// work" and an "Updates" feed as hairline rows under muted captions.
struct HomeTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Binding var showCreateTask: Bool
    @Binding var showMetrics: Bool
    @State private var planSheetTask: TaskDto?
    @State private var verifySheetTask: TaskDto?
    @State private var showRepoConnect = false
    @State private var showObjectiveEditor = false
    @State private var showPlanUsage = false

    var body: some View {
        Group {
            if let snapshot = model.snapshot {
                content(snapshot)
            } else if model.loading {
                skeleton
            } else {
                UnreachableState()
            }
        }
        .background(p.bg)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Create task", systemImage: "square.and.pencil") { showCreateTask = true }
            }
        }
        .sheet(item: $planSheetTask) { task in
            PlanApprovalSheet(task: task)
        }
        .sheet(item: $verifySheetTask) { task in
            VerifySheet(task: task)
        }
        .sheet(isPresented: $showRepoConnect) {
            ConnectRepoSheet()
        }
        .sheet(isPresented: $showObjectiveEditor) {
            ObjectiveEditorSheet(current: model.snapshot?.container.description ?? "")
        }
        .sheet(isPresented: $showPlanUsage) {
            PlanUsageSheet()
        }
        // Plan usage: read now, then every 2 minutes while Home is visible.
        .task(id: pairedBases) {
            while !Task.isCancelled {
                await model.planUsage.refresh(bases: pairedBases)
                try? await Task.sleep(for: PlanUsageUx.pollInterval)
            }
        }
    }

    /// Every paired server, once each — plan usage merges the newest snapshot per provider.
    private var pairedBases: [String] { Array(Set(model.containers.map(\.baseUrl))).sorted() }

    private var skeleton: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.m) {
                SkeletonBlock(height: 72)
                SkeletonBlock(height: 52)
                SkeletonBlock(height: 52)
                SkeletonBlock(height: 52)
                SkeletonBlock(height: 52)
            }
            .padding(LSpace.l)
        }
    }

    private func content(_ snapshot: ContainerSnapshot) -> some View {
        let tasks = snapshot.tasks
        let plans = tasks.filter { $0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil }
        let verifs = tasks.filter { $0.status == "needs_verification" }
        let reqs = snapshot.requests.filter { $0.status == "open" && ($0.targetId == model.humanId || $0.targetId == nil) }
        let needsCount = plans.count + verifs.count + reqs.count
        let active = tasks
            .filter { ["in_progress", "blocked", "ready"].contains($0.status) }
            .sorted { lhs, rhs in
                let l = MobileUx.taskGroupRank(lhs.status), r = MobileUx.taskGroupRank(rhs.status)
                return l != r ? l < r : (lhs.priority ?? 100) < (rhs.priority ?? 100)
            }
            .prefix(8)
        let activity: [(TaskDto, TaskMessageDto)] = tasks
            .compactMap { task in task.messageSummary?.last.map { (task, $0) } }
            .sorted { ($0.1.createdAt ?? "") > ($1.1.createdAt ?? "") }
            .prefix(8)
            .map { $0 }

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: LSpace.xl) {
                VStack(alignment: .leading, spacing: LSpace.m) {
                    ConnectionBanners()
                    HomeHeader(
                        snapshot: snapshot,
                        canEditObjective: model.access.canManage(Grant.manageAutonomy),
                        onConnectRepo: { showRepoConnect = true },
                        onEditObjective: { showObjectiveEditor = true }
                    )
                    // Plan usage (Claude / Codex limits from the desktop) in place of "This week",
                    // only when the portal-wide "Show plan usage" setting is on (off by default).
                    if model.planUsage.display.show {
                        PlanUsageCard(
                            providers: model.planUsage.shownProviders,
                            loaded: model.planUsage.loaded,
                            onOpen: { showPlanUsage = true }
                        )
                    }
                    if let cu = model.catchUp {
                        CatchUpCard(
                            previous: cu.previous,
                            current: WorkspaceDigest.make(snapshot),
                            gap: cu.gapLabel,
                            onDismiss: { model.catchUp = nil }
                        )
                    }
                    WorkspaceBriefCard(digest: WorkspaceDigest.make(snapshot))
                }

                LSection("Needs you", count: needsCount) {
                    if needsCount == 0 {
                        HomeQuietRow(text: "Nothing needs you right now.")
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(plans.enumerated()), id: \.element.id) { index, task in
                                Button { planSheetTask = task } label: {
                                    NeedsYouRow(task: task, kind: "Plan", tint: p.warn)
                                }
                                .buttonStyle(.lRow)
                                .shellRowEntrance(index)
                            }
                            // Collab v1: a verify assigned to someone else's review is
                            // dimmed + tagged (web renderQueue parity).
                            ForEach(Array(verifs.enumerated()), id: \.element.id) { index, task in
                                Button { verifySheetTask = task } label: {
                                    NeedsYouRow(
                                        task: task, kind: "Verify", tint: p.ok,
                                        reviewTag: MobileUx.reviewTag(for: task, identity: model.identity)
                                    )
                                }
                                .buttonStyle(.lRow)
                                .shellRowEntrance(plans.count + index)
                            }
                            ForEach(Array(reqs.enumerated()), id: \.element.id) { index, req in
                                NavigationLink(value: WorkspaceRoute.request(req.id)) {
                                    NeedsYouRequestRow(request: req)
                                }
                                .buttonStyle(.lRow)
                                .shellRowEntrance(plans.count + verifs.count + index)
                            }
                        }
                    }
                }

                LSection("Active work", count: active.count) {
                    if active.isEmpty {
                        HomeQuietRow(text: "No tasks in flight.")
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(active.enumerated()), id: \.element.id) { index, task in
                                NavigationLink(value: WorkspaceRoute.task(task.id)) {
                                    ActiveTaskRow(task: task)
                                }
                                .buttonStyle(.lRow)
                                .shellRowEntrance(index)
                            }
                        }
                    }
                }

                if !activity.isEmpty {
                    LSection("Updates", count: activity.count) {
                        VStack(spacing: 0) {
                            ForEach(Array(activity.enumerated()), id: \.element.0.id) { index, item in  // one row per task; summary messages often carry no message_id
                                NavigationLink(value: WorkspaceRoute.task(item.0.id)) {
                                    UpdateRow(task: item.0, message: item.1)
                                }
                                .buttonStyle(.lRow)
                                .shellRowEntrance(index)
                            }
                        }
                    }
                }

                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .refreshable {
            async let snapshot: Void = model.refresh()
            async let plan: Void = model.planUsage.refresh(bases: pairedBases)
            _ = await (snapshot, plan)
        }
    }
}

// MARK: - Header

private struct HomeHeader: View {
    @Environment(\.palette) private var p
    let snapshot: ContainerSnapshot
    let canEditObjective: Bool
    let onConnectRepo: () -> Void
    let onEditObjective: () -> Void

    private var aiAgents: [AgentDto] {
        MobileUx.orderAgents(snapshot.agents.filter { $0.kind == "ai" })
    }

    private var tally: String {
        let t = snapshot.tasks
        let inProgress = t.filter { $0.status == "in_progress" }.count
        let verify = t.filter { $0.status == "needs_verification" }.count
        let blocked = t.filter { $0.status == "blocked" }.count
        // Same set as the Tasks "Done" filter (completed + cancelled + failed).
        let done = t.filter { TaskScope.of($0.status) == .done }.count
        return "\(inProgress) in progress · \(verify) to verify · \(blocked) blocked · \(done) done"
    }

    /// The objective; owners / manage_autonomy tap it to edit (web ObjectiveRow).
    @ViewBuilder
    private var objective: some View {
        let text = (snapshot.container.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if canEditObjective {
            Button(action: onEditObjective) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(text.isEmpty ? "Add an objective…" : text)
                        .ltype(.body)
                        .foregroundStyle(text.isEmpty ? p.muted : p.text2)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    Image(systemName: "pencil")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(p.faint)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(text.isEmpty ? "Add an objective" : "Edit objective: \(text)")
        } else if !text.isEmpty {
            Text(text)
                .ltype(.body)
                .foregroundStyle(p.text2)
                .lineLimit(3)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.s) {
            Text(snapshot.container.name)
                .ltype(.title)
                .foregroundStyle(p.text)
                .accessibilityAddTraits(.isHeader)
            objective
            Text(tally)
                .ltype(.meta)
                .foregroundStyle(p.muted)
            HStack(spacing: LSpace.s) {
                if !aiAgents.isEmpty {
                    AgentStack(agents: aiAgents)
                }
                GitHubRepoChip(repo: snapshot.container.githubRepo, action: onConnectRepo)
                if snapshot.container.githubRepo != nil {
                    // The portal's GitHub hub (issues/PRs) — only once a repo is bound.
                    NavigationLink(value: WorkspaceRoute.githubHub) {
                        Label("Hub", systemImage: "arrow.triangle.pull")
                            .ltype(.meta)
                            .foregroundStyle(p.text2)
                            .padding(.horizontal, LSpace.s)
                            .frame(minHeight: 28)
                            .overlay(Capsule().strokeBorder(p.border, lineWidth: 1))
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("GitHub hub")
                    .accessibilityHint("Open issues and pull requests to start work")
                }
                Spacer(minLength: 0)
            }
            .padding(.top, LSpace.xs)
        }
    }
}

/// Overlapping round avatars of the project's agents — a glance, read as one element.
private struct AgentStack: View {
    @Environment(\.palette) private var p
    let agents: [AgentDto]

    var body: some View {
        HStack(spacing: -6) {
            ForEach(agents.prefix(5)) { agent in
                // Plain faces in an overlapping stack: the ✦ badge and presence dot
                // sit where the next avatar overlaps and render as clipped fragments.
                LAvatar(name: agent.alias, size: 24)
                    .padding(1.5)
                    .background(p.bg, in: Circle())
            }
            if agents.count > 5 {
                Text("+\(agents.count - 5)")
                    .ltype(.micro)
                    .foregroundStyle(p.text2)
                    .frame(width: 27, height: 27)
                    .background(p.surface2, in: Circle())
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(agents.count) agents: \(agents.prefix(5).map(\.alias).joined(separator: ", "))")
    }
}

// MARK: - Rows

private struct HomeQuietRow: View {
    @Environment(\.palette) private var p
    let text: String

    var body: some View {
        Text(text)
            .ltype(.body)
            .foregroundStyle(p.muted)
            .padding(.horizontal, LSpace.m)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}

/// Needs-you row for plan approvals / verifications: status glyph, title, kind tag, time.
private struct NeedsYouRow: View {
    @Environment(\.palette) private var p
    let task: TaskDto
    let kind: String
    let tint: Color
    var reviewTag: String? = nil

    var body: some View {
        LRow(title: task.title, subtitle: reviewTag.map { "Review: \($0)" }) {
            LStatusGlyph(status: task.status)
        } trailing: {
            HStack(spacing: LSpace.s) {
                LTag(kind, tint: tint)
                if let ago = MobileUx.agoLabel(task.planMessage?.createdAt ?? task.startedAt ?? task.createdAt) {
                    Text(ago)
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                }
            }
        }
        .opacity(reviewTag == nil ? 1 : 0.65)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Review and decide")
    }
}

private struct NeedsYouRequestRow: View {
    @Environment(\.palette) private var p
    let request: RequestDto

    var body: some View {
        LRow(title: request.payload, subtitle: "\(request.requesterAlias ?? "agent") → you") {
            LAvatar(name: request.requesterAlias ?? "?", isAI: true, size: 20)
        } trailing: {
            HStack(spacing: LSpace.s) {
                LTag("Request", tint: p.danger)
                if let ago = MobileUx.agoLabel(request.createdAt) {
                    Text(ago)
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Respond")
    }
}

/// Active-work row: priority, short id (mono), status, title, assignee avatar.
private struct ActiveTaskRow: View {
    @Environment(\.palette) private var p
    let task: TaskDto

    var body: some View {
        LRow(title: task.title) {
            HStack(spacing: LSpace.s) {
                LPriorityGlyph(priority: task.priority)
                Text(task.shortId)
                    .ltype(.mono)
                    .foregroundStyle(p.muted)
                LStatusGlyph(status: task.status)
            }
        } trailing: {
            if let assignee = task.assignees.first {
                LAvatar(name: assignee, isAI: true, size: 20)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(task.title)
        .accessibilityValue([MobileUx.statusCopy(task.status), task.assignees.first.map { "assigned to \($0)" }]
            .compactMap { $0 }.joined(separator: ", "))
    }
}

/// Updates feed row: avatar, actor + action, muted time.
private struct UpdateRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let task: TaskDto
    let message: TaskMessageDto

    private var actor: String {
        message.authorAlias ?? (message.isHuman ? "you" : "system")
    }

    var body: some View {
        HStack(alignment: .top, spacing: LSpace.m) {
            LAvatar(name: actor, isAI: !message.isHuman, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: LSpace.xs) {
                    Text(actor)
                        .ltype(.bodyEmph)
                        .foregroundStyle(p.text)
                    Text("on \(task.title)")
                        .ltype(.body)
                        .foregroundStyle(p.text2)
                        .lineLimit(1)
                    Spacer(minLength: LSpace.s)
                    Text(MobileUx.agoLabel(message.createdAt) ?? "")
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                }
                Text(ActivityCopy.preview(message.body))
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, LSpace.s + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Motion

/// Rows fade + rise into place once, staggered by index; static under Reduce Motion.
private struct ShellRowEntrance: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    let index: Int

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .onAppear {
                guard !shown, !reduceMotion else { shown = true; return }
                withAnimation(.lSpring.delay(Double(min(index, 8)) * 0.035)) {
                    shown = true
                }
            }
    }
}

extension View {
    /// One-time staggered fade/slide-in for list rows (Reduce Motion aware).
    func shellRowEntrance(_ index: Int) -> some View {
        modifier(ShellRowEntrance(index: index))
    }
}
