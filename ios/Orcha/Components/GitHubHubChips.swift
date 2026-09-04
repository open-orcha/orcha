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
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: p.radiusTag))
            .overlay(
                RoundedRectangle(cornerRadius: p.radiusTag)
                    .strokeBorder(tint.opacity(0.34), lineWidth: 1)
            )
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
            let tint = tintColor
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(tint)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .overlay(
                    RoundedRectangle(cornerRadius: p.radiusTag)
                        .strokeBorder(tint.opacity(0.4), lineWidth: 1)
                )
                .lineLimit(1)
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
        // Real repo label colors when the server sends them (Android parity);
        // the house violet is the fallback for colorless labels / older servers.
        if let rgb = label.rgb {
            let tint = Color(hex: rgb)
            chip(text: tint, fill: tint.opacity(0.15), line: tint.opacity(0.4))
        } else {
            chip(text: p.violet, fill: p.violetSoft, line: p.violetLine)
        }
    }

    private func chip(text: Color, fill: Color, line: Color) -> some View {
        Text(label.name)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(text)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(fill, in: Capsule())
            .overlay(Capsule().strokeBorder(line, lineWidth: 1))
            .lineLimit(1)
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
