// Owns the agent roster rows, layouts, and widget configuration.
import SwiftUI
import WidgetKit

private enum RosterRow: Identifiable {
  case header(OrchaStatus.StackRow)
  case agent(stack: String, agent: OrchaStatus.AgentRow)

  var id: String {
    switch self {
    case .header(let s): return "h-\(s.projectShort)"
    case .agent(let stack, let agent): return "a-\(stack)-\(agent.alias)"
    }
  }
}

private func rosterRows(_ status: OrchaStatus, maxAgentRows: Int) -> [RosterRow] {
  var rows: [RosterRow] = []
  var agentCount = 0
  for stack in status.stacks where stack.running {
    guard agentCount < maxAgentRows else { break }
    rows.append(.header(stack))
    for agent in stack.agents ?? [] {
      guard agentCount < maxAgentRows else { break }
      rows.append(.agent(stack: stack.projectShort, agent: agent))
      agentCount += 1
    }
  }
  return rows
}

struct StackHeaderRow: View {
  let stack: OrchaStatus.StackRow

  var body: some View {
    let working = stack.working ?? (stack.agents ?? []).filter { $0.status == "working" }.count
    HStack(spacing: 6) {
      Circle().fill(stack.running ? green : Color.gray.opacity(0.5)).frame(width: 6, height: 6)
      Text(stack.projectShort).font(.system(size: 11, weight: .semibold)).foregroundStyle(cream)
        .lineLimit(1)
      Spacer(minLength: 4)
      Text("\(working) working").font(.system(size: 9)).foregroundStyle(.gray)
    }
  }
}

struct AgentRowView: View {
  let agent: OrchaStatus.AgentRow

  var body: some View {
    let isWorking = agent.status == "working"
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Circle().fill(isWorking ? green : Color.gray.opacity(0.5)).frame(width: 5, height: 5)
        Text(agent.alias).font(.system(size: 12, weight: .semibold)).foregroundStyle(cream)
          .lineLimit(1)
        Text(agent.kind.uppercased())
          .font(.system(size: 7, weight: .semibold)).foregroundStyle(.gray)
          .padding(.horizontal, 4).padding(.vertical, 1)
          .background(Color.white.opacity(0.08), in: Capsule())
        if let model = agent.model {
          Text(model)
            .font(.system(size: 7, weight: .medium)).foregroundStyle(.gray)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(Color.white.opacity(0.05), in: Capsule())
            .lineLimit(1)
        }
        Spacer(minLength: 4)
        Text(agent.status.replacingOccurrences(of: "_", with: " "))
          .font(.system(size: 10)).foregroundStyle(isWorking ? green : .gray)
          .lineLimit(1)
      }
      if isWorking, let task = agent.task {
        Text(task)
          .font(.system(size: 10)).foregroundStyle(.gray)
          .lineLimit(1).truncationMode(.tail)
          .padding(.leading, 11)
      }
    }
    .padding(.leading, 8)
  }
}

struct AgentsView: View {
  let entry: Entry
  let maxAgentRows: Int

  var body: some View {
    Group {
      if let status = entry.status, !entry.stale,
         status.stacks.contains(where: { $0.running }) {
        VStack(alignment: .leading, spacing: 5) {
          ForEach(rosterRows(status, maxAgentRows: maxAgentRows)) { row in
            switch row {
            case .header(let stack): StackHeaderRow(stack: stack)
            case .agent(_, let agent): AgentRowView(agent: agent)
            }
          }
          Spacer(minLength: 0)
        }
      } else {
        OfflineView(stale: entry.stale)
      }
    }
    .padding(4)
    .containerBackground(tile, for: .widget)
  }
}

struct OrchaAgentsWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: Entry

  var body: some View {
    // Two-line working rows cost more vertical space than the old single-line
    // rows, so budgets are lower than before (was 4 / 10).
    AgentsView(entry: entry, maxAgentRows: family == .systemLarge ? 8 : 3)
      .widgetURL(deepLink(status: entry.status, path: "/agents"))
  }
}

struct OrchaAgentsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaAgentsWidget", provider: Provider()) { entry in
      OrchaAgentsWidgetView(entry: entry)
    }
    .configurationDisplayName("Orcha Agents")
    .description("Who's working across your stacks.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}
