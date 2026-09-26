import SwiftUI

// Decision Assist cards — the on-device model's structured read, rendered
// native (chips and tinted rows, not a prose blob). Absent entirely below
// iOS 26 or when Apple Intelligence is off; hidden on any model failure —
// the full original text is always the primary surface.

/// Structured brief above a proposed plan (TL;DR, steps, flagged risks).
struct PlanBriefCard: View {
    let text: String

    var body: some View {
        if #available(iOS 26, *) {
            PlanBriefCore(text: text)
        }
    }
}

@available(iOS 26, *)
private struct PlanBriefCore: View {
    @Environment(\.palette) private var p
    let text: String
    @State private var brief: DecisionAssist.PlanBrief?
    @State private var failed = false

    var body: some View {
        if DecisionAssist.isAvailable, !failed, DecisionAssist.isSubstantial(text) {
            OrchaCard(borderColor: p.accentLine) {
                AssistHeader(loading: brief == nil)
                if let brief {
                    Text(brief.tldr)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(p.text)
                    ForEach(Array(brief.steps.enumerated()), id: \.offset) { i, step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(i + 1)")
                                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(p.accent)
                                .frame(width: 18, height: 18)
                                .background(p.accentSoft, in: RoundedRectangle(cornerRadius: 6))
                            (stepOwnerPrefix(step) + Text(step.what))
                                .font(.system(size: 13))
                                .foregroundStyle(p.text2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    ForEach(brief.gates, id: \.self) { gate in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.system(size: 11))
                                .foregroundStyle(p.info)
                                .frame(width: 18, height: 18)
                            Text(gate)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(p.info)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    ForEach(brief.risks, id: \.self) { risk in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(p.warn)
                                .frame(width: 18, height: 18)
                            Text(risk)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(p.warn)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    AssistFootnote(text: "Made on this iPhone — read the full plan before deciding.")
                }
            }
            .task(id: text) {
                do { brief = try await DecisionAssist.planBrief(for: text) } catch { failed = true }
            }
        }
    }

    private func stepOwnerPrefix(_ step: DecisionAssist.PlanBrief.Step) -> Text {
        let owner = step.owner.trimmingCharacters(in: .whitespaces)
        guard !owner.isEmpty else { return Text("") }
        return Text("\(owner) — ").fontWeight(.semibold)
    }
}

/// Always-available "what are my agents doing" — collapsed to one tappable
/// row on Home; expanding generates the on-device current-state brief.
struct WorkspaceBriefCard: View {
    let digest: String

    var body: some View {
        if #available(iOS 26, *) {
            WorkspaceBriefCore(digest: digest)
        }
    }
}

@available(iOS 26, *)
private struct WorkspaceBriefCore: View {
    @Environment(\.palette) private var p
    let digest: String
    @State private var expanded = false
    @State private var brief: DecisionAssist.StatusBrief?
    @State private var failed = false

    var body: some View {
        if DecisionAssist.isAvailable, !failed, !digest.isEmpty {
            OrchaCard(borderColor: expanded ? p.accentLine : nil) {
                Button {
                    withAnimation(.spring(duration: 0.25)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.accent)
                        Text("WORKSPACE BRIEF · ON-DEVICE")
                            .font(.system(size: 10, weight: .bold))
                            .tracking(0.8)
                            .foregroundStyle(p.accent)
                        Spacer()
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if expanded {
                    if let brief {
                        Text(brief.headline)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(p.text)
                        ForEach(Array(brief.agents.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .top, spacing: 8) {
                                AgentAvatar(alias: line.name, size: 22)
                                (Text("\(line.name) ").fontWeight(.semibold) + Text(line.line))
                                    .font(.system(size: 13))
                                    .foregroundStyle(p.text2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        if !brief.needsYou.trimmingCharacters(in: .whitespaces).isEmpty {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "bell.fill")
                                    .font(.system(size: 11))
                                    .foregroundStyle(p.warn)
                                    .frame(width: 18, height: 18)
                                Text(brief.needsYou)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(p.warn)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        AssistFootnote(text: "Made on this iPhone from workspace state — attributed, not verified.")
                    } else {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Reading the workspace…")
                                .font(.system(size: 13))
                                .foregroundStyle(p.muted)
                        }
                        .task(id: digest) {
                            do { brief = try await DecisionAssist.statusBrief(for: digest) } catch { failed = true }
                        }
                    }
                }
            }
        }
    }
}

/// "While you were away" — the delta brief on the Home tab: only what CHANGED
/// since the human's last look, narrated on-device. Dismissable; absent below
/// iOS 26 or when Apple Intelligence is off.
struct CatchUpCard: View {
    let previous: String
    let current: String
    let gap: String
    let onDismiss: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            CatchUpCore(previous: previous, current: current, gap: gap, onDismiss: onDismiss)
        }
    }
}

@available(iOS 26, *)
private struct CatchUpCore: View {
    @Environment(\.palette) private var p
    let previous: String
    let current: String
    let gap: String
    let onDismiss: () -> Void
    @State private var brief: DecisionAssist.CatchUp?
    @State private var failed = false

    var body: some View {
        if DecisionAssist.isAvailable, !failed {
            OrchaCard(borderColor: p.accentLine) {
                HStack(spacing: 6) {
                    AssistHeader(loading: brief == nil, title: "WHILE YOU WERE AWAY · \(gap.uppercased())")
                    Button {
                        onDismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.faint)
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss catch-up")
                }
                if let brief {
                    Text(brief.headline)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(p.text)
                    ForEach(brief.changes, id: \.self) { change in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(p.accent)
                                .frame(width: 5, height: 5)
                                .padding(.top, 6)
                            Text(change)
                                .font(.system(size: 13))
                                .foregroundStyle(p.text2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if !brief.needsYou.trimmingCharacters(in: .whitespaces).isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "bell.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(p.warn)
                                .frame(width: 18, height: 18)
                            Text(brief.needsYou)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(p.warn)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    AssistFootnote(text: "Made on this iPhone from workspace state — the queue below is the record.")
                }
            }
            .task(id: current) {
                do { brief = try await DecisionAssist.catchUp(previous: previous, current: current, gap: gap) } catch { failed = true }
            }
        }
    }
}

/// Digest above a finished run's log (what it did, how it ended).
struct RunDigestCard: View {
    let feed: [RunFeedRow]

    var body: some View {
        if #available(iOS 26, *) {
            RunDigestCore(feed: feed)
        }
    }
}

@available(iOS 26, *)
private struct RunDigestCore: View {
    @Environment(\.palette) private var p
    let feed: [RunFeedRow]
    @State private var digest: DecisionAssist.RunDigest?
    @State private var failed = false

    var body: some View {
        if DecisionAssist.isAvailable, !failed, !feed.isEmpty {
            OrchaCard(borderColor: p.accentLine) {
                AssistHeader(loading: digest == nil)
                if let digest {
                    ForEach(digest.didPoints, id: \.self) { point in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(p.accent)
                                .frame(width: 5, height: 5)
                                .padding(.top, 6)
                            Text(point)
                                .font(.system(size: 13))
                                .foregroundStyle(p.text2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Text(digest.outcome)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(p.text)
                    AssistFootnote(text: "Made on this iPhone from the run log — the log below is the record.")
                }
            }
            .task(id: feed.count) {
                do { digest = try await DecisionAssist.runDigest(for: feed) } catch { failed = true }
            }
        }
    }
}

// MARK: shared chrome

private struct AssistHeader: View {
    @Environment(\.palette) private var p
    let loading: Bool
    var title = "DECISION ASSIST · ON-DEVICE"
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(p.accent)
                .opacity(loading && pulse ? 0.35 : 1)
                .animation(loading ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : nil, value: pulse)
                .onAppear { pulse = true }
            Text(loading ? "READING…" : title)
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(p.accent)
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }
}

private struct AssistFootnote: View {
    @Environment(\.palette) private var p
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(p.faint)
    }
}
