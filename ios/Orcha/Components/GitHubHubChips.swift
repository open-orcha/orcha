import SwiftUI

/// Shared GitHub-hub chips — used by both the list rows and the detail headers so
/// the checks summary, merge-state, and per-run glyphs read identically everywhere.

/// The compact CI verdict chip ("3✓ 2✗ 2•" tinted by the dominant state). Hidden
/// when there are no checks at all — the caller decides whether to show "no checks".
struct ChecksChip: View {
    @Environment(\.palette) private var p
    let checks: GitHubChecks
    var showsWhenEmpty = false

    var body: some View {
        let summary = GitHubHubUx.checksSummary(checks)
        if summary.hasChecks || showsWhenEmpty {
            let tint = verdictColor(summary.verdict)
            HStack(spacing: 4) {
                Image(systemName: verdictGlyph(summary.verdict))
                    .font(.system(size: 9, weight: .bold))
                Text(summary.label)
                    .ltype(.micro)
                    .monospaced()
                    .fontWeight(.semibold)
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 5))
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(p.border, lineWidth: 1)
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(summary))
        }
    }

    private func verdictColor(_ verdict: GitHubHubUx.ChecksSummary.Verdict) -> Color {
        switch verdict {
        case .failing: p.danger
        case .pending: p.warn
        case .passing: p.ok
        case .none: p.muted
        }
    }

    private func verdictGlyph(_ verdict: GitHubHubUx.ChecksSummary.Verdict) -> String {
        switch verdict {
        case .failing: "xmark.octagon.fill"
        case .pending: "clock.fill"
        case .passing: "checkmark.seal.fill"
        case .none: "circle.dashed"
        }
    }

    private func accessibilityLabel(_ summary: GitHubHubUx.ChecksSummary) -> String {
        guard summary.hasChecks else { return "No checks reported" }
        return "Checks: \(checks.passed) passed, \(checks.failing) failing, \(checks.pending) pending, of \(checks.total)"
    }
}

/// The merge-state chip — tinted green when clean, red on conflicts/blocked, amber
/// otherwise. Nothing renders when GitHub reports no meaningful state.
struct MergeStateChip: View {
    @Environment(\.palette) private var p
    let mergeableState: String?

    var body: some View {
        if let label = GitHubHubUx.mergeStateLabel(mergeableState) {
            HStack(spacing: 4) {
                Circle()
                    .fill(tintColor)
                    .frame(width: 6, height: 6)
                Text(label)
                    .ltype(.micro)
                    .fontWeight(.medium)
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(p.border, lineWidth: 1))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Merge state: \(label)")
        }
    }

    private var tintColor: Color {
        switch mergeableState {
        case "clean": p.ok
        case "dirty", "blocked", "behind": p.danger
        default: p.warn
        }
    }
}

/// A single GitHub label chip (issue/PR label names).
struct GitHubLabelChip: View {
    @Environment(\.palette) private var p
    let label: GitHubLabel

    var body: some View {
        // Linear-style label: a neutral tag led by the repo's own label colour as a
        // dot (Android parity on the colour); house violet for colourless labels.
        let dot = label.rgb.map { Color(hex: $0) } ?? p.violet
        HStack(spacing: 5) {
            Circle()
                .fill(dot)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(label.name)
                .ltype(.micro)
                .fontWeight(.medium)
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .background(p.surface2, in: Capsule())
        .overlay(Capsule().strokeBorder(p.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Label \(label.name)")
    }
}

/// The per-run status glyph for the detail checks list.
struct CheckRunGlyph: View {
    @Environment(\.palette) private var p
    let run: GitHubCheckRun

    var body: some View {
        Image(systemName: glyph)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(color)
            .accessibilityLabel(accessibilityLabel)
    }

    private var verdict: GitHubHubUx.ChecksSummary.Verdict { GitHubHubUx.runVerdict(run) }

    private var glyph: String {
        switch verdict {
        case .failing: "xmark.circle.fill"
        case .pending: "clock"
        case .passing: "checkmark.circle.fill"
        case .none: "circle"
        }
    }

    private var color: Color {
        switch verdict {
        case .failing: p.danger
        case .pending: p.warn
        case .passing: p.ok
        case .none: p.muted
        }
    }

    private var accessibilityLabel: String {
        switch verdict {
        case .failing: "failing"
        case .pending: "pending"
        case .passing: "passed"
        case .none: "unknown"
        }
    }
}
