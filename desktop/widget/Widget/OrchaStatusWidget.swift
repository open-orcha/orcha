import WidgetKit
import SwiftUI
import os

private let appGroupId = "N2597TV587.orcha"
private let logger = Logger(subsystem: "ai.quantal.orcha.widget", category: "provider")

struct OrchaStatus: Codable {
  struct AgentRow: Codable {
    let alias: String
    let kind: String
    let status: String
    // v3 fields — optional so decode never fails on older/newer files.
    let model: String?
    let task: String?
  }
  struct TaskCounts: Codable {
    let inProgress: Int
    let needsVerification: Int
    // v3 field — optional so decode never fails on older/newer files.
    let ready: Int?
  }
  struct AttentionRow: Codable {
    let projectShort: String
    let kind: String
    let title: String
  }
  struct StackRow: Codable {
    let projectShort: String
    let running: Bool
    let attention: Int
    // v2 fields — optional so decode never fails on older/newer files.
    let working: Int?
    let agents: [AgentRow]?
    let tasks: TaskCounts?
  }
  let v: Int
  let updatedAt: String
  let totalAttention: Int
  let stacks: [StackRow]
  // v2 field — optional so decode never fails on older/newer files.
  let attention: [AttentionRow]?
}

private func loadStatus() -> (OrchaStatus, Date)? {
  guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
  else {
    logger.error("loadStatus: nil container for app group \(appGroupId, privacy: .public)")
    return nil
  }
  logger.info("loadStatus: container \(dir.path, privacy: .public)")
  let url = dir.appendingPathComponent("status.json")
  let data: Data
  do {
    data = try Data(contentsOf: url)
    logger.info("loadStatus: read ok, \(data.count, privacy: .public) bytes")
  } catch {
    logger.error("loadStatus: read failed: \(String(describing: error), privacy: .public)")
    return nil
  }
  let status: OrchaStatus
  do {
    status = try JSONDecoder().decode(OrchaStatus.self, from: data)
    logger.info(
      "loadStatus: decode ok, v\(status.v, privacy: .public), \(status.stacks.count, privacy: .public) stacks")
  } catch {
    logger.error("loadStatus: decode failed: \(String(describing: error), privacy: .public)")
    return nil
  }
  let fmt = ISO8601DateFormatter()
  fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let updated = fmt.date(from: status.updatedAt) ?? .distantPast
  let age = Date().timeIntervalSince(updated)
  logger.info(
    "loadStatus: updatedAt \(status.updatedAt, privacy: .public), age \(Int(age), privacy: .public)s, stale \(age > 120, privacy: .public)")
  return (status, updated)
}

extension OrchaStatus {
  /// Representative data for the widget gallery; never shown for an added widget
  /// unless real data is unavailable in a preview context.
  static func sample() -> OrchaStatus {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return OrchaStatus(
      v: 3,
      updatedAt: fmt.string(from: .now),
      totalAttention: 2,
      stacks: [
        .init(
          projectShort: "quantal-ehr", running: true, attention: 2, working: 1,
          agents: [
            .init(
              alias: "Plum", kind: "ai", status: "working", model: "opus-4-8",
              task: "Foundation layer: migration runner + schema + audit"),
            .init(alias: "Atlas", kind: "ai", status: "awaiting_request", model: "opus-4-8", task: nil),
            .init(alias: "Crimson", kind: "ai", status: "idle", model: "sonnet-4-6", task: nil),
          ],
          tasks: .init(inProgress: 1, needsVerification: 1, ready: 2)
        ),
        .init(
          projectShort: "quantallabs-web", running: true, attention: 0, working: 0,
          agents: [], tasks: .init(inProgress: 0, needsVerification: 0, ready: 1)
        ),
      ],
      attention: [
        .init(
          projectShort: "quantal-ehr", kind: "request_answer",
          title: "[Atlas → operator] Which auth provider for the portal?"),
        .init(
          projectShort: "quantal-ehr", kind: "task_verify",
          title: "Verify: patient search API pagination"),
      ]
    )
  }
}

struct Entry: TimelineEntry {
  let date: Date
  let status: OrchaStatus?
  let stale: Bool
}

struct Provider: TimelineProvider {
  func placeholder(in _: Context) -> Entry { .init(date: .now, status: .sample(), stale: false) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    let entry = makeEntry()
    if context.isPreview, entry.status == nil {
      completion(.init(date: .now, status: .sample(), stale: false))
    } else {
      completion(entry)
    }
  }
  func getTimeline(in _: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [makeEntry()], policy: .after(Date().addingTimeInterval(300))))
  }
  private func makeEntry() -> Entry {
    if let (status, updated) = loadStatus() {
      return .init(date: .now, status: status, stale: Date().timeIntervalSince(updated) > 120)
    }
    return .init(date: .now, status: nil, stale: true)
  }
}

private let cream = Color(red: 239 / 255, green: 233 / 255, blue: 223 / 255)
private let amber = Color(red: 240 / 255, green: 185 / 255, blue: 75 / 255)
private let green = Color(red: 66 / 255, green: 217 / 255, blue: 138 / 255)
private let teal = Color(red: 31 / 255, green: 199 / 255, blue: 205 / 255)
private let tile = Color(red: 29 / 255, green: 27 / 255, blue: 24 / 255)

// MARK: - Deep links

/// Builds an `orcha://open` deep link into the desktop app (handled by the Electron
/// protocol parser). `projectShort` in the schema carries the short name WITHOUT the
/// `orcha-` compose prefix; the full project is `orcha-` + projectShort.
/// With no running stack we fall back to a plain `orcha://open` (app just comes forward).
private func deepLink(status: OrchaStatus?, path: String? = nil) -> URL {
  var components = URLComponents()
  components.scheme = "orcha"
  components.host = "open"
  if let short = status?.stacks.first(where: { $0.running })?.projectShort {
    var items = [URLQueryItem(name: "project", value: "orcha-\(short)")]
    if let path {
      items.append(URLQueryItem(name: "path", value: path))
    }
    components.queryItems = items
  }
  return components.url ?? URL(string: "orcha://open")!
}

struct RingView: View {
  let entry: Entry
  var body: some View {
    let count = entry.status?.totalAttention ?? 0
    let clear = count == 0
    ZStack {
      Circle().stroke(entry.stale ? Color.gray.opacity(0.4) : (clear ? green : amber), lineWidth: 5)
      VStack(spacing: 2) {
        if entry.stale || entry.status == nil {
          Text("OFFLINE").font(.system(size: 9, weight: .semibold)).foregroundStyle(.gray)
        } else if clear {
          Text("ALL CLEAR").font(.system(size: 9, weight: .semibold)).foregroundStyle(green)
        } else {
          Text("\(count)").font(.system(size: 26, weight: .bold)).foregroundStyle(cream)
          Text("PENDING").font(.system(size: 8, weight: .semibold)).foregroundStyle(amber)
        }
      }
    }
  }
}

struct SmallView: View {
  let entry: Entry
  var body: some View {
    RingView(entry: entry)
      .padding(6)
      .containerBackground(tile, for: .widget)
  }
}

struct MediumView: View {
  let entry: Entry
  var body: some View {
    HStack(spacing: 14) {
      RingView(entry: entry).frame(width: 84, height: 84)
      VStack(alignment: .leading, spacing: 5) {
        ForEach((entry.status?.stacks ?? []).prefix(4), id: \.projectShort) { s in
          HStack(spacing: 6) {
            Circle().fill(s.running ? green : Color.gray.opacity(0.5)).frame(width: 6, height: 6)
            Text(s.projectShort).font(.system(size: 12, weight: .semibold)).foregroundStyle(cream)
              .lineLimit(1)
            Spacer(minLength: 4)
            if s.attention > 0 {
              Text("\(s.attention)").font(.system(size: 11, weight: .bold)).foregroundStyle(amber)
            }
          }
        }
        if entry.status?.stacks.isEmpty != false {
          Text(entry.stale ? "Orcha app not running" : "No stacks yet")
            .font(.system(size: 11)).foregroundStyle(.gray)
        }
      }
    }
    .padding(4)
    .containerBackground(tile, for: .widget)
  }
}

struct OfflineView: View {
  let stale: Bool
  var body: some View {
    Text(stale ? "Orcha app not running" : "No stacks yet")
      .font(.system(size: 11)).foregroundStyle(.gray)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

// MARK: - Orcha Agents

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

// MARK: - Orcha Pipeline

struct PipelineBarView: View {
  let ready: Int
  let inProgress: Int
  let needsVerification: Int

  private struct Segment: Identifiable {
    let id: Int
    let count: Int
    let color: Color
  }

  var body: some View {
    let segments = [
      Segment(id: 0, count: ready, color: Color.gray.opacity(0.5)),
      Segment(id: 1, count: inProgress, color: teal),
      Segment(id: 2, count: needsVerification, color: amber),
    ].filter { $0.count > 0 }
    GeometryReader { geo in
      let spacing: CGFloat = 2
      let minSegmentWidth: CGFloat = 10
      let total = CGFloat(segments.reduce(0) { $0 + $1.count })
      let available = geo.size.width - spacing * CGFloat(max(segments.count - 1, 0))
      // Every non-zero segment gets at least minSegmentWidth; the remainder is
      // distributed proportionally to counts, so widths always sum to the bar width.
      let flexible = max(available - minSegmentWidth * CGFloat(segments.count), 0)
      HStack(spacing: spacing) {
        ForEach(segments) { segment in
          RoundedRectangle(cornerRadius: 2)
            .fill(segment.color)
            .frame(width: minSegmentWidth + flexible * CGFloat(segment.count) / max(total, 1))
        }
      }
    }
    .frame(height: 6)
  }
}

struct PipelineStackRow: View {
  let stack: OrchaStatus.StackRow
  var body: some View {
    let ready = stack.tasks?.ready ?? 0
    let inProgress = stack.tasks?.inProgress ?? 0
    let verify = stack.tasks?.needsVerification ?? 0
    let total = ready + inProgress + verify
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Text(stack.projectShort).font(.system(size: 11, weight: .semibold)).foregroundStyle(cream)
          .lineLimit(1)
        Spacer(minLength: 4)
        if total > 0 {
          Text("\(ready) ready · \(inProgress) working · \(verify) verify")
            .font(.system(size: 9)).foregroundStyle(.gray)
            .lineLimit(1)
        }
      }
      if total > 0 {
        PipelineBarView(ready: ready, inProgress: inProgress, needsVerification: verify)
      } else {
        Text("no tasks").font(.system(size: 9)).foregroundStyle(.gray)
      }
    }
  }
}

struct PipelineView: View {
  let entry: Entry
  var body: some View {
    Group {
      if let status = entry.status, !entry.stale,
         status.stacks.contains(where: { $0.running }) {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(status.stacks.filter(\.running).prefix(3), id: \.projectShort) { stack in
            PipelineStackRow(stack: stack)
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

struct OrchaPipelineWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaPipelineWidget", provider: Provider()) { entry in
      PipelineView(entry: entry)
        .widgetURL(deepLink(status: entry.status))
    }
    .configurationDisplayName("Orcha Pipeline")
    .description("Task flow across your stacks.")
    .supportedFamilies([.systemMedium])
  }
}

// MARK: - Orcha Attention

private func attentionKindLabel(_ kind: String) -> String {
  switch kind {
  case "request_answer": return "escalation"
  case "request_close": return "close"
  case "task_verify": return "verify"
  case "health": return "health"
  default: return kind
  }
}

struct AttentionRowView: View {
  let item: OrchaStatus.AttentionRow
  var body: some View {
    HStack(spacing: 6) {
      Text(attentionKindLabel(item.kind).uppercased())
        .font(.system(size: 7, weight: .semibold)).foregroundStyle(amber)
        .padding(.horizontal, 4).padding(.vertical, 1)
        .background(amber.opacity(0.12), in: Capsule())
      Text(item.title).font(.system(size: 11)).foregroundStyle(cream)
        .lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 4)
      Text(item.projectShort).font(.system(size: 9)).foregroundStyle(.gray)
        .lineLimit(1)
    }
  }
}

struct AttentionView: View {
  let entry: Entry
  var body: some View {
    Group {
      if let status = entry.status, !entry.stale {
        let items = status.attention ?? []
        VStack(alignment: .leading, spacing: 6) {
          if status.totalAttention > 0 {
            Text("NEEDS ATTENTION · \(status.totalAttention)")
              .font(.system(size: 9, weight: .semibold)).foregroundStyle(amber)
          } else {
            Text("ALL CLEAR")
              .font(.system(size: 9, weight: .semibold)).foregroundStyle(green)
          }
          ForEach(Array(items.prefix(8).enumerated()), id: \.offset) { _, item in
            AttentionRowView(item: item)
          }
          if items.isEmpty {
            Text("Nothing waiting on you.")
              .font(.system(size: 11)).foregroundStyle(.gray)
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

struct OrchaAttentionWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaAttentionWidget", provider: Provider()) { entry in
      AttentionView(entry: entry)
        .widgetURL(deepLink(status: entry.status, path: "/requests"))
    }
    .configurationDisplayName("Orcha Attention")
    .description("What's waiting on you.")
    .supportedFamilies([.systemLarge])
  }
}

struct OrchaStatusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaStatusWidget", provider: Provider()) { entry in
      OrchaWidgetView(entry: entry)
        .widgetURL(deepLink(status: entry.status))
    }
    .configurationDisplayName("Orcha")
    .description("Stacks and what needs your attention.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct OrchaWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: Entry
  var body: some View {
    switch family {
    case .systemMedium: MediumView(entry: entry)
    default: SmallView(entry: entry)
    }
  }
}

@main
struct OrchaWidgetBundle: WidgetBundle {
  var body: some Widget {
    OrchaStatusWidget()
    OrchaAgentsWidget()
    OrchaPipelineWidget()
    OrchaAttentionWidget()
  }
}
