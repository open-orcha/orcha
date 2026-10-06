import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Task deliverables (web `DeliverablesSection` parity) — the non-code outputs a task
/// produced (reports, tables, charts, PDFs) as calm rows: kind glyph, name over its
/// folder, version, who produced it, size, age. A row opens the preview with version
/// history and Compare. Humans with write access attach a file or photo while the task
/// is open; the server re-checks. Renders nothing for the root task or an older server.
struct TaskDeliverablesSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let task: TaskDto

    @State private var list: DeliverableListDto?
    @State private var loadError: String?
    @State private var unavailable = false
    @State private var importing = false
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var reloadTick = 0

    private var canAttach: Bool {
        DeliverableUx.canAttach(status: task.status, isRoot: task.isRoot, canWrite: model.access.canWrite)
    }

    private var allowedTypes: [UTType] {
        let exts = list?.limits?.allowedExtensions.nilIfEmpty ?? DeliverableUx.defaultExtensions
        let types = exts.compactMap { UTType(filenameExtension: $0) }
        return types.isEmpty ? [.data] : types
    }

    var body: some View {
        if !task.isRoot && !unavailable {
            LSection("Deliverables", count: list.map { $0.deliverables.count }.flatMap { $0 > 0 ? $0 : nil },
                     trailing: canAttach ? AnyView(attachMenu) : nil) {
                content
            }
            .task(id: "\(task.id)|\(task.status)|\(reloadTick)") { await load() }
            .fileImporter(isPresented: $importing, allowedContentTypes: allowedTypes, allowsMultipleSelection: true) { result in
                if case let .success(urls) = result { Task { await uploadFiles(urls) } }
            }
            .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .images)
            .onChange(of: photoItems) {
                let items = photoItems
                guard !items.isEmpty else { return }
                photoItems = []
                Task { await uploadPhotos(items) }
            }
        }
    }

    private var attachMenu: some View {
        Menu {
            Button("Choose file…", systemImage: "doc") { importing = true }
            Button("Photo library…", systemImage: "photo.on.rectangle") { pickingPhotos = true }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(p.text2)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(model.actionInFlight)
        .accessibilityLabel("Attach deliverable")
        .accessibilityHint("Attach a document, table, image or PDF")
    }

    @ViewBuilder
    private var content: some View {
        if let list {
            if list.deliverables.isEmpty {
                Text("None yet. Agents publish files by writing to \(list.limits?.outputsFolder ?? ".orcha/outputs")\(canAttach ? "; you can also attach one." : ".")")
                    .ltype(.meta).foregroundStyle(p.muted)
                    .padding(.horizontal, 4)
            } else {
                LCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(list.deliverables) { d in
                            if d.id != list.deliverables.first?.id { LDivider(inset: LSpace.m) }
                            NavigationLink {
                                DeliverableDetailScreen(taskId: task.id, deliverable: d)
                            } label: {
                                DeliverableRow(deliverable: d)
                            }
                            .buttonStyle(.lRow)
                        }
                    }
                }
            }
        } else if let loadError {
            HStack(spacing: LSpace.s) {
                Text("Deliverables unavailable — \(loadError)").ltype(.meta).foregroundStyle(p.muted)
                Spacer(minLength: 0)
                Button("Retry") { reloadTick += 1 }
                    .buttonStyle(.plain).ltype(.meta).foregroundStyle(p.accent)
                    .frame(minHeight: 44)
            }
            .padding(.horizontal, 4)
        } else {
            Text("Loading deliverables…").ltype(.meta).foregroundStyle(p.faint).padding(.horizontal, 4)
        }
    }

    private func load() async {
        do {
            list = try await model.fetchDeliverables(task.id)
            loadError = nil
        } catch is CancellationError {
        } catch let e as OrchaApiError where e.status == 404 {
            unavailable = true   // this server has no deliverables API
        } catch {
            if list == nil { loadError = model.friendly(error) }
        }
    }

    private func uploadFiles(_ urls: [URL]) async {
        var files: [DeliverableUpload] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) {
                files.append(DeliverableUpload(fileName: url.lastPathComponent, data: data))
            }
        }
        if await model.uploadDeliverables(task.id, files) { reloadTick += 1 }
    }

    private func uploadPhotos(_ items: [PhotosPickerItem]) async {
        let stamp = Int(Date().timeIntervalSince1970)
        var files: [DeliverableUpload] = []
        for (i, item) in items.enumerated() {
            // Re-encode as JPEG: the server accepts png/jpg/gif/webp, never HEIC.
            guard let raw = try? await item.loadTransferable(type: Data.self),
                  let jpeg = UIImage(data: raw)?.jpegData(compressionQuality: 0.9) else { continue }
            let suffix = items.count > 1 ? "-\(i + 1)" : ""
            files.append(DeliverableUpload(fileName: "photo-\(stamp)\(suffix).jpg", data: jpeg))
        }
        if await model.uploadDeliverables(task.id, files) { reloadTick += 1 }
    }
}

private extension Array {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}

/// One deliverable row: kind glyph · name over folder · version · source · size · age.
private struct DeliverableRow: View {
    @Environment(\.palette) private var p
    let deliverable: DeliverableDto

    private var meta: String {
        var parts: [String] = []
        if deliverable.versionCount > 1 { parts.append("v\(deliverable.latestVersion)") }
        let source = DeliverableUx.sourceLabel(deliverable.latest)
        if !source.isEmpty { parts.append(source) }
        parts.append(DeliverableUx.formatBytes(deliverable.latest?.sizeBytes))
        if let ago = MobileUx.agoLabel(deliverable.updatedAt) { parts.append(ago) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: LSpace.s) {
            Image(systemName: DeliverableUx.glyph(deliverable.kind))
                .font(.system(size: 13))
                .foregroundStyle(p.muted)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(DeliverableUx.dirOf(deliverable.path) + deliverable.name)
                    .ltype(.mono).foregroundStyle(p.text).lineLimit(1).truncationMode(.head)
                Text(meta).ltype(.micro).foregroundStyle(p.faint).lineLimit(1)
            }
            Spacer(minLength: LSpace.s)
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(p.faint)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, LSpace.m)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(DeliverableUx.kindLabel(deliverable.kind)), \(deliverable.name), \(meta)")
        .accessibilityHint("Opens the preview")
    }
}
