import SwiftUI

/// Flow 04 H5/H6 — the Home tab: needs-you queue, agents glance, stat tiles, activity.
struct HomeTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Binding var showCreateTask: Bool
    @State private var planSheetTask: TaskDto?
    @State private var verifySheetTask: TaskDto?

    var body: some View {
        Group {
            if model.snapshot == nil && model.loading {
                skeleton
            } else if model.snapshot == nil {
                UnreachableState()
            } else {
                content
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Create task", systemImage: "plus") { showCreateTask = true }
            }
        }
        .sheet(item: $planSheetTask) { task in
            PlanApprovalSheet(task: task)
        }
        .sheet(item: $verifySheetTask) { task in
            VerifySheet(task: task)
        }
    }

    private var skeleton: some View {
        ScrollView {
            VStack(spacing: 10) {
                SkeletonBlock(height: 96)
                SkeletonBlock(height: 96)
                HStack(spacing: 8) {
                    SkeletonBlock(height: 74)
                    SkeletonBlock(height: 74)
                    SkeletonBlock(height: 74)
                    SkeletonBlock(height: 74)
                }
                SkeletonBlock(height: 96)
            }
            .padding(16)
        }
    }

    private var content: some View {
        let snapshot = model.snapshot!
        let tasks = snapshot.tasks
        let plans = tasks.filter { $0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil }
        let verifs = tasks.filter { $0.status == "needs_verification" }
        let reqs = snapshot.requests.filter { $0.status == "open" && ($0.targetId == model.humanId || $0.targetId == nil) }
        let activity: [(TaskDto, TaskMessageDto)] = tasks
            .compactMap { task in task.messageSummary?.last.map { (task, $0) } }
            .sorted { ($0.1.createdAt ?? "") > ($1.1.createdAt ?? "") }
            .prefix(8)
            .map { $0 }

        return ScrollView {
            VStack(spacing: 10) {
                ConnectionBanners()
                SectionH(title: "Needs you", count: "\(plans.count + verifs.count + reqs.count)")
                if plans.isEmpty && verifs.isEmpty && reqs.isEmpty {
                    OrchaCard {
                        Text("Nothing needs you right now.")
                            .foregroundStyle(p.muted)
                    }
                }
                ForEach(plans) { task in
                    QueueCard(kicker: "PLAN APPROVAL", kickerColor: p.violet, task: task) {
                        planSheetTask = task
                    }
                }
                ForEach(verifs) { task in
                    QueueCard(kicker: "VERIFY TASK", kickerColor: p.ok, task: task) {
                        verifySheetTask = task
                    }
                }
                ForEach(reqs) { req in
                    NavigationLink(value: WorkspaceRoute.request(req.id)) {
                        RequestQueueCard(request: req, humanId: model.humanId)
                    }
                    .buttonStyle(.plain)
                }

                SectionH(title: "Agents", count: "\(snapshot.agents.count)")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(MobileUx.orderAgents(snapshot.agents.filter { $0.kind == "ai" })) { agent in
                            NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                                OrchaCard {
                                    HStack(spacing: 8) {
                                        AgentAvatar(alias: agent.alias, size: 30)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(agent.alias)
                                                .font(.system(size: 15, weight: .semibold))
                                                .foregroundStyle(p.text)
                                                .lineLimit(1)
                                            StatusPill(status: agent.status ?? "idle", domain: .agent)
                                        }
                                    }
                                }
                                .frame(width: 176)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                SectionH(title: "Tasks")
                HStack(spacing: 8) {
                    StatTile(value: "\(tasks.filter { $0.status == "in_progress" }.count)", label: "In progress", tint: p.accent)
                    StatTile(value: "\(verifs.count)", label: "Needs verify", tint: p.violet)
                    StatTile(value: "\(tasks.filter { $0.status == "blocked" }.count)", label: "Blocked", tint: p.warn)
                    StatTile(value: "\(tasks.filter { $0.status == "completed" }.count)", label: "Done", tint: p.ok)
                }

                if !activity.isEmpty {
                    SectionH(title: "Activity")
                    ForEach(activity, id: \.1.messageId) { task, msg in
                        NavigationLink(value: WorkspaceRoute.task(task.id)) {
                            OrchaCard {
                                HStack(alignment: .top, spacing: 10) {
                                    AgentAvatar(alias: msg.authorAlias ?? (msg.isHuman ? "H" : "?"), human: msg.isHuman, size: 30)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack {
                                            Text(msg.authorAlias ?? (msg.isHuman ? "you" : "system"))
                                                .font(.system(size: 15, weight: .semibold))
                                                .foregroundStyle(p.text)
                                            Spacer()
                                            Text(MobileUx.agoLabel(msg.createdAt) ?? "")
                                                .font(.system(size: 10.5, design: .monospaced))
                                                .foregroundStyle(p.faint)
                                        }
                                        Text(msg.body)
                                            .font(.system(size: 13))
                                            .foregroundStyle(p.text2)
                                            .lineLimit(2)
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(16)
        }
        .refreshable { await model.refresh() }
    }
}

/// A needs-you queue card for plan approvals / verifications (flow 04 H5).
private struct QueueCard: View {
    @Environment(\.palette) private var p
    let kicker: String
    let kickerColor: Color
    let task: TaskDto
    let onAct: () -> Void

    var body: some View {
        OrchaCard {
            HStack {
                Text(kicker)
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(kickerColor)
                Spacer()
                StatusPill(status: task.status, domain: .task)
            }
            NavigationLink(value: WorkspaceRoute.task(task.id)) {
                Text(task.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(p.text)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
            }
            .buttonStyle(.plain)
            if let excerpt = task.planMessage?.body ?? task.definitionOfDone, !excerpt.isEmpty {
                Text(excerpt)
                    .font(.system(size: 13))
                    .foregroundStyle(p.muted)
                    .lineLimit(2)
            }
            KitButton(title: "Review & decide", role: .tonal, small: true, action: onAct)
        }
    }
}

private struct RequestQueueCard: View {
    @Environment(\.palette) private var p
    let request: RequestDto
    let humanId: String?

    var body: some View {
        OrchaCard {
            HStack {
                Text("REQUEST FOR YOU")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(p.info)
                Spacer()
                StatusPill(status: request.status, domain: .request)
            }
            Text("“\(request.payload)”")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(p.text)
                .lineLimit(3)
            HStack(spacing: 8) {
                AgentAvatar(alias: request.requesterAlias ?? "?", size: 30)
                Text("\(request.requesterAlias ?? "agent") → you\(MobileUx.agoLabel(request.createdAt).map { " · \($0)" } ?? "")")
                    .font(.system(size: 13))
                    .foregroundStyle(p.text2)
                Spacer()
                Text("Respond")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(p.accent)
            }
        }
    }
}
