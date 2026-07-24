import SwiftUI
import WidgetKit

// Orcha home-screen widgets — glanceable supervision. Read-only by design:
// nothing state-changing lives on a widget (accidental taps, no way to read
// a plan first); every tap deep-links into the app instead.

@main
struct OrchaWidgetBundle: WidgetBundle {
    var body: some Widget {
        NeedsYouWidget()
        WorkspaceGlanceWidget()
        WorkspaceBoardWidget()
        FleetWidget()
    }
}

// MARK: - timeline

struct OrchaEntry: TimelineEntry {
    let date: Date
    let all: [WidgetWorkspace]

    var workspace: WidgetWorkspace? { all.first }
    var othersNeedYou: Int { all.dropFirst().reduce(0) { $0 + $1.needsYou } }
}

struct OrchaProvider: TimelineProvider {
    func placeholder(in context: Context) -> OrchaEntry {
        OrchaEntry(
            date: .now,
            all: [WidgetWorkspace(
                id: "placeholder", name: "Orcha Release", verify: 2, plans: 1, escalations: 0,
                agents: [
                    WidgetAgent(alias: "Forge", status: "working"),
                    WidgetAgent(alias: "Muse", status: "idle"),
                ],
                headline: "Forge reports the deploy workflow drafted.",
                updatedAt: .now,
                items: [
                    WidgetItem(id: "t1", kind: "plan", title: "Harden payments module"),
                    WidgetItem(id: "t2", kind: "verify", title: "Deploy workflow draft"),
                ]
            )]
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (OrchaEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OrchaEntry>) -> Void) {
        // The app force-reloads timelines whenever it writes fresh state; this
        // 30-minute horizon is just the fallback cadence.
        completion(Timeline(entries: [entry()], policy: .after(.now.addingTimeInterval(30 * 60))))
    }

    private func entry() -> OrchaEntry {
        OrchaEntry(date: .now, all: WidgetStore.load())
    }
}

// MARK: - shared bits

private func deepLink(_ workspace: WidgetWorkspace?) -> URL? {
    guard let id = workspace?.id else { return URL(string: "orcha://open") }
    return URL(string: "orcha://needs/\(id)")
}

private func itemLink(_ item: WidgetItem, in workspace: WidgetWorkspace) -> URL {
    // Plans get their own host: the app auto-presents the read-first plan
    // sheet, so a tap means "show me the plan", never "approve it".
    let host = switch item.kind {
    case "request": "request"
    case "plan": "plan"
    default: "task"
    }
    return URL(string: "orcha://\(host)/\(workspace.id)/\(item.id)")
        ?? URL(string: "orcha://needs/\(workspace.id)")!
}

private func kindSymbol(_ kind: String) -> String {
    switch kind {
    case "plan": "signature"
    case "verify": "checkmark.seal"
    default: "hand.raised"
    }
}

private func kindColor(_ kind: String) -> Color {
    switch kind {
    case "plan": .indigo
    case "verify": .orange
    default: .red
    }
}

private func agentColor(_ status: String) -> Color {
    switch status {
    case "working", "in_progress": .teal
    case "blocked", "failed", "terminated": .red
    case "awaiting_human", "needs_verification": .orange
    default: .gray
    }
}

private struct ItemRow: View {
    let item: WidgetItem
    var size: CGFloat = 11.5

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: kindSymbol(item.kind))
                .font(.system(size: size - 2, weight: .semibold))
                .foregroundStyle(kindColor(item.kind))
                .frame(width: size)
            Text(item.title)
                .font(.system(size: size, weight: .medium))
                .lineLimit(1)
                .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
    }
}

private struct AgentDots: View {
    let agents: [WidgetAgent]
    var limit = 4

    var body: some View {
        HStack(spacing: 10) {
            ForEach(agents.prefix(limit), id: \.alias) { agent in
                HStack(spacing: 4) {
                    Circle()
                        .fill(agentColor(agent.status))
                        .frame(width: 6, height: 6)
                    Text(agent.alias)
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                }
            }
        }
        .foregroundStyle(.secondary)
    }
}

// MARK: - needs-you widget (small + lock screen)

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaNeedsYou", provider: OrchaProvider()) { entry in
            NeedsYouView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(deepLink(entry.workspace))
        }
        .configurationDisplayName("Needs you")
        .description("How much waits on your decision, at a glance.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryInline, .accessoryRectangular])
    }
}

struct NeedsYouView: View {
    @Environment(\.widgetFamily) private var family
    let entry: OrchaEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("\(entry.workspace?.needsYou ?? 0)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                    Text("ORCHA")
                        .font(.system(size: 7, weight: .semibold))
                        .opacity(0.7)
                }
            }
        case .accessoryInline:
            let count = entry.workspace?.needsYou ?? 0
            Text(count == 0 ? "Orcha: all clear" : "Orcha: \(count) need you")
        case .accessoryRectangular:
            rectangularView
        default:
            smallView
        }
    }

    private var rectangularView: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(entry.workspace?.name ?? "Orcha")
                .font(.system(size: 12, weight: .bold))
                .lineLimit(1)
            let count = entry.workspace?.needsYou ?? 0
            Text(count == 0 ? "All clear" : "\(count) need you")
                .font(.system(size: 12, weight: .semibold))
            if let top = entry.workspace?.topItems.first {
                Text(top.title)
                    .font(.system(size: 11))
                    .opacity(0.75)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: "bell.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.orange)
                Text(entry.workspace?.name ?? "Orcha")
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
            Text("\(entry.workspace?.needsYou ?? 0)")
                .font(.system(size: 40, weight: .heavy, design: .rounded))
                .foregroundStyle((entry.workspace?.needsYou ?? 0) > 0 ? .primary : .secondary)
                .padding(.vertical, -2)
            Spacer(minLength: 0)
            if let w = entry.workspace, w.needsYou > 0 {
                VStack(alignment: .leading, spacing: 3) {
                    if w.plans > 0 { countRow(w.plans, "to approve", "plan") }
                    if w.verify > 0 { countRow(w.verify, "to verify", "verify") }
                    if w.escalations > 0 { countRow(w.escalations, w.escalations == 1 ? "escalation" : "escalations", "request") }
                }
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(.green)
                    Text(entry.workspace == nil ? "open the app to pair" : "all clear")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
            if entry.othersNeedYou > 0 {
                Text("+\(entry.othersNeedYou) elsewhere")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func countRow(_ count: Int, _ label: String, _ kind: String) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(kindColor(kind))
                .frame(width: 6, height: 6)
            Text("\(count) \(label)")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

// MARK: - workspace glance (medium)

struct WorkspaceGlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaGlance", provider: OrchaProvider()) { entry in
            GlanceView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(deepLink(entry.workspace))
        }
        .configurationDisplayName("Workspace glance")
        .description("Agents, what waits on you, and the on-device headline.")
        .supportedFamilies([.systemMedium])
    }
}

struct GlanceView: View {
    let entry: OrchaEntry

    var body: some View {
        if let w = entry.workspace {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(w.name)
                        .font(.system(size: 13, weight: .bold))
                        .lineLimit(1)
                    Spacer()
                    if w.needsYou > 0 {
                        Text("\(w.needsYou) need you")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.orange)
                    } else {
                        Text("all clear")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                AgentDots(agents: w.agents)
                ForEach(w.topItems.prefix(2)) { item in
                    Link(destination: itemLink(item, in: w)) {
                        ItemRow(item: item)
                    }
                }
                if let headline = w.headline, !headline.isEmpty {
                    HStack(alignment: .top, spacing: 5) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 9))
                            .foregroundStyle(.tint)
                            .padding(.top, 2)
                        Text(headline)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(w.topItems.isEmpty ? 3 : 1)
                    }
                }
                Spacer(minLength: 0)
                Text("updated \(w.updatedAt, style: .relative) ago")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            PairHint()
        }
    }
}

// MARK: - workspace board (large)

struct WorkspaceBoardWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaBoard", provider: OrchaProvider()) { entry in
            BoardView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(deepLink(entry.workspace))
        }
        .configurationDisplayName("Workspace board")
        .description("The full needs-you queue with agents and the headline.")
        .supportedFamilies([.systemLarge])
    }
}

struct BoardView: View {
    let entry: OrchaEntry

    var body: some View {
        if let w = entry.workspace {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(w.name)
                        .font(.system(size: 15, weight: .bold))
                        .lineLimit(1)
                    Spacer()
                    if w.needsYou > 0 {
                        Text("\(w.needsYou) need you")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.orange)
                    } else {
                        Text("all clear")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                if let headline = w.headline, !headline.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 10))
                            .foregroundStyle(.tint)
                            .padding(.top, 2)
                        Text(headline)
                            .font(.system(size: 12.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                if w.topItems.isEmpty {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.green)
                        Text("Nothing waits on you")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(w.topItems.prefix(5)) { item in
                            Link(destination: itemLink(item, in: w)) {
                                ItemRow(item: item, size: 12.5)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
                AgentDots(agents: w.agents, limit: 6)
                Text("updated \(w.updatedAt, style: .relative) ago")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            PairHint()
        }
    }
}

// MARK: - fleet (medium, all workspaces)

struct FleetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaFleet", provider: OrchaProvider()) { entry in
            FleetView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("All workspaces")
        .description("Every paired workspace with what waits on you in each.")
        .supportedFamilies([.systemMedium])
    }
}

struct FleetView: View {
    let entry: OrchaEntry

    var body: some View {
        if entry.all.isEmpty {
            PairHint()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(entry.all.prefix(3)) { w in
                    Link(destination: URL(string: "orcha://needs/\(w.id)")!) {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(w.name)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .lineLimit(1)
                                AgentDots(agents: w.agents, limit: 3)
                            }
                            Spacer(minLength: 4)
                            if w.needsYou > 0 {
                                Text("\(w.needsYou)")
                                    .font(.system(size: 14, weight: .heavy, design: .rounded))
                                    .foregroundStyle(.orange)
                            } else {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                }
                if entry.all.count == 1 {
                    Text("Pair more workspaces in the app to fill this widget.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - empty state

private struct PairHint: View {
    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: "waveform.path")
                .font(.system(size: 18))
                .foregroundStyle(.secondary)
            Text("Open Orcha and pair a workspace")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
