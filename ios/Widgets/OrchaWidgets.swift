import SwiftUI
import WidgetKit

// Orcha home-screen widgets — glanceable supervision. Read-only by design:
// nothing state-changing lives on a widget (accidental taps, no way to read
// a plan first); every tap deep-links into the app instead.
//
// Visual language mirrors the Linear-style web portal (v2-tokens.css): calm
// panel surface, hairlines, muted captions, accent reserved for the count.
// The widget extension can't see the app's Components/Linear.swift, so a
// small self-contained token set lives here (WL* prefix avoids clashes).

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
        OrchaEntry(date: .now, workspace: .sample, othersNeedYou: 0)
    }

    func getSnapshot(in context: Context, completion: @escaping (OrchaEntry) -> Void) {
        // The gallery preview should look alive even before pairing.
        let live = entry()
        completion(context.isPreview && live.workspace == nil ? placeholder(in: context) : live)
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

private extension WidgetWorkspace {
    static let sample = WidgetWorkspace(
        id: "placeholder", name: "Acme EHR", verify: 2, plans: 1, escalations: 0,
        agents: [
            WidgetAgent(alias: "Forge", status: "working"),
            WidgetAgent(alias: "Muse", status: "idle"),
            WidgetAgent(alias: "Atlas", status: "needs_verification"),
        ],
        headline: "Forge reports the deploy workflow drafted.",
        updatedAt: .now
    )
}

private func deepLink(_ entry: OrchaEntry) -> URL? {
    guard let id = entry.workspace?.id else { return URL(string: "orcha://open") }
    return URL(string: "orcha://needs/\(id)")
}

// MARK: - Linear tokens (widget-local mirror of v2-tokens.css)

private extension Color {
    init(wlHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

struct WLTokens {
    let panel: Color
    let surface: Color
    let border: Color
    let text: Color
    let text2: Color
    let text3: Color
    let accent: Color      // text-safe accent
    let accentFill: Color
    let green: Color
    let amber: Color
    let red: Color

    static func of(_ scheme: ColorScheme) -> WLTokens {
        scheme == .dark
            ? WLTokens(
                panel: Color(wlHex: 0x141516), surface: Color(wlHex: 0x1A1B1E),
                border: Color(wlHex: 0x232427),
                text: Color(wlHex: 0xEEEFF1), text2: Color(wlHex: 0xB4B8BF), text3: Color(wlHex: 0x8A8F98),
                accent: Color(wlHex: 0x7C86E8), accentFill: Color(wlHex: 0x5E6AD2),
                green: Color(wlHex: 0x4CB782), amber: Color(wlHex: 0xF2C94C), red: Color(wlHex: 0xEB5757))
            : WLTokens(
                panel: Color(wlHex: 0xFFFFFF), surface: Color(wlHex: 0xF4F4F5),
                border: Color(wlHex: 0xE6E6E9),
                text: Color(wlHex: 0x1C1D1F), text2: Color(wlHex: 0x4E525A), text3: Color(wlHex: 0x62666E),
                accent: Color(wlHex: 0x505AC9), accentFill: Color(wlHex: 0x5E6AD2),
                green: Color(wlHex: 0x2F9E6A), amber: Color(wlHex: 0xD9A21B), red: Color(wlHex: 0xD64545))
    }
}

/// Panel-coloured container background shared by every home-screen family.
private struct WLContainer: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.containerBackground(for: .widget) { WLTokens.of(scheme).panel }
    }
}

private extension View {
    func wlContainer() -> some View { modifier(WLContainer()) }
}

// MARK: - Linear status glyph (same vocabulary as the app/web)

struct WLStatusGlyph: View {
    @Environment(\.colorScheme) private var scheme
    let status: String
    var size: CGFloat = 12

    var body: some View {
        let t = WLTokens.of(scheme)
        let line = max(1.2, size / 9)
        ZStack {
            switch status {
            case "working", "in_progress", "plan":
                Circle().strokeBorder(t.amber, lineWidth: line)
                HalfDisc().fill(t.amber).padding(line * 2)
            case "needs_verification", "verify", "awaiting_human":
                Circle().strokeBorder(t.green, lineWidth: line)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.5, weight: .heavy))
                    .foregroundStyle(t.green)
            case "completed", "done":
                Circle().fill(t.green)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.5, weight: .heavy))
                    .foregroundStyle(t.panel)
            case "blocked", "failed", "terminated", "escalation":
                Circle().fill(t.red)
                Image(systemName: "exclamationmark")
                    .font(.system(size: size * 0.55, weight: .heavy))
                    .foregroundStyle(t.panel)
            case "cancelled":
                Circle().fill(t.text3)
                Image(systemName: "xmark")
                    .font(.system(size: size * 0.45, weight: .heavy))
                    .foregroundStyle(t.panel)
            case "pending", "backlog":
                Circle().strokeBorder(t.text3, style: StrokeStyle(lineWidth: line, dash: [1.5, 1.8]))
            default: // idle / ready / todo
                Circle().strokeBorder(t.text3, lineWidth: line)
            }
        }
        .frame(width: size, height: size)
        .widgetAccentable()
        .accessibilityHidden(true)
    }
}

private struct HalfDisc: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        p.move(to: c)
        p.addArc(center: c, radius: min(rect.width, rect.height) / 2,
                 startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// Compact neutral tag (web `.tag`): hairline border, muted micro text.
private struct WLTag: View {
    @Environment(\.colorScheme) private var scheme
    let text: String

    var body: some View {
        let t = WLTokens.of(scheme)
        Text(text)
            .font(.system(size: 9.5, weight: .medium))
            .foregroundStyle(t.text3)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(t.surface, in: .rect(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(t.border, lineWidth: 0.5))
    }
}

private struct WLHairline: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Rectangle().fill(WLTokens.of(scheme).border).frame(height: 0.5)
    }
}

/// One "needs you" bucket as a Linear row.
private struct NeedItem: Identifiable {
    let id: String
    let glyph: String
    let title: String
    let tag: String
    let count: Int
}

private func needItems(_ w: WidgetWorkspace) -> [NeedItem] {
    [
        NeedItem(id: "verify", glyph: "verify",
                 title: w.verify == 1 ? "1 task to verify" : "\(w.verify) tasks to verify",
                 tag: "Verify", count: w.verify),
        NeedItem(id: "plans", glyph: "plan",
                 title: w.plans == 1 ? "1 plan to approve" : "\(w.plans) plans to approve",
                 tag: "Plan", count: w.plans),
        NeedItem(id: "esc", glyph: "escalation",
                 title: w.escalations == 1 ? "1 open request" : "\(w.escalations) open requests",
                 tag: "Request", count: w.escalations),
    ]
}

private func statusDotColor(_ t: WLTokens, _ w: WidgetWorkspace?) -> Color {
    guard let w else { return t.text3 }
    if w.escalations > 0 { return t.red }
    if w.needsYou > 0 { return t.amber }
    return t.green
}

// MARK: - needs-you widget (small + lock screen)

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaNeedsYou", provider: OrchaProvider()) { entry in
            NeedsYouView(entry: entry)
                .wlContainer()
                .widgetURL(deepLink(entry))
        }
        .configurationDisplayName("Needs you")
        .description("How much waits on your decision, at a glance.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct NeedsYouView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme
    let entry: OrchaEntry

    private var count: Int { entry.workspace?.needsYou ?? 0 }

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: -1) {
                    Text(count, format: .number)
                        .font(.system(size: 22, weight: .semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .widgetAccentable()
                    Text("NEED")
                        .font(.system(size: 7, weight: .semibold))
                        .tracking(0.6)
                        .opacity(0.7)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilitySummary)
        case .accessoryRectangular:
            rectangularView
        case .accessoryInline:
            Label(count == 0 ? "Embodent · all clear" : "Embodent · \(count) need you",
                  systemImage: count == 0 ? "checkmark.circle" : "circle.lefthalf.filled")
        default:
            smallView
        }
    }

    private var rectangularView: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text(count, format: .number)
                    .font(.system(size: 20, weight: .semibold))
                    .monospacedDigit()
                    .widgetAccentable()
                Text(count == 0 ? "all clear" : "need you")
                    .font(.system(size: 13, weight: .medium))
            }
            Text(entry.workspace?.name ?? "Embodent")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .opacity(0.8)
            Text(breakdown)
                .font(.system(size: 11))
                .lineLimit(1)
                .opacity(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var smallView: some View {
        let t = WLTokens.of(scheme)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Circle()
                    .fill(statusDotColor(t, entry.workspace))
                    .frame(width: 7, height: 7)
                Text(entry.workspace?.name ?? "Embodent")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.text2)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text("Needs you")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(t.text3)
            Text(count, format: .number)
                .font(.system(size: 48, weight: .semibold))
                .tracking(-1.5)
                .monospacedDigit()
                .foregroundStyle(count > 0 ? t.accent : t.text3)
                .contentTransition(.numericText())
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .widgetAccentable()
            WLHairline().padding(.vertical, 6)
            Text(breakdown)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(t.text2)
                .lineLimit(1)
            if entry.othersNeedYou > 0 {
                Text("+\(entry.othersNeedYou) in other workspaces")
                    .font(.system(size: 10))
                    .foregroundStyle(t.text3)
                    .lineLimit(1)
                    .padding(.top, 1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var breakdown: String {
        guard let w = entry.workspace else { return "Open the app to pair" }
        if w.needsYou == 0 { return "All clear" }
        var parts: [String] = []
        if w.verify > 0 { parts.append("\(w.verify) verify") }
        if w.plans > 0 { parts.append("\(w.plans) plan\(w.plans == 1 ? "" : "s")") }
        if w.escalations > 0 { parts.append("\(w.escalations) req") }
        return parts.joined(separator: " · ")
    }

    private var accessibilitySummary: String {
        guard let w = entry.workspace else { return "Embodent. Open the app to pair a workspace." }
        let head = w.needsYou == 0 ? "all clear" : "\(w.needsYou) need you"
        var s = "\(w.name), \(head)"
        if w.needsYou > 0 { s += ": \(breakdown)" }
        if entry.othersNeedYou > 0 { s += ". \(entry.othersNeedYou) more in other workspaces" }
        return s
    }
}

// MARK: - workspace glance (medium + large)

struct WorkspaceGlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OrchaGlance", provider: OrchaProvider()) { entry in
            GlanceView(entry: entry)
                .wlContainer()
                .widgetURL(deepLink(entry))
        }
        .configurationDisplayName("Workspace glance")
        .description("What waits on you, your agents, and the on-device headline.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

struct GlanceView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme
    let entry: OrchaEntry

    var body: some View {
        let t = WLTokens.of(scheme)
        if let w = entry.workspace {
            VStack(alignment: .leading, spacing: 0) {
                header(w, t)
                WLHairline().padding(.top, 8)
                needsList(w, t)
                if family == .systemLarge {
                    activeWork(w, t)
                    headline(w, t)
                }
                Spacer(minLength: 0)
                footer(w, t)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            emptyState(t)
        }
    }

    private func header(_ w: WidgetWorkspace, _ t: WLTokens) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(statusDotColor(t, w))
                .frame(width: 7, height: 7)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            Text(w.name)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(t.text)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(w.needsYou, format: .number)
                .font(.system(size: 22, weight: .semibold))
                .tracking(-0.5)
                .monospacedDigit()
                .foregroundStyle(w.needsYou > 0 ? t.accent : t.text3)
                .widgetAccentable()
            Text("need you")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(t.text3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(w.needsYou == 0 ? "\(w.name), all clear" : "\(w.name), \(w.needsYou) need you")
    }

    @ViewBuilder
    private func needsList(_ w: WidgetWorkspace, _ t: WLTokens) -> some View {
        let items = needItems(w)
        if w.needsYou == 0 {
            HStack(spacing: 8) {
                WLStatusGlyph(status: "completed", size: 13)
                Text("Nothing waits on you")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(t.text2)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            if let headline = w.headline, !headline.isEmpty, family == .systemMedium {
                Text(headline)
                    .font(.system(size: 12))
                    .foregroundStyle(t.text3)
                    .lineLimit(2)
            }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    needRow(item, t)
                    if index < items.count - 1 { WLHairline().padding(.leading, 21) }
                }
            }
        }
    }

    private func needRow(_ item: NeedItem, _ t: WLTokens) -> some View {
        let dim = item.count == 0
        return HStack(spacing: 8) {
            WLStatusGlyph(status: dim ? "completed" : item.glyph, size: 13)
                .opacity(dim ? 0.45 : 1)
            Text(dim ? "No \(item.tag.lowercased())s waiting" : item.title)
                .font(.system(size: 12.5, weight: dim ? .regular : .medium))
                .foregroundStyle(dim ? t.text3 : t.text)
                .lineLimit(1)
            Spacer(minLength: 4)
            WLTag(text: item.tag)
        }
        .frame(maxHeight: 26)
        .padding(.vertical, family == .systemLarge ? 5 : 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(dim ? "No \(item.tag.lowercased())s waiting" : item.title)
    }

    @ViewBuilder
    private func activeWork(_ w: WidgetWorkspace, _ t: WLTokens) -> some View {
        let agents = w.agents.sorted { rank($0.status) < rank($1.status) }.prefix(4)
        if !agents.isEmpty {
            caption("Active work", count: w.agents.filter { isActive($0.status) }.count, t)
                .padding(.top, 12)
            VStack(spacing: 0) {
                ForEach(Array(agents), id: \.alias) { agent in
                    HStack(spacing: 8) {
                        WLStatusGlyph(status: agent.status, size: 13)
                        Text(agent.alias)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(t.text)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(label(for: agent.status))
                            .font(.system(size: 11))
                            .foregroundStyle(t.text3)
                            .lineLimit(1)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(agent.alias), \(label(for: agent.status))")
                }
            }
        }
    }

    @ViewBuilder
    private func headline(_ w: WidgetWorkspace, _ t: WLTokens) -> some View {
        if let headline = w.headline, !headline.isEmpty {
            caption("Headline", count: nil, t).padding(.top, 10)
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "sparkles")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(t.text3)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                Text(headline)
                    .font(.system(size: 12))
                    .foregroundStyle(t.text2)
                    .lineLimit(3)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(t.surface, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border, lineWidth: 0.5))
        }
    }

    private func caption(_ title: String, count: Int?, _ t: WLTokens) -> some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(t.text3)
            if let count, count > 0 {
                Text(count, format: .number)
                    .font(.system(size: 11, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(t.text3.opacity(0.8))
            }
        }
        .padding(.bottom, 4)
        .accessibilityAddTraits(.isHeader)
    }

    private func footer(_ w: WidgetWorkspace, _ t: WLTokens) -> some View {
        HStack(spacing: 4) {
            if entry.othersNeedYou > 0 {
                Text("+\(entry.othersNeedYou) elsewhere")
                Text("·")
            }
            Text("Updated \(w.updatedAt, style: .relative) ago")
        }
        .font(.system(size: 10))
        .foregroundStyle(t.text3)
        .lineLimit(1)
    }

    private func emptyState(_ t: WLTokens) -> some View {
        VStack(spacing: 6) {
            WLStatusGlyph(status: "backlog", size: 18)
            Text("No workspace yet")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(t.text)
            Text("Open Embodent and pair a workspace")
                .font(.system(size: 11))
                .foregroundStyle(t.text3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func isActive(_ status: String) -> Bool {
        ["working", "in_progress", "awaiting_human", "needs_verification"].contains(status)
    }

    private func rank(_ status: String) -> Int {
        switch status {
        case "blocked", "failed", "terminated": 0
        case "awaiting_human", "needs_verification": 1
        case "working", "in_progress": 2
        default: 3
        }
    }

    private func label(for status: String) -> String {
        switch status {
        case "working", "in_progress": "Working"
        case "awaiting_human": "Waiting on you"
        case "needs_verification": "In review"
        case "blocked": "Blocked"
        case "failed", "terminated": "Stopped"
        default: "Idle"
        }
    }
}

// MARK: - previews

#Preview("Small", as: .systemSmall) {
    NeedsYouWidget()
} timeline: {
    OrchaEntry(date: .now, workspace: .sample, othersNeedYou: 2)
    OrchaEntry(date: .now, workspace: nil, othersNeedYou: 0)
}

#Preview("Medium", as: .systemMedium) {
    WorkspaceGlanceWidget()
} timeline: {
    OrchaEntry(date: .now, workspace: .sample, othersNeedYou: 0)
}

#Preview("Large", as: .systemLarge) {
    WorkspaceGlanceWidget()
} timeline: {
    OrchaEntry(date: .now, workspace: .sample, othersNeedYou: 3)
}
