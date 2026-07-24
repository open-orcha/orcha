import SwiftUI

// Responsibility: Agent persona, memory, request summary, recent runs, and toolbar actions.

extension AgentDetailScreen {
    // MARK: Persona (flow 09 §6 — collapsed preview, expand to full system prompt)

    @ViewBuilder
    func persona(_ agent: AgentDto) -> some View {
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
    func memory() -> some View {
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
    func requestsSummary() -> some View {
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
    func recentRuns(_ agent: AgentDto) -> some View {
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
    var toolbarMenu: some ToolbarContent {
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

    func cadence(_ secs: Int) -> String {
        secs < 3600 ? "Every \(secs / 60)m" : "Every \(secs / 3600)h"
    }

    /// Fill in agent identity on a run row (headless runs may omit it) so the row
    /// and the pushed run-log route both resolve the owning agent.
    func normalize(_ run: RunDto, agent: AgentDto) -> RunDto {
        var r = run
        r.agentId = r.agentId ?? agent.id
        r.agentAlias = r.agentAlias ?? agent.alias
        return r
    }
}
