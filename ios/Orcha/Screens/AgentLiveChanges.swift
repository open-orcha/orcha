import SwiftUI
import UIKit

/// "Live changes" — what an agent's running run is changing on disk (web
/// `LiveChangesPanel` parity). Polls `…/changes?since=` every few seconds while the
/// screen is up; an unchanged poll is a tiny `{unchanged:true}`. A finished run reads once.
struct AgentLiveChangesSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let runId: String
    var live = true

    @State private var payload: RunChangesDto?
    @State private var failed = false

    private static let pollInterval: Duration = .seconds(3)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionH(title: live ? "Live changes" : "Changes", count: countLabel)
            content
        }
        .task(id: runId) { await poll() }
    }

    private var countLabel: String? {
        guard let payload, payload.available else { return nil }
        let s = payload.summary
        return "\(s.files) \(s.files == 1 ? "file" : "files") · +\(s.additions) −\(s.deletions)"
    }

    @ViewBuilder
    private var content: some View {
        if let payload {
            if !payload.available {
                OrchaCard {
                    Text(AgentChangesUx.unavailableCopy(payload.reason, detail: payload.detail))
                        .ltype(.meta).foregroundStyle(p.muted)
                }
            } else if payload.files.isEmpty {
                OrchaCard {
                    Text(live ? "No file changes yet — they appear here as the agent edits." : "This run changed no files.")
                        .ltype(.meta).foregroundStyle(p.muted)
                }
            } else {
                LCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(payload.files) { file in
                            if file.id != payload.files.first?.id { LDivider(inset: LSpace.m) }
                            NavigationLink {
                                RunChangeDiffScreen(agentId: agentId, runId: runId, file: file)
                            } label: {
                                RunChangedFileRow(file: file)
                            }
                            .buttonStyle(.lRow)
                        }
                    }
                }
                if payload.truncated {
                    Text("Showing the first \(payload.files.count) files.").ltype(.micro).foregroundStyle(p.faint)
                }
            }
        } else if failed {
            OrchaCard { Text("Couldn't read this run's changes.").ltype(.meta).foregroundStyle(p.muted) }
        } else {
            OrchaCard {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                    .accessibilityLabel("Loading changes")
            }
        }
    }

    private func poll() async {
        payload = nil
        failed = false
        while !Task.isCancelled {
            await tick()
            // A finished run's captured diff never changes: one read.
            guard live, payload?.running ?? true else { return }
            try? await Task.sleep(for: Self.pollInterval)
        }
    }

    private func tick() async {
        guard let base = model.selectedContainer?.baseUrl else { return }
        do {
            let next = try await model.api.runChanges(base, agentId, runId, since: payload?.version)
            if next.unchanged {
                if var held = payload { held.running = next.running; payload = held }
            } else {
                payload = next
            }
            failed = false
        } catch is CancellationError {
        } catch {
            if payload == nil { failed = true }
        }
    }
}

/// One changed file: type glyph, name over its folder, status word, +/− counts.
private struct RunChangedFileRow: View {
    @Environment(\.palette) private var p
    let file: RunChangedFile

    var body: some View {
        HStack(spacing: LSpace.s) {
            Image(systemName: AgentChangesUx.isImage(file.path) ? "photo" : "doc.text")
                .font(.system(size: 12))
                .foregroundStyle(p.muted)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(AgentChangesUx.fileName(file.path))
                    .ltype(.mono).foregroundStyle(p.text).lineLimit(1).truncationMode(.middle)
                Text(AgentChangesUx.statusLabel(file.status) + " · " + file.path)
                    .ltype(.micro).foregroundStyle(p.faint).lineLimit(1).truncationMode(.head)
            }
            Spacer(minLength: LSpace.s)
            if let a = file.additions, let d = file.deletions {
                DiffCounts(adds: a, dels: d, compact: true)
            } else {
                Text("binary").ltype(.micro).foregroundStyle(p.faint)
            }
        }
        .padding(.horizontal, LSpace.m)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the diff")
    }
}

/// One changed file's diff (`…/changes/diff?path=`) in the shared `DiffViewer`. Image
/// files render as before/after previews from `…/changes/raw` instead of "binary".
struct RunChangeDiffScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let runId: String
    let file: RunChangedFile

    @State private var diff: RunDiffDto?
    @State private var error: String?

    private var isImage: Bool { AgentChangesUx.isImage(file.path) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.m) {
                Text(file.path).ltype(.mono).foregroundStyle(p.text2).textSelection(.enabled)
                if isImage {
                    imagePreviews
                } else if let diff {
                    if !diff.available {
                        Banner(kind: .info, text: AgentChangesUx.unavailableCopy(diff.reason, detail: diff.detail))
                    } else if diff.binary {
                        OrchaCard { Text("Binary file — no textual diff.").ltype(.meta).foregroundStyle(p.muted) }
                    } else {
                        DiffViewer(diff: diff.diff ?? "")
                        if diff.truncated {
                            Text("This diff was truncated.").ltype(.micro).foregroundStyle(p.faint)
                        }
                    }
                } else if let error {
                    Banner(kind: .danger, text: error)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                        .accessibilityLabel("Loading diff")
                }
            }
            .padding(LSpace.l)
        }
        .background(p.bg)
        .navigationTitle(AgentChangesUx.fileName(file.path))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if !isImage { await load() } }
    }

    @ViewBuilder
    private var imagePreviews: some View {
        let status = AgentChangesUx.statusLabel(file.status)
        if status != "Added" {
            RunChangeImage(agentId: agentId, runId: runId, path: file.path, side: "old", caption: "Before")
        }
        if status != "Deleted" {
            RunChangeImage(agentId: agentId, runId: runId, path: file.path, side: "new", caption: status == "Added" ? "Added" : "After")
        }
    }

    private func load() async {
        guard let base = model.selectedContainer?.baseUrl else { return }
        do {
            diff = try await model.api.runChangeDiff(base, agentId, runId, path: file.path)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = model.friendly(error)
        }
    }
}

/// One side of an image change, fetched as raw bytes.
private struct RunChangeImage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let runId: String
    let path: String
    let side: String
    let caption: String

    @State private var image: UIImage?
    @State private var missing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(caption).ltype(.meta).fontWeight(.medium).foregroundStyle(p.text2)
            LCard {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 360)
                        .accessibilityLabel("\(caption): \(AgentChangesUx.fileName(path))")
                } else if missing {
                    Text("No preview available.").ltype(.meta).foregroundStyle(p.muted)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 80)
                        .accessibilityLabel("Loading image")
                }
            }
        }
        .task {
            guard let base = model.selectedContainer?.baseUrl else { return }
            if let data = try? await model.api.runChangeRaw(base, agentId, runId, path: path, side: side),
               let img = UIImage(data: data) {
                image = img
            } else {
                missing = true
            }
        }
    }
}
