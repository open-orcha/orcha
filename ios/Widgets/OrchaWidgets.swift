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
    }
}

// MARK: - timeline

struct OrchaEntry: TimelineEntry {
    let date: Date
    let workspace: WidgetWorkspace?
    let othersNeedYou: Int
}

struct OrchaProvider: TimelineProvider {
    func placeholder(in context: Context) -> OrchaEntry {
        OrchaEntry(
            date: .now,
            workspace: WidgetWorkspace(
                id: "placeholder", name: "Quantal EHR", verify: 2, plans: 1, escalations: 0,
                agents: [
                    WidgetAgent(alias: "Forge", status: "working"),
                    WidgetAgent(alias: "Muse", status: "idle"),
                ],
                headline: "Forge reports the deploy workflow drafted.",
                updatedAt: .now
            ),
            othersNeedYou: 0
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
        let all = WidgetStore.load()
        let primary = all.first
        let others = all.dropFirst().reduce(0) { $0 + $1.needsYou }
        return OrchaEntry(date: .now, workspace: primary, othersNeedYou: others)
    }
}

// MARK: - needs-you widget (small + lock screen)

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaNeedsYou", provider: OrchaProvider()) { entry in
            NeedsYouView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(deepLink(entry))
        }
        .configurationDisplayName("Needs you")
        .description("How much waits on your decision, at a glance.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryInline])
    }
}

private func deepLink(_ entry: OrchaEntry) -> URL? {
    guard let id = entry.workspace?.id else { return URL(string: "orcha://open") }
    return URL(string: "orcha://needs/\(id)")
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
        default:
            smallView
        }
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Image(systemName: "bell.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.orange)
                Text(entry.workspace?.name ?? "Orcha")
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Text("\(entry.workspace?.needsYou ?? 0)")
                .font(.system(size: 44, weight: .heavy, design: .rounded))
                .foregroundStyle((entry.workspace?.needsYou ?? 0) > 0 ? .primary : .secondary)
            Text(breakdown)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if entry.othersNeedYou > 0 {
                Text("+\(entry.othersNeedYou) in other workspaces")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var breakdown: String {
        guard let w = entry.workspace else { return "open the app to pair" }
        if w.needsYou == 0 { return "all clear" }
        var parts: [String] = []
        if w.verify > 0 { parts.append("\(w.verify) verify") }
        if w.plans > 0 { parts.append("\(w.plans) plan\(w.plans == 1 ? "" : "s")") }
        if w.escalations > 0 { parts.append("\(w.escalations) esc") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - workspace glance (medium)

struct WorkspaceGlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaGlance", provider: OrchaProvider()) { entry in
            GlanceView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(deepLink(entry))
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
            VStack(alignment: .leading, spacing: 6) {
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
                HStack(spacing: 10) {
                    ForEach(w.agents.prefix(4), id: \.alias) { agent in
                        HStack(spacing: 4) {
                            Circle()
                                .fill(color(for: agent.status))
                                .frame(width: 6, height: 6)
                            Text(agent.alias)
                                .font(.system(size: 11, weight: .medium))
                                .lineLimit(1)
                        }
                    }
                }
                .foregroundStyle(.secondary)
                if let headline = w.headline, !headline.isEmpty {
                    HStack(alignment: .top, spacing: 5) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 9))
                            .foregroundStyle(.tint)
                            .padding(.top, 2)
                        Text(headline)
                            .font(.system(size: 12))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Text("updated \(w.updatedAt, style: .relative) ago")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
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

    private func color(for status: String) -> Color {
        switch status {
        case "working", "in_progress": .teal
        case "blocked", "failed", "terminated": .red
        case "awaiting_human", "needs_verification": .orange
        default: .gray
        }
    }
}
