import SwiftUI

// Responsibility: Agent attention, identity, current work, and human control sections.

extension AgentDetailScreen {
    // MARK: attention banners (flow 09 §1 — gate parity for this agent's tasks)

    @ViewBuilder
    func attentionBanners(_ agent: AgentDto) -> some View {
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

    func header(_ agent: AgentDto) -> some View {
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

    func nowTile(_ agent: AgentDto) -> (taskId: String?, title: String?, liveRun: RunDto?) {
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
    func nowSection(_ agent: AgentDto) -> some View {
        let (tid, title, liveRun) = nowTile(agent)
        if let tid {
            SectionH(title: "Now")
            NavigationLink(value: WorkspaceRoute.task(tid)) {
                OrchaCard {
                    HStack(spacing: 8) {
                        Text("▸").font(.system(size: 15, weight: .heavy)).foregroundStyle(p.accent)
                        Text(title ?? tid)
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
    func liveRunRow(_ run: RunDto?) -> some View {
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

    func controls(_ agent: AgentDto) -> some View {
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
    func controlRow(title: String, sub: String, tag: MetaTag, enabled: Bool, action: @escaping () -> Void) -> some View {
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

}

/// A non-interactive KitButton-styled label — used inside a `NavigationLink` so the
/// whole primary "Converse" affordance pushes the conversation route.
struct KitButtonLabel: View {
    @Environment(\.palette) var p
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
