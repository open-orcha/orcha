import SwiftUI

/// PR detail — title + state chips + base ← head, then sectioned: description
/// (ChatMarkdownView), checks (per-run glyphs), changed files (+/- counts, truncated
/// note), and an open-on-GitHub link. Start-from-detail lives in the toolbar. Loads
/// its own phase (owned locally, not on the app-wide model) so a `not_found` / off
/// state renders a friendly panel here rather than an error screen.
struct GitHubPullDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let number: Int

    @State private var phase: GitHubPullDetailPhase = .loading
    @State private var showStartPicker = false
    @State private var startedTask: String?

    var body: some View {
        Group {
            switch phase {
            case .loading:
                loadingState
            case let .unavailable(reason, detail):
                GitHubDetailUnavailable(reason: reason, detail: detail) { await load() }
            case let .failed(message):
                GitHubDetailFailed(message: message) { await load() }
            case let .loaded(_, pull):
                loaded(pull)
            }
        }
        .navigationTitle("PR #\(number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if case .loaded = phase {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Start", systemImage: "play.fill") { showStartPicker = true }
                        .disabled(model.actionInFlight)
                }
            }
        }
        .sheet(isPresented: $showStartPicker) {
            if case let .loaded(_, pull) = phase {
                GitHubStartPickerSheet(
                    kind: .pulls, number: pull.number, title: pull.title,
                    bodyExcerpt: nil, htmlUrl: pull.htmlUrl
                ) { response in
                    startedTask = response.taskId
                }
            }
        }
        .navigationDestination(item: $startedTask) { taskId in
            TaskDetailScreen(taskId: taskId)
        }
        .task { await load() }
    }

    private func load() async {
        phase = await model.loadGithubPullDetail(number)
    }

    private var loadingState: some View {
        ScrollView {
            VStack(spacing: 12) {
                SkeletonBlock(height: 60)
                SkeletonBlock(height: 160)
                SkeletonBlock(height: 120)
            }
            .padding(16)
        }
    }

    private func loaded(_ pull: GitHubPullDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(pull)
                if !pull.bodyMarkdown.isEmpty {
                    section("Description") {
                        ChatMarkdownView(text: pull.bodyMarkdown)
                    }
                }
                checksSection(pull.checks)
                filesSection(pull.files, htmlUrl: pull.htmlUrl)
                if let url = pull.htmlUrl.flatMap(URL.init(string:)) {
                    OpenOnGitHubLink(url: url)
                }
            }
            .padding(16)
        }
        .refreshable { await load() }
    }

    private func header(_ pull: GitHubPullDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(pull.title)
                .font(p.uiFont(19, .bold))
                .foregroundStyle(p.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                StatusPill(status: pull.draft ? "draft" : pull.state, domain: .task)
                ChecksChip(checks: pull.checks)
                MergeStateChip(mergeableState: pull.mergeableState)
            }
            // base ← head, mirroring GitHub's own "into base from head" framing.
            HStack(spacing: 6) {
                Text(pull.base)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(p.text2)
                Image(systemName: "arrow.left")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(p.muted)
                Text(pull.head)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(p.accent)
            }
            .lineLimit(1)
            HStack(spacing: 6) {
                if let author = pull.authorLogin {
                    AgentAvatar(alias: author, human: true, githubLogin: author, size: 22)
                    Text(author).font(p.uiFont(12)).foregroundStyle(p.text2)
                }
                if !pull.requestedReviewers.isEmpty {
                    MetaTag(text: "reviewers: \(pull.requestedReviewers.joined(separator: ", "))")
                }
                Spacer()
                Text(MobileUx.agoLabel(pull.updatedAt).map { "updated \($0)" } ?? "")
                    .font(p.uiFont(11)).foregroundStyle(p.faint)
            }
        }
    }

    @ViewBuilder
    private func checksSection(_ checks: GitHubChecks) -> some View {
        let summary = GitHubHubUx.checksSummary(checks)
        section("Checks · \(summary.label)") {
            if checks.runs.isEmpty {
                Text(summary.hasChecks ? "No per-run detail reported." : "No checks are configured on this repository.")
                    .font(p.uiFont(13)).foregroundStyle(p.muted)
            } else {
                VStack(spacing: 8) {
                    ForEach(checks.runs) { run in
                        HStack(spacing: 8) {
                            CheckRunGlyph(run: run)
                            Text(run.name.isEmpty ? "(unnamed check)" : run.name)
                                .font(p.uiFont(13))
                                .foregroundStyle(p.text)
                                .lineLimit(1)
                            Spacer()
                            if let conclusion = run.conclusion {
                                Text(conclusion)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(p.muted)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func filesSection(_ files: GitHubFiles, htmlUrl: String?) -> some View {
        section("Files · \(files.count)") {
            if files.items.isEmpty {
                Text("No file changes reported.")
                    .font(p.uiFont(13)).foregroundStyle(p.muted)
            } else {
                VStack(spacing: 6) {
                    ForEach(files.items) { file in
                        ChangedFileRow(file: file, htmlUrl: htmlUrl)
                    }
                    if files.truncated {
                        Text("Showing the first \(files.items.count) of \(files.count) changed files.")
                            .font(p.uiFont(11))
                            .foregroundStyle(p.faint)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if files.patchesTruncated {
                        Text("Some diffs were too large to include here — view the full changes on GitHub.")
                            .font(p.uiFont(11))
                            .foregroundStyle(p.faint)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionH(title: title)
            OrchaCard { content() }
        }
    }
}

/// A changed-file row: filename + additions/deletions, tappable to expand that file's
/// patch in place (rendered by `DiffFileBody`, the same per-file body `DiffViewer` uses
/// for run diffs). A `patch_omitted` file (binary, GitHub-side too-large, or the
/// server's own patch-byte budget) or a nil `patch` (older server, before this field
/// existed) collapses to the existing "view on GitHub" affordance instead — never an
/// empty expand.
struct ChangedFileRow: View {
    @Environment(\.palette) private var p
    let file: GitHubChangedFile
    /// The PR's own URL — reused for the per-file "view on GitHub" fallback link
    /// (GitHub has no stable per-file anchor to link to, so this opens the PR itself).
    let htmlUrl: String?

    @State private var expanded = false

    private var parsedFile: DiffFile? {
        guard let patch = file.patch else { return nil }
        return DiffParser.parseFilePatch(patch, filename: file.filename)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(duration: 0.25)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(p.faint)
                    Text(file.filename)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(p.text2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    if file.additions > 0 {
                        Text("+\(file.additions)")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(p.ok)
                    }
                    if file.deletions > 0 {
                        Text("-\(file.deletions)")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(p.danger)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.filename), \(file.additions) additions, \(file.deletions) deletions")
            .accessibilityHint(expanded ? "Collapses the diff" : "Expands the diff")

            if expanded {
                if let parsedFile {
                    DiffFileBody(file: parsedFile)
                        .padding(.top, 6)
                } else {
                    omittedNote
                }
            }
        }
    }

    @ViewBuilder
    private var omittedNote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(file.patchOmitted
                 ? "This diff is too large to show here."
                 : "This diff isn't available from this server yet.")
                .font(p.uiFont(12))
                .foregroundStyle(p.muted)
            if let htmlUrl, let url = URL(string: htmlUrl) {
                Link("View on GitHub", destination: url)
                    .font(p.uiFont(12, .semibold))
                    .foregroundStyle(p.accent)
            }
        }
        .padding(.top, 6)
        .padding(.bottom, 4)
    }
}

/// Shared "open on GitHub" row — a `Link` (opens Safari) styled like a tonal action.
struct OpenOnGitHubLink: View {
    @Environment(\.palette) private var p
    let url: URL

    var body: some View {
        Link(destination: url) {
            HStack(spacing: 8) {
                GitHubMark().frame(width: 15, height: 15)
                Text("Open on GitHub")
                    .font(p.uiFont(14, .semibold))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(p.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: p.radiusButton))
            .overlay(RoundedRectangle(cornerRadius: p.radiusButton).strokeBorder(p.border2, lineWidth: 1))
        }
        .accessibilityHint("Opens this item in Safari")
    }
}

/// Shared graceful-off panel for a detail screen (not_found / repo_not_connected).
struct GitHubDetailUnavailable: View {
    @Environment(\.palette) private var p
    let reason: String?
    let detail: String?
    let retry: () async -> Void

    var body: some View {
        ScrollView {
            StateLayout(
                title: reason == "not_found" ? "Not on GitHub" : "GitHub isn't connected",
                sub: GitHubHubUx.unavailableCopy(reason: reason, detail: detail)
            ) {
                GitHubMark().frame(width: 34, height: 34).foregroundStyle(p.muted)
            } actions: {
                EmptyView()
            }
            .padding(.top, 40)
        }
        .refreshable { await retry() }
    }
}

/// Shared transport-failure panel for a detail screen.
struct GitHubDetailFailed: View {
    let message: String
    let retry: () async -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Banner(kind: .danger, text: message)
                KitButton(title: "Try again", role: .neutral) {
                    Task { await retry() }
                }
                .frame(maxWidth: 220)
            }
            .padding(16)
        }
        .refreshable { await retry() }
    }
}
