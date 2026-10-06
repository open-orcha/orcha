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
            LCard {
                AssistHeader(loading: brief == nil)
                if let brief {
                    Text(brief.tldr)
                        .ltype(.bodyEmph)
                        .foregroundStyle(p.text)
                    ForEach(Array(brief.steps.enumerated()), id: \.offset) { i, step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(i + 1)")
                                .ltype(.micro).monospacedDigit()
                                .foregroundStyle(p.text2)
                                .frame(width: 18, height: 18)
                                .background(p.surface2, in: RoundedRectangle(cornerRadius: 5))
                            (stepOwnerPrefix(step) + Text(step.what))
                                .ltype(.meta)
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
                                .ltype(.meta).fontWeight(.medium)
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
                                .ltype(.meta).fontWeight(.medium)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let digest: String
    @State private var expanded = false
    @State private var brief: DecisionAssist.StatusBrief?
    @State private var failed = false

    var body: some View {
        if DecisionAssist.isAvailable, !failed, !digest.isEmpty {
            LCard {
                Button {
                    withAnimation(reduceMotion ? nil : .lSpring) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.accent)
                        Text("Workspace brief · on-device")
                            .ltype(.micro)
                            .fontWeight(.medium)
                            .foregroundStyle(p.text2)
                        Spacer()
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.faint)
                    }
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if expanded {
                    if let brief {
                        Text(brief.headline)
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                        ForEach(Array(brief.agents.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .top, spacing: 8) {
                                AgentAvatar(alias: line.name, size: 22)
                                (Text("\(line.name) ").fontWeight(.semibold) + Text(line.line))
                                    .ltype(.meta)
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
                                    .ltype(.meta).fontWeight(.medium)
                                    .foregroundStyle(p.warn)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        AssistFootnote(text: "Made on this iPhone from workspace state — attributed, not verified.")
                    } else {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Reading the workspace…")
                                .ltype(.meta)
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
            LCard {
                HStack(spacing: 6) {
                    AssistHeader(loading: brief == nil, title: "While you were away · \(gap)")
                    Button {
                        onDismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.faint)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss catch-up")
                }
                if let brief {
                    Text(brief.headline)
                        .ltype(.bodyEmph)
                        .foregroundStyle(p.text)
                    ForEach(brief.changes, id: \.self) { change in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(p.faint)
                                .frame(width: 4, height: 4)
                                .padding(.top, 6)
                            Text(change)
                                .ltype(.meta)
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
                                .ltype(.meta).fontWeight(.medium)
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
            LCard {
                AssistHeader(loading: digest == nil)
                if let digest {
                    ForEach(digest.didPoints, id: \.self) { point in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(p.faint)
                                .frame(width: 4, height: 4)
                                .padding(.top, 6)
                            Text(point)
                                .ltype(.meta)
                                .foregroundStyle(p.text2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Text(digest.outcome)
                        .ltype(.meta).fontWeight(.semibold)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let loading: Bool
    var title = "Decision assist · on-device"
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(p.accent)
                .opacity(loading && pulse ? 0.35 : 1)
                .animation(loading && !reduceMotion ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : nil, value: pulse)
                .onAppear { pulse = !reduceMotion }
            Text(loading ? "Reading…" : title)
                .ltype(.micro)
                .fontWeight(.medium)
                .foregroundStyle(p.text2)
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
            .ltype(.micro)
            .foregroundStyle(p.faint)
    }
}
