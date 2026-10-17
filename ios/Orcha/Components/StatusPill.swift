import SwiftUI

enum StatusDomain {
    case task, request, agent, connection, run
}

struct StatusTint {
    let color: Color
    let soft: Color
    let line: Color
}

extension Palette {
    /// Semantic color name → tint triplet (tokens `statusColor` badge anatomy).
    func tint(_ name: String) -> StatusTint {
        switch name {
        case "accent": StatusTint(color: accent, soft: accentSoft, line: accentLine)
        case "ok": StatusTint(color: ok, soft: okSoft, line: okLine)
        case "info": StatusTint(color: info, soft: infoSoft, line: infoLine)
        case "warn": StatusTint(color: warn, soft: warnSoft, line: warnLine)
        case "danger": StatusTint(color: danger, soft: dangerSoft, line: dangerLine)
        case "violet": StatusTint(color: violet, soft: violetSoft, line: violetLine)
        default: StatusTint(color: idle, soft: idleSoft, line: idleLine)
        }
    }
}

/// statusColor mapping (tokens `statusColor`, foundations §2) — the binding contract.
func statusColorName(_ status: String, _ domain: StatusDomain) -> String {
    let s = status.lowercased()
    switch domain {
    case .task:
        switch s {
        case "ready": return "info"
        case "in_progress": return "accent"
        case "blocked": return "warn"
        case "needs_verification": return "violet"
        case "completed": return "ok"
        case "cancelled": return "danger"
        default: return "idle"
        }
    case .request:
        switch s {
        case "open": return "info"
        case "accepted": return "accent"
        case "rejected": return "danger"
        case "answered", "converted_to_task": return "violet"
        default: return "idle"
        }
    case .agent:
        switch s {
        case "working": return "accent"
        case "blocked": return "warn"
        case "awaiting_request": return "info"
        case "awaiting_human": return "violet"
        case "terminated": return "danger"
        default: return "idle"
        }
    case .connection:
        switch s {
        case "live", "active": return "ok"
        case "polling", "paused": return "warn"
        case "unreachable", "failed", "off": return "danger"
        default: return "idle"
        }
    case .run:
        switch s {
        case "running": return "accent"
        case "exited", "finished": return "ok"
        case "killed", "failed", "error": return "danger"
        default: return "idle"
        }
    }
}

private func pillPulses(_ status: String, _ domain: StatusDomain) -> Bool {
    let s = status.lowercased()
    switch domain {
    case .agent: return s == "working"
    case .run: return s == "running"
    case .connection: return s == "live" || s == "active"
    case .task: return s == "in_progress"
    case .request: return false
    }
}

/// Task / request / agent statuses render the web `StatusIcon` glyph + its exact
/// label; connection / run states keep the (pulsing) presence dot.
func statusPillUsesGlyph(_ domain: StatusDomain) -> Bool {
    switch domain {
    case .task, .request, .agent: true
    case .connection, .run: false
    }
}

/// Status — Linear: a compact glyph + label, no loud tinted pill. Tasks, requests
/// and agents use the web status glyphs (`LStatusGlyph`); connections / runs a small
/// semantic dot (pulsing while live). Status is never conveyed by color alone — the word is
/// always present (foundations §2 accessibility). Swiss keeps its mono caps.
struct StatusPill: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let status: String
    let domain: StatusDomain

    var body: some View {
        let tint = palette.tint(statusColorName(status, domain))
        let usesGlyph = statusPillUsesGlyph(domain)
        HStack(spacing: 6) {
            if usesGlyph {
                LStatusGlyph(status: status, size: 12)
                    .accessibilityHidden(true)
            } else {
                PulseDot(color: tint.color, animated: pillPulses(status, domain) && !reduceMotion)
            }
            Text(pillLabel(usesGlyph ? LStatusGlyph.label(for: status) : MobileUx.statusCopy(status.lowercased()), palette))
                .font(pillFont(palette))
                .tracking(pillTracking(palette))
                .foregroundStyle(palette.text2)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(palette.surface2, in: PillShape(mono: palette.pillMono, radius: palette.radiusTag))
        .overlay(PillShape(mono: palette.pillMono, radius: palette.radiusTag).strokeBorder(palette.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// Swiss squares the pill off and sets it in mono-uppercase (the portal's
/// `[data-skin="swiss"] .pill` rules); Classic keeps the capsule.
struct PillShape: InsettableShape {
    let mono: Bool
    /// Linear: tag radius (5) rather than a capsule; nil = capsule.
    var radius: CGFloat? = nil
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let base = rect.insetBy(dx: inset, dy: inset)
        if mono { return Path(base) }
        if let radius { return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: base) }
        return Capsule().path(in: base)
    }

    func inset(by amount: CGFloat) -> PillShape {
        var copy = self
        copy.inset += amount
        return copy
    }
}

func pillLabel(_ text: String, _ p: Palette) -> String {
    p.pillMono ? text.uppercased() : text
}

func pillFont(_ p: Palette) -> Font {
    p.pillMono ? .system(size: 10, weight: .bold, design: .monospaced) : p.uiFont(12, .medium)
}

func pillTracking(_ p: Palette) -> CGFloat {
    p.pillMono ? 0.7 : 0
}

/// Request status pill: the web `StatusIcon` glyph + label for the request status.
/// `escalated` (open + human-targeted) shows the web escalated glyph (red ring + up arrow).
struct RequestStatusPill: View {
    @Environment(\.palette) private var palette
    let status: String
    var escalated: Bool = false

    var body: some View {
        let shown = escalated ? "escalated" : status.lowercased()
        let label = LStatusGlyph.label(for: shown)
        return HStack(spacing: 6) {
            LStatusGlyph(status: shown, size: 12)
                .accessibilityHidden(true)
            Text(pillLabel(label, palette))
                .font(pillFont(palette))
                .tracking(pillTracking(palette))
                .foregroundStyle(palette.text2)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(palette.surface2, in: PillShape(mono: palette.pillMono, radius: palette.radiusTag))
        .overlay(PillShape(mono: palette.pillMono, radius: palette.radiusTag).strokeBorder(palette.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

/// 2s opacity pulse — the portal `.pill.s-working` parity.
struct PulseDot: View {
    let color: Color
    let animated: Bool
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 6, height: 6)
            .opacity(animated && dim ? 0.35 : 1)
            .animation(animated ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : nil, value: dim)
            .onAppear { if animated { dim = true } }
            .accessibilityHidden(true)
    }
}
