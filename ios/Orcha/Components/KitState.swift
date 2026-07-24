import SwiftUI

// Responsibility: Reusable state layouts, key-value rows, and activity feed rows.

struct StateLayout<Glyph: View, Actions: View>: View {
    @Environment(\.palette) private var p
    let title: String
    var sub: String?
    var danger = false
    @ViewBuilder let glyph: Glyph
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(spacing: 12) {
            glyph
                .frame(width: 72, height: 72)
                .background(danger ? p.dangerSoft : p.surface2, in: RoundedRectangle(cornerRadius: 22))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(danger ? p.dangerLine : p.border, lineWidth: 1))
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .multilineTextAlignment(.center)
            if let sub {
                Text(sub)
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 290)
            }
            actions
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 36)
    }
}

/// `.kv` — key/value detail row.
struct KVRow: View {
    @Environment(\.palette) private var p
    let key: String
    let value: String
    var mono = false

    var body: some View {
        HStack(spacing: 12) {
            Text(key)
                .font(.system(size: 13.5))
                .foregroundStyle(p.muted)
            Spacer()
            Text(value)
                .font(mono ? .system(size: 12, design: .monospaced) : .system(size: 13.5))
                .foregroundStyle(p.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// Per-type tint for a run-feed row — a 1:1 mirror of Android `feedTint` (Kit.kt).
private func feedTint(_ type: String, _ p: Palette) -> Color {
    switch type {
    case "boot": p.faint
    case "think": p.muted
    case "tool": p.accent
    case "result": p.text2
    case "subagent": p.info
    case "decision": p.violet
    case "error": p.danger
    case "done": p.ok
    default: p.text // narrate
    }
}

/// One classified run-feed row (flow 06): uppercase label tag + body text; narration
/// reads as plain prose, everything else is label-tinted; `detail` starts collapsed and
/// expands on tap (the web's <details> affordance). 1:1 with Android `FeedRow`.
struct FeedRow: View {
    @Environment(\.palette) private var p
    let row: RunFeedRow
    @State private var expanded = false

    private var hasDetail: Bool {
        !(row.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        let tint = feedTint(row.type, p)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(row.label.uppercased())
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .tracking(0.6)
                    .foregroundStyle(tint)
                if hasDetail {
                    Text(expanded ? "▾" : "▸")
                        .font(.system(size: 10))
                        .foregroundStyle(p.faint)
                }
            }
            if !row.text.isEmpty {
                Text(row.text)
                    .font(row.type == "narrate" ? .system(size: 14) : .system(size: 11.5, design: .monospaced))
                    .foregroundStyle(row.type == "narrate" ? p.text : tint)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if expanded, let detail = row.detail, hasDetail {
                Text(detail)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { if hasDetail { expanded.toggle() } }
    }
}
