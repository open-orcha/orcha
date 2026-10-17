import SwiftUI
import UIKit

/// One deliverable (web `DeliverableDetail` parity): the selected version's preview
/// (text / markdown / table as text, image, PDF), who produced it, the version history,
/// and "Compare with vN" — a unified diff against an earlier version.
struct DeliverableDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String
    let deliverable: DeliverableDto

    @State private var versions: [DeliverableVersionDto] = []
    @State private var selected: Int
    @State private var compareFrom: Int?
    @State private var historyError: String?

    init(taskId: String, deliverable: DeliverableDto) {
        self.taskId = taskId
        self.deliverable = deliverable
        _selected = State(initialValue: deliverable.latestVersion)
    }

    private var current: DeliverableVersionDto? {
        versions.first { $0.version == selected } ?? (selected == deliverable.latestVersion ? deliverable.latest : nil)
    }

    private var older: [DeliverableVersionDto] { versions.filter { $0.version < selected } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(deliverable.path).ltype(.mono).foregroundStyle(p.text2).textSelection(.enabled)
                    Text(metaLine).ltype(.meta).foregroundStyle(p.muted)
                }
                controls
                if let historyError {
                    Banner(kind: .warn, text: "History unavailable — \(historyError)")
                }
                if let from = compareFrom {
                    DeliverableDiffView(taskId: taskId, deliverableId: deliverable.id, from: from, to: selected)
                        .id("diff-\(from)-\(selected)")
                } else {
                    DeliverablePreviewView(taskId: taskId, deliverable: deliverable, version: selected)
                        .id("preview-\(selected)")
                }
                if let note = current?.note, !note.isEmpty {
                    Text("Note: \(note)").ltype(.meta).foregroundStyle(p.text2)
                }
                if versions.count > 1 { history }
            }
            .padding(LSpace.l)
        }
        .background(p.bg)
        .navigationTitle(deliverable.name)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: selected) {
            if let from = compareFrom, from >= selected { compareFrom = nil }
        }
        .task { await loadHistory() }
        .refreshable { await loadHistory() }
    }

    private var metaLine: String {
        var parts = [DeliverableUx.kindLabel(deliverable.kind), "v\(selected)"]
        if let current {
            let src = DeliverableUx.sourceLabel(current)
            if !src.isEmpty { parts.append(src) }
            parts.append(DeliverableUx.formatBytes(current.sizeBytes))
            if let ago = MobileUx.agoLabel(current.createdAt) { parts.append(ago) }
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: LSpace.s) {
            if versions.count > 1 {
                Menu {
                    Picker("Version", selection: $selected) {
                        ForEach(versions) { v in
                            Text("v\(v.version)\(v.version == deliverable.latestVersion ? " (latest)" : "")").tag(v.version)
                        }
                    }
                } label: {
                    Label("v\(selected)", systemImage: "chevron.up.chevron.down")
                        .ltype(.meta)
                        .frame(minHeight: 44)
                }
                .accessibilityLabel("Version of \(deliverable.name), v\(selected)")
            }
            Spacer(minLength: 0)
            if let first = older.first {
                if compareFrom == nil {
                    LButton("Compare with v\(first.version)", icon: "arrow.left.arrow.right", kind: .ghost, size: .small) {
                        compareFrom = first.version
                    }
                } else {
                    Menu {
                        Picker("Compare against", selection: $compareFrom) {
                            ForEach(older) { v in Text("against v\(v.version)").tag(Int?.some(v.version)) }
                        }
                    } label: {
                        Text("against v\(compareFrom ?? first.version)").ltype(.meta).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Compare against version")
                    LButton("Preview", kind: .ghost, size: .small) { compareFrom = nil }
                }
            }
        }
    }

    private var history: some View {
        LSection("Version history", count: versions.count) {
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(versions) { v in
                        if v.version != versions.first?.version { LDivider(inset: LSpace.m) }
                        Button { selected = v.version } label: {
                            HStack(spacing: LSpace.s) {
                                Text("v\(v.version)").ltype(.mono).foregroundStyle(v.version == selected ? p.accent : p.text)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(DeliverableUx.sourceLabel(v)).ltype(.meta).foregroundStyle(p.text2).lineLimit(1)
                                    if let note = v.note, !note.isEmpty {
                                        Text(note).ltype(.micro).foregroundStyle(p.faint).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: LSpace.s)
                                Text([DeliverableUx.formatBytes(v.sizeBytes), MobileUx.agoLabel(v.createdAt)].compactMap { $0 }.joined(separator: " · "))
                                    .ltype(.micro).foregroundStyle(p.faint)
                            }
                            .padding(.horizontal, LSpace.m)
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.lRow)
                        .accessibilityAddTraits(v.version == selected ? .isSelected : [])
                    }
                }
            }
        }
    }

    private func loadHistory() async {
        do {
            if let full = try await model.fetchDeliverable(taskId, deliverable.id) {
                versions = full.versions ?? []
                historyError = nil
            }
        } catch is CancellationError {
        } catch {
            historyError = model.friendly(error)
        }
    }
}

/// The selected version's preview: text kinds via `/text`, images and PDFs via `/raw`.
private struct DeliverablePreviewView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String
    let deliverable: DeliverableDto
    let version: Int

    @State private var text: DeliverableTextDto?
    @State private var bytes: Data?
    @State private var error: String?

    var body: some View {
        Group {
            if let error {
                Banner(kind: .danger, text: "Preview unavailable — \(error)")
            } else if let text {
                textPreview(text)
            } else if let bytes {
                bytesPreview(bytes)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                    .accessibilityLabel("Loading preview")
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func textPreview(_ t: DeliverableTextDto) -> some View {
        LCard {
            if deliverable.kind == "markdown" {
                ChatMarkdownView(text: t.text, tasks: model.snapshot?.tasks ?? [])
                    .ltype(.body).foregroundStyle(p.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView(.horizontal) {
                    Text(t.text.isEmpty ? "(empty file)" : t.text)
                        .ltype(.mono).foregroundStyle(p.text2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
        }
        if t.truncated {
            Text("Showing the start of a long file.").ltype(.micro).foregroundStyle(p.faint)
        }
    }

    @ViewBuilder
    private func bytesPreview(_ data: Data) -> some View {
        if deliverable.kind == "pdf" {
            PDFDocumentView(data: data)
                .frame(height: 520)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("PDF preview of \(deliverable.name)")
        } else if let image = UIImage(data: data) {
            LCard {
                Image(uiImage: image)
                    .resizable().scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 480)
                    .accessibilityLabel("Image: \(deliverable.name)")
            }
        } else {
            OrchaCard { Text("No preview available.").ltype(.meta).foregroundStyle(p.muted) }
        }
    }

    private func load() async {
        do {
            if DeliverableUx.isText(deliverable.kind) {
                text = try await model.fetchDeliverableText(taskId, deliverable.id, version: version)
            } else if deliverable.kind == "image" || deliverable.kind == "pdf" {
                bytes = try await model.fetchDeliverableRaw(taskId, deliverable.id, version: version)
            } else {
                error = "this file type has no preview"
            }
        } catch is CancellationError {
        } catch {
            self.error = model.friendly(error)
        }
    }
}

/// "Compare" — a text diff between two versions in the shared `DiffViewer`; binary
/// kinds say whether the bytes changed.
private struct DeliverableDiffView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String
    let deliverableId: String
    let from: Int
    let to: Int

    @State private var diff: DeliverableDiffDto?
    @State private var error: String?

    var body: some View {
        Group {
            if let error {
                Banner(kind: .danger, text: "Diff unavailable — \(error)")
            } else if let diff {
                if diff.binary {
                    OrchaCard {
                        Text(diff.bytesChanged ? "v\(from) and v\(to) differ — binary files have no line diff." : "v\(from) and v\(to) are identical.")
                            .ltype(.meta).foregroundStyle(p.muted)
                    }
                } else if diff.identical == true || (diff.diff ?? "").isEmpty {
                    OrchaCard { Text("No differences between v\(from) and v\(to).").ltype(.meta).foregroundStyle(p.muted) }
                } else {
                    DiffViewer(diff: diff.diff ?? "")
                    if diff.truncated == true {
                        Text("This diff was truncated.").ltype(.micro).foregroundStyle(p.faint)
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                    .accessibilityLabel("Loading diff")
            }
        }
        .task {
            do {
                diff = try await model.fetchDeliverableDiff(taskId, deliverableId, from: from, to: to)
            } catch is CancellationError {
            } catch {
                self.error = model.friendly(error)
            }
        }
    }
}
