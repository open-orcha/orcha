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

/// `.pill` — word + dot, color text on Soft fill with Line border (11/700, radius 999).
/// Status is never conveyed by color alone (foundations §2 accessibility).
struct StatusPill: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let status: String
    let domain: StatusDomain

    var body: some View {
        let tint = palette.tint(statusColorName(status, domain))
        HStack(spacing: 6) {
            PulseDot(color: tint.color, animated: pillPulses(status, domain) && !reduceMotion)
            Text(MobileUx.statusCopy(status.lowercased()))
                .font(.system(size: 11, weight: .bold))
                .tracking(0.2)
                .foregroundStyle(tint.color)
        }
        .padding(.leading, 8)
        .padding(.trailing, 10)
        .padding(.vertical, 3)
        .background(tint.soft, in: Capsule())
        .overlay(Capsule().strokeBorder(tint.line, lineWidth: 1))
        .accessibilityElement(children: .combine)
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
            .frame(width: 7, height: 7)
            .opacity(animated && dim ? 0.35 : 1)
            .animation(animated ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : nil, value: dim)
            .onAppear { if animated { dim = true } }
    }
}
