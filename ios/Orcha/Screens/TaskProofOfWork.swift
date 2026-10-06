import SwiftUI

/// Proof of work — the web `EvidencePack` inside the verification card. One calm summary
/// line ("3/4 DoD · 42 tests passed · 1 risk · Verdikt pass") with a Details toggle that
/// expands in place to the full pack: the definition of done line by line (proven /
/// not proven / needs a human, with the run output behind each), the tests the runs
/// actually ran, the changes with risk flags and links, and Verdikt.
/// Truthful states: loading, unavailable (reason + Retry), no evidence yet.
struct TaskProofOfWork: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String
    /// Re-fetch trigger (the task's status) so a fresh round rebuilds the pack.
    let reloadKey: String

    @State private var pack: EvidencePackDto?
    @State private var loadError: String?
    @State private var loading = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.s) {
            HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                Text("Proof")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
                    .accessibilityHidden(true)
                summary
                Spacer(minLength: 0)
            }
            if pack != nil {
                Button {
                    withAnimation(.lQuick) { expanded.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Text(expanded ? "Hide details" : "Details")
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                            .accessibilityHidden(true)
                    }
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Hide proof of work details" : "Show proof of work details")
            }
            if expanded, let pack {
                EvidenceDetails(pack: pack, taskId: taskId) { run in
                    var updated = pack
                    updated.verdikt = run
                    self.pack = updated
                    Task { await load() }
                }
                .transition(.opacity)
            }
        }
        .task(id: reloadKey) { await load() }
    }

    @ViewBuilder
    private var summary: some View {
        if let pack {
            let parts = EvidenceUx.summaryParts(pack.summary, short: !expanded)
            if parts.isEmpty {
                Text("No evidence yet.").ltype(.meta).foregroundStyle(p.faint)
            } else {
                EvidenceSummaryLine(parts: parts)
            }
        } else if let loadError {
            HStack(spacing: LSpace.s) {
                Text(loadError).ltype(.meta).foregroundStyle(p.faint).lineLimit(2)
                Button("Retry") { Task { await load() } }
                    .buttonStyle(.plain)
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 44)
            }
        } else {
            Text(loading ? "Gathering evidence…" : "No evidence yet.")
                .ltype(.meta)
                .foregroundStyle(p.faint)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if let fresh = try await model.fetchEvidence(taskId) {
                pack = fresh
                loadError = nil
            }
        } catch is CancellationError {
            return
        } catch {
            if pack == nil { loadError = Self.unavailableText(error) }
        }
    }

    private static func unavailableText(_ error: Error) -> String {
        if let api = error as? OrchaApiError, api.status == 404 {
            return "Proof of work isn't available on this Embodent yet."
        }
        return "Couldn't gather the evidence."
    }
}

/// "3/4 DoD · 42 tests passed · 1 risk · Verdikt pass" — colour only in the small word.
struct EvidenceSummaryLine: View {
    @Environment(\.palette) private var p
    let parts: [EvidencePart]

    var body: some View {
        Text(parts.enumerated().reduce(AttributedString()) { acc, item in
            var out = acc
            if item.offset > 0 {
                var dot = AttributedString(" · ")
                dot.foregroundColor = p.faint
                out += dot
            }
            var piece = AttributedString(item.element.text)
            piece.foregroundColor = p.evidenceColor(item.element.tone)
            out += piece
            return out
        })
        .ltype(.meta)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel("Proof of work: " + parts.map(\.text).joined(separator: ", "))
    }
}

extension Palette {
    func evidenceColor(_ tone: EvidenceTone) -> Color {
        switch tone {
        case .ok: ok
        case .warn: warn
        case .bad: danger
        case .muted: faint
        case .plain: text2
        }
    }
}

/// The expanded pack (web `EvidenceDetails`).
private struct EvidenceDetails: View {
    @Environment(\.palette) private var p
    let pack: EvidencePackDto
    let taskId: String
    let onVerdiktChanged: (VerdiktRunDto) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.m) {
            LDivider()
            section("Definition of done") { DodList(items: pack.dod?.items ?? []) }
            section("Tests") { TestsList(pack: pack) }
            section("Changes") { ChangesBlock(pack: pack) }
            TaskVerdiktSection(taskId: taskId, latest: pack.verdikt, onChanged: onVerdiktChanged)
            Text(EvidenceUx.builtLine(
                runs: pack.runs.count,
                ago: MobileUx.agoLabel(pack.builtAt),
                sinceRejection: pack.roundStartedAt != nil
            ))
            .ltype(.micro)
            .foregroundStyle(p.faint)
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .ltype(.micro)
                .foregroundStyle(p.faint)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

private struct DodList: View {
    @Environment(\.palette) private var p
    let items: [DodItemDto]

    var body: some View {
        if items.isEmpty {
            Text("No definition of done on this task.").ltype(.meta).foregroundStyle(p.faint)
        }
        ForEach(items) { item in
            HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                Image(systemName: glyph(item.status))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint(item.status))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.text).ltype(.body).foregroundStyle(p.text)
                    Text(item.evidence ?? "\(EvidenceUx.dodStatusLabel(item.status)) — no machine evidence")
                        .ltype(.meta)
                        .foregroundStyle(p.text2)
                    if let claim = item.claim, !claim.isEmpty {
                        Text("Agent says: “\(claim)”")
                            .ltype(.meta)
                            .italic()
                            .foregroundStyle(p.faint)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(EvidenceUx.dodStatusLabel(item.status)): \(item.text). \(item.evidence ?? "")")
        }
    }

    private func glyph(_ status: String) -> String {
        switch status {
        case "proven": "checkmark.circle.fill"
        case "not_proven": "xmark.circle.fill"
        default: "eye.circle"
        }
    }

    private func tint(_ status: String) -> Color {
        switch status {
        case "proven": p.ok
        case "not_proven": p.danger
        default: p.faint
        }
    }
}

private struct TestsList: View {
    @Environment(\.palette) private var p
    let pack: EvidencePackDto

    var body: some View {
        let tests = pack.tests ?? EvidenceTestsDto()
        if tests.status == "none" || tests.latest.isEmpty {
            let runs = pack.runs.count
            Text(runs > 0
                 ? "No test command found in this task's \(runs) run\(runs == 1 ? "" : "s")."
                 : "No test command found in any run (none recorded).")
                .ltype(.meta)
                .foregroundStyle(p.faint)
        } else {
            ForEach(Array(tests.latest.enumerated()), id: \.offset) { _, inv in
                let result = EvidenceUx.invocationText(inv)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(inv.framework ?? "Tests").ltype(.bodyEmph).foregroundStyle(p.text)
                        Text(result.text).ltype(.meta).foregroundStyle(p.evidenceColor(result.tone))
                    }
                    if let command = inv.command {
                        Text(command)
                            .ltype(.mono)
                            .foregroundStyle(p.text2)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if tests.earlier > 0 {
                let n = tests.earlier
                Text("\(n) earlier run\(n == 1 ? "" : "s") of the same command\(n == 1 ? "" : "s") superseded.")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
            }
        }
    }
}

private struct ChangesBlock: View {
    @Environment(\.palette) private var p
    @Environment(\.openURL) private var openURL
    let pack: EvidencePackDto

    /// Only absolute links (PRs) open on the phone; portal-internal pages don't exist here.
    private var externalLinks: [EvidenceLinkDto] {
        pack.links.filter { $0.href.hasPrefix("http") }
    }

    var body: some View {
        if let summary = pack.changes?.summary, !summary.isEmpty {
            Text(summary).ltype(.body).foregroundStyle(p.text)
        }
        if let branch = pack.branch {
            HStack(spacing: 4) {
                Text("Branch").foregroundStyle(p.faint)
                Text(branch).ltype(.mono).foregroundStyle(p.text2).lineLimit(1).truncationMode(.middle)
            }
            .ltype(.meta)
        }
        if !pack.flags.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(pack.flags) { flag in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(flag.severity == "danger" ? p.danger : p.warn)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(flag.label).ltype(.bodyEmph).foregroundStyle(p.text)
                            if let detail = flag.detail, !detail.isEmpty {
                                Text(detail).ltype(.meta).foregroundStyle(p.text2)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Risk flag, \(flag.label): \(flag.detail ?? "")")
                }
            }
        }
        ForEach(externalLinks, id: \.href) { link in
            Button {
                if let url = URL(string: link.href) { openURL(url) }
            } label: {
                Label(link.label, systemImage: link.kind == "pr" ? "arrow.triangle.pull" : "arrow.up.right.square")
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
    }
}
