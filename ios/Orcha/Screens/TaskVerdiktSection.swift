import SwiftUI

/// Verdikt inside the proof-of-work pack (web `VerdiktPanel`, trimmed for the phone):
/// the latest run's status / verdict, "Open in Verdikt" and the report link, and the
/// human's manual trigger — Run in Verdikt / Retry / Run again — exactly where the web
/// offers it. A Verdikt verdict is evidence only: it never accepts or rejects the task.
struct TaskVerdiktSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.openURL) private var openURL
    let taskId: String
    let latest: VerdiktRunDto?
    let onChanged: (VerdiktRunDto) -> Void

    @State private var settings: VerdiktSettingsBrief?
    @State private var settingsFailed = false

    private var enabled: Bool { (settings?.enabled ?? false) && (settings?.configured ?? false) }
    private var canOpen: Bool { latest != nil || settings?.baseUrl != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Verdikt")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if canOpen {
                    linkButton("Open in Verdikt", icon: "arrow.up.right.square", path: openPath)
                }
            }
            if latest == nil, let settings, !(settings.enabled && settings.configured) {
                Text("Verdikt isn't set up for this project.")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
            } else {
                statusLine
                HStack(spacing: LSpace.s) {
                    if let report = latest?.reportUrl {
                        linkButton("Open Verdikt report", icon: "doc.text.magnifyingglass", path: report)
                    }
                    Spacer(minLength: 0)
                    if !EvidenceUx.verdiktIsOpen(latest), settings != nil {
                        LButton(runLabel, icon: latest == nil ? "play" : "arrow.clockwise", kind: .secondary, size: .small) {
                            trigger()
                        }
                        .disabled(!enabled || !model.access.canWrite || model.actionInFlight)
                        .accessibilityHint("Hand this task's definition of done to Verdikt")
                    }
                }
            }
        }
        .task(id: latest?.id ?? "none") { await loadSettings() }
    }

    @ViewBuilder
    private var statusLine: some View {
        if let run = latest {
            VStack(alignment: .leading, spacing: 2) {
                Text(EvidenceUx.verdiktStatusText(run))
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.evidenceColor(EvidenceUx.verdiktTone(status: run.status, verdict: run.verdict)))
                let ago = MobileUx.agoLabel(run.finishedAt ?? run.createdAt)
                Text([run.trigger == "auto" ? "auto" : "manual", ago].compactMap { $0 }.joined(separator: " · "))
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                if let why = run.error ?? run.reason, !why.isEmpty, run.status != "completed" {
                    Text(why).ltype(.meta).foregroundStyle(p.text2).lineLimit(3)
                }
            }
            .accessibilityElement(children: .combine)
        } else {
            Text(settingsFailed ? "Verdikt settings could not be loaded." : (settings == nil ? "Loading…" : "Not run for this task yet."))
                .ltype(.meta)
                .foregroundStyle(p.faint)
        }
    }

    private var runLabel: String {
        guard let latest else { return "Run in Verdikt" }
        return latest.status == "completed" ? "Run again" : "Retry"
    }

    private var openPath: String {
        "/api/tasks/\(taskId)/verdikt/open" + (latest.map { "?run=\($0.id)" } ?? "")
    }

    private func linkButton(_ title: String, icon: String, path: String) -> some View {
        Button {
            if let url = model.portalURL(path) { openURL(url) }
        } label: {
            Label(title, systemImage: icon)
                .ltype(.meta)
                .foregroundStyle(p.accent)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func trigger() {
        Task {
            if let run = await model.runVerdikt(taskId) { onChanged(run) }
        }
    }

    private func loadSettings() async {
        do {
            if let response = try await model.fetchVerdiktRuns(taskId) {
                settings = response.settings ?? VerdiktSettingsBrief(configured: false, enabled: false)
                settingsFailed = false
            }
        } catch is CancellationError {
            return
        } catch {
            settingsFailed = true
        }
    }
}
