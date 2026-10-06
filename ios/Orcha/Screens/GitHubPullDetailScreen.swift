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
            VStack(spacing: LSpace.m) {
                SkeletonBlock(height: 72)
                SkeletonBlock(height: 160)
                SkeletonBlock(height: 120)
            }
            .padding(LSpace.l)
        }
    }

    private func loaded(_ pull: GitHubPullDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.xl) {
                header(pull)
                GitHubTrackedCard(startedTaskId: startedTask, disabled: model.actionInFlight) {
                    showStartPicker = true
                }
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
            .padding(LSpace.l)
        }
        .background(p.bg)
        .refreshable { await load() }
    }

    private func header(_ pull: GitHubPullDetail) -> some View {
        let state = GitHubDetailState.pull(state: pull.state, draft: pull.draft)
        return GitHubDetailHeader(state: state, number: pull.number, title: pull.title) {
            if let author = pull.authorLogin {
                GitHubPersonMeta(login: author)
            }
            // base ← head, mirroring GitHub's own "into base from head" framing.
            HStack(spacing: 4) {
                Text(pull.base).foregroundStyle(p.text2)
                Image(systemName: "arrow.left")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(p.faint)
                    .accessibilityLabel("from")
                Text(pull.head).foregroundStyle(p.text)
            }
            .ltype(.micro)
            .monospaced()
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 5))
            ChecksChip(checks: pull.checks)
            MergeStateChip(mergeableState: pull.mergeableState)
            if !pull.requestedReviewers.isEmpty {
                LTag("Reviewers: \(pull.requestedReviewers.joined(separator: ", "))")
            }
            if let ago = MobileUx.agoLabel(pull.updatedAt) {
                Text("Updated \(ago)").ltype(.micro).foregroundStyle(p.faint)
            }
        }
    }

    @ViewBuilder
    private func checksSection(_ checks: GitHubChecks) -> some View {
        let summary = GitHubHubUx.checksSummary(checks)
        section("Checks", count: summary.hasChecks ? checks.total : nil) {
            if checks.runs.isEmpty {
                Text(summary.hasChecks ? "No per-run detail reported." : "No checks are configured on this repository.")
                    .ltype(.meta).foregroundStyle(p.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(checks.runs.enumerated()), id: \.element.id) { index, run in
                        if index > 0 { LDivider() }
                        HStack(spacing: LSpace.s) {
                            CheckRunGlyph(run: run)
                            Text(run.name.isEmpty ? "(unnamed check)" : run.name)
                                .ltype(.meta)
                                .foregroundStyle(p.text)
                                .lineLimit(1)
                            Spacer()
                            if let conclusion = run.conclusion {
                                Text(conclusion)
                                    .ltype(.micro)
                                    .monospaced()
                                    .foregroundStyle(p.muted)
                            }
                        }
                        .frame(minHeight: 36)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func filesSection(_ files: GitHubFiles, htmlUrl: String?) -> some View {
        section("Files changed", count: files.count) {
            if files.items.isEmpty {
                Text("No file changes reported.")
                    .ltype(.meta).foregroundStyle(p.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(files.items.enumerated()), id: \.element.id) { index, file in
                        if index > 0 { LDivider() }
                        ChangedFileRow(file: file, htmlUrl: htmlUrl)
                    }
                    if files.truncated {
                        Text("Showing the first \(files.items.count) of \(files.count) changed files.")
                            .ltype(.micro)
                            .foregroundStyle(p.faint)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, LSpace.s)
                    }
                    if files.patchesTruncated {
                        Text("Some diffs were too large to include here — view the full changes on GitHub.")
                            .ltype(.micro)
                            .foregroundStyle(p.faint)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, LSpace.s)
                    }
                }
            }
        }
    }

    private func section(_ title: String, count: Int? = nil, @ViewBuilder content: () -> some View) -> some View {
        LSection(title, count: count) {
            LCard { content() }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var parsedFile: DiffFile? {
        guard let patch = file.patch else { return nil }
        return DiffParser.parseFilePatch(patch, filename: file.filename)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .lSpring) { expanded.toggle() }
            } label: {
                HStack(spacing: LSpace.s) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(p.faint)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(file.filename)
                        .ltype(.mono)
                        .foregroundStyle(p.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: LSpace.s)
                    DiffCounts(adds: file.additions, dels: file.deletions, compact: true)
                }
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.filename), \(file.additions) additions, \(file.deletions) deletions")
            .accessibilityHint(expanded ? "Collapses the diff" : "Expands the diff")

            if expanded {
                if let parsedFile {
                    DiffFileBody(file: parsedFile)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(p.border, lineWidth: 1))
                        .padding(.bottom, LSpace.s)
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
                .ltype(.meta)
                .foregroundStyle(p.muted)
            if let htmlUrl, let url = URL(string: htmlUrl) {
                Link("View on GitHub", destination: url)
                    .ltype(.meta)
                    .fontWeight(.medium)
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
            HStack(spacing: LSpace.s) {
                GitHubMark().frame(width: 15, height: 15)
                Text("Open on GitHub")
                    .ltype(.bodyEmph)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(p.faint)
            }
            .foregroundStyle(p.text)
            .padding(.horizontal, LSpace.m)
            .frame(minHeight: 44)
            .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous).strokeBorder(p.border, lineWidth: 1))
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
            VStack(spacing: LSpace.m) {
                Banner(kind: .danger, text: message)
                LButton("Try again", icon: "arrow.clockwise", kind: .secondary) {
                    Task { await retry() }
                }
            }
            .padding(LSpace.l)
        }
        .refreshable { await retry() }
    }
}

// MARK: - Shared Linear detail pieces (issue + PR)

/// GitHub state → glyph + tint, web parity: open green, merged violet, closed grey.
enum GitHubDetailState {
    case openIssue, closedIssue, openPull, draftPull, mergedPull, closedPull

    static func issue(state: String) -> Self { state == "closed" ? .closedIssue : .openIssue }

    static func pull(state: String, draft: Bool) -> Self {
        switch state {
        case "merged": .mergedPull
        case "closed": .closedPull
        default: draft ? .draftPull : .openPull
        }
    }

    var glyph: String {
        switch self {
        case .openIssue: "smallcircle.filled.circle"
        case .closedIssue: "checkmark.circle"
        case .openPull, .draftPull: "arrow.triangle.pull"
        case .mergedPull: "arrow.triangle.merge"
        case .closedPull: "xmark.circle"
        }
    }

    var label: String {
        switch self {
        case .openIssue, .openPull: "Open"
        case .closedIssue, .closedPull: "Closed"
        case .draftPull: "Draft"
        case .mergedPull: "Merged"
        }
    }

    func tint(_ p: Palette) -> Color {
        switch self {
        case .openIssue, .openPull: p.ok
        case .mergedPull: p.violet
        case .closedIssue, .closedPull, .draftPull: p.muted
        }
    }
}

/// Calm detail header: state pill + mono number, the title, then a wrapping meta row.
struct GitHubDetailHeader<Meta: View>: View {
    @Environment(\.palette) private var p
    let state: GitHubDetailState
    let number: Int
    let title: String
    @ViewBuilder let meta: Meta

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.m) {
            HStack(spacing: LSpace.s) {
                HStack(spacing: 5) {
                    Image(systemName: state.glyph)
                        .font(.system(size: 11, weight: .semibold))
                    Text(state.label)
                        .ltype(.micro)
                        .fontWeight(.semibold)
                }
                .foregroundStyle(state.tint(p))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(state.tint(p).opacity(0.12), in: Capsule())
                Text("#\(number)")
                    .ltype(.mono)
                    .foregroundStyle(p.faint)
            }
            .accessibilityElement(children: .combine)
            Text(title)
                .ltype(.title)
                .foregroundStyle(p.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: LSpace.s) { meta }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
    }
}

/// Avatar + login, for a meta row.
struct GitHubPersonMeta: View {
    @Environment(\.palette) private var p
    let login: String

    var body: some View {
        HStack(spacing: 5) {
            LAvatar(name: login, size: 18)
            Text(login)
                .ltype(.micro)
                .fontWeight(.medium)
                .foregroundStyle(p.text2)
        }
        .accessibilityElement(children: .combine)
    }
}

/// "Tracked in Embodent" — links the started task when there is one; otherwise
/// offers Start (the same agent picker as the toolbar).
struct GitHubTrackedCard: View {
    @Environment(\.palette) private var p
    let startedTaskId: String?
    let disabled: Bool
    let onStart: () -> Void

    var body: some View {
        HStack(spacing: LSpace.m) {
            BrandMark(size: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(startedTaskId == nil ? "Not tracked in Embodent" : "Tracked in Embodent")
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                Text(startedTaskId == nil ? "Start a task to hand this to an agent." : "A task is following this item.")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let taskId = startedTaskId {
                NavigationLink {
                    TaskDetailScreen(taskId: taskId)
                } label: {
                    HStack(spacing: 4) {
                        Text("Open task").ltype(.meta).fontWeight(.medium)
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 44)
                }
            } else {
                LButton("Start", icon: "play.fill", kind: .primary, size: .small, action: onStart)
                    .disabled(disabled)
            }
        }
        .padding(LSpace.m)
        .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous).strokeBorder(p.border, lineWidth: 1))
    }
}
