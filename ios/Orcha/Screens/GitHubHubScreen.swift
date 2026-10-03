import SwiftUI

/// The GitHub hub list — the phone parity of the portal's GitHub hub page. Segmented
/// Issues | Pull requests tabs, Open / Mine filters, compact rows (type icon, number,
/// title, labels/reviewers, checks summary, merge state, relative time), and a Start
/// affordance per row (tap → unassigned; long-press / menu → agent picker). Start
/// returns the created task, which the screen surfaces as a navigable link. The whole
/// surface degrades to a friendly "connect a repo" state on `available:false` / 404.
struct GitHubHubScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    @State private var kind: GitHubHubKind = .pulls
    @State private var filter: GitHubHubFilter = .open
    /// The row the agent-picker sheet is open for.
    @State private var startPickerItem: StartTarget?
    /// The task id a Start just produced — drives the push to its TaskDetailScreen.
    @State private var startedTaskId: String?
    /// Whether the PR filter row (author/involvement/search) is expanded. Starts
    /// collapsed — most visits just want the plain Open/Mine list.
    @State private var filterRowExpanded = false

    var body: some View {
        Group {
            switch kind {
            case .pulls: pullsContent
            case .issues: issuesContent
            }
        }
        .navigationTitle("GitHub")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .sheet(item: $startPickerItem) { target in
            GitHubStartPickerSheet(
                kind: target.kind, number: target.number,
                title: target.title, bodyExcerpt: target.bodyExcerpt, htmlUrl: target.htmlUrl
            ) { response in
                startedTaskId = response.taskId
            }
        }
        .navigationDestination(item: $startedTaskId) { taskId in
            TaskDetailScreen(taskId: taskId)
        }
        .task(id: kind) { await load() }
        // Debounced re-fetch on filter-row edits: waits for a pause in typing before
        // hitting the network, and `task(id:)` cancels the previous wait outright
        // whenever the id changes — no manual debounce timer/Task bookkeeping.
        .task(id: PullsFilterQuery(model.githubPullsFilter)) {
            guard kind == .pulls else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    // MARK: header (segment + filter)

    private var header: some View {
        VStack(spacing: 8) {
            LSegmented(GitHubHubKind.allCases.map { ($0, $0.title) }, selection: $kind)

            HStack(spacing: 8) {
                ForEach(GitHubHubFilter.allCases, id: \.self) { f in
                    LChip(f.label, selected: filter == f) { setFilter(f) }
                }
                if kind == .pulls {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { filterRowExpanded.toggle() }
                    } label: {
                        Image(systemName: filterRowExpanded ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(model.githubPullsFilter.isFiltering ? p.accent : p.muted)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel(filterRowExpanded ? "Hide filters" : "Show filters")
                }
                Spacer()
                if let repo = boundRepo {
                    Text(repo)
                        .ltype(.micro)
                        .monospaced()
                        .foregroundStyle(p.faint)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }

            if kind == .pulls, filterRowExpanded {
                PullsFilterRow(
                    detail: model.githubInvolvementUnavailableDetail,
                    knowsLogin: (model.githubLogin?.isEmpty == false)
                )
            }
        }
        .padding(.horizontal, LSpace.l)
        .padding(.top, LSpace.s)
        .padding(.bottom, LSpace.xs)
        .background(p.bg)
        .overlay(alignment: .bottom) { LDivider() }
        .lAnimation(value: kind)
    }

    /// The Open|Mine control switch — "Mine" rides through as the `author=<login>`
    /// shortcut server-side (see `GitHubHubUx.pullsQueryParams`), so changing it
    /// re-fetches page 1 exactly like any other filter edit.
    private func setFilter(_ f: GitHubHubFilter) {
        guard f != filter else { return }
        filter = f
        Task { await load() }
    }

    private var boundRepo: String? {
        switch kind {
        case .pulls:
            switch model.githubPullsPhase {
            case let .loaded(repo, _, _), let .loadingMore(repo, _, _): return repo ?? model.githubRepo
            default: break
            }
        case .issues:
            if case let .loaded(repo, _) = model.githubIssuesPhase { return repo }
        }
        return model.githubRepo
    }

    // MARK: pulls

    @ViewBuilder
    private var pullsContent: some View {
        switch model.githubPullsPhase {
        case .idle, .loading:
            loadingList
        case let .unavailable(reason, detail):
            unavailableState(reason: reason, detail: detail)
        case let .failed(message):
            failedState(message)
        // The server already applied Open|Mine + the filter row (author/involvement/
        // q) — these rows render as-is, no client-side re-filtering.
        case let .loaded(_, pulls, page):
            pullsList(pulls, page: page, isLoadingMore: false)
        case let .loadingMore(_, pulls, page):
            pullsList(pulls, page: page, isLoadingMore: true)
        }
    }

    private func pullsList(_ pulls: [GitHubPullRow], page: GitHubPullsPhase.Info, isLoadingMore: Bool) -> some View {
        listScroll(isEmpty: pulls.isEmpty, emptyNoun: "pull requests") {
            ForEach(pulls) { pull in
                NavigationLink(value: WorkspaceRoute.githubPull(pull.number)) {
                    GitHubPullRowCard(
                        pull: pull,
                        onStartUnassigned: { startUnassigned(for: pull) },
                        onStartWithAgent: { startTarget(for: pull) }
                    )
                }
                .buttonStyle(.plain)
            }
            loadMoreFooter(count: pulls.count, page: page, isLoadingMore: isLoadingMore)
        }
    }

    @ViewBuilder
    private func loadMoreFooter(count: Int, page: GitHubPullsPhase.Info, isLoadingMore: Bool) -> some View {
        if isLoadingMore {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .padding(.vertical, 8)
        } else if let caption = GitHubHubUx.loadMoreCaption(loadedCount: count, totalCount: page.totalCount, hasMore: page.hasMore) {
            VStack(spacing: 6) {
                Text(caption)
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
                if page.hasMore {
                    LButton("Load more", icon: "arrow.down", kind: .secondary, size: .small) {
                        Task { await model.loadMoreGithubPulls(filter: filter) }
                    }
                }
            }
            .padding(.top, LSpace.m)
        }
    }

    // MARK: issues

    @ViewBuilder
    private var issuesContent: some View {
        switch model.githubIssuesPhase {
        case .idle, .loading:
            loadingList
        case let .unavailable(reason, detail):
            unavailableState(reason: reason, detail: detail)
        case let .failed(message):
            failedState(message)
        case let .loaded(_, issues):
            let visible = GitHubHubUx.filterIssues(issues, filter: filter, login: model.githubLogin)
            listScroll(isEmpty: visible.isEmpty, emptyNoun: "issues") {
                ForEach(visible) { issue in
                    NavigationLink(value: WorkspaceRoute.githubIssue(issue.number)) {
                        GitHubIssueRowCard(
                            issue: issue,
                            onStartUnassigned: { startUnassigned(for: issue) },
                            onStartWithAgent: { startTarget(for: issue) }
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: shared list chrome

    private func listScroll<Rows: View>(
        isEmpty: Bool, emptyNoun: String, @ViewBuilder rows: () -> Rows
    ) -> some View {
        ScrollView {
            if isEmpty {
                LEmptyState(
                    icon: filter == .mine ? "person.crop.circle.badge.checkmark" : "tray",
                    title: filter == .mine ? "Nothing assigned to you" : "No open \(emptyNoun)",
                    message: filter == .mine
                        ? "Nothing here is assigned to you right now."
                        : "No open \(emptyNoun) in this repository."
                )
                .padding(.top, 48)
            } else {
                LazyVStack(spacing: 0) {
                    rows()
                }
                .padding(.bottom, LSpace.l)
            }
        }
        .background(p.bg)
        .refreshable { await load() }
    }

    private var loadingList: some View {
        ScrollView {
            VStack(spacing: LSpace.s) {
                ForEach(0..<6, id: \.self) { _ in SkeletonBlock(height: 56) }
            }
            .padding(LSpace.l)
        }
    }

    // MARK: empty / error / unavailable states

    private func unavailableState(reason: String?, detail: String?) -> some View {
        ScrollView {
            StateLayout(
                title: "GitHub isn't connected",
                sub: GitHubHubUx.unavailableCopy(reason: reason, detail: detail)
            ) {
                GitHubMark()
                    .frame(width: 34, height: 34)
                    .foregroundStyle(p.muted)
            } actions: {
                EmptyView()
            }
            .padding(.top, 40)
        }
        .refreshable { await load() }
    }

    private func failedState(_ message: String) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                Banner(kind: .danger, text: message)
                LButton("Try again", icon: "arrow.clockwise", kind: .secondary) {
                    Task { await load() }
                }
            }
            .padding(16)
        }
        .refreshable { await load() }
    }

    // MARK: loading + start plumbing

    private func load() async {
        switch kind {
        case .pulls: await model.loadGithubPulls(filter: filter)
        case .issues: await model.loadGithubIssues()
        }
    }

    private func startTarget(for pull: GitHubPullRow) {
        startPickerItem = StartTarget(
            kind: .pulls, number: pull.number, title: pull.title,
            bodyExcerpt: nil, htmlUrl: pull.htmlUrl
        )
    }

    private func startTarget(for issue: GitHubIssueRow) {
        startPickerItem = StartTarget(
            kind: .issues, number: issue.number, title: issue.title,
            bodyExcerpt: issue.bodyExcerpt, htmlUrl: issue.htmlUrl
        )
    }

    /// Bare Start — POST straight through with no assignee, then push the resulting
    /// (or already-tracked) task. The picker path is `startTarget`.
    private func startUnassigned(for pull: GitHubPullRow) {
        Task {
            if let response = await model.startGithubItem(
                kind: .pulls, number: pull.number, title: pull.title,
                bodyExcerpt: nil, htmlUrl: pull.htmlUrl, assigneeAgentId: nil
            ) {
                startedTaskId = response.taskId
            }
        }
    }

    private func startUnassigned(for issue: GitHubIssueRow) {
        Task {
            if let response = await model.startGithubItem(
                kind: .issues, number: issue.number, title: issue.title,
                bodyExcerpt: issue.bodyExcerpt, htmlUrl: issue.htmlUrl, assigneeAgentId: nil
            ) {
                startedTaskId = response.taskId
            }
        }
    }
}

/// The row the Start picker is open for.
private struct StartTarget: Identifiable {
    let kind: GitHubHubKind
    let number: Int
    let title: String
    let bodyExcerpt: String?
    let htmlUrl: String?

    var id: String { "\(kind.startKind)#\(number)" }
}

/// `Hashable` wrapper over `GitHubPullsFilterState` so `.task(id:)` can debounce
/// re-fetches on it directly — a fresh id per edit cancels the previous wait.
private struct PullsFilterQuery: Hashable {
    let author: String
    let involvement: GitHubHubInvolvement
    let q: String

    init(_ state: GitHubPullsFilterState) {
        author = state.author
        involvement = state.involvement
        q = state.q
    }
}

// MARK: - PR filter row

/// The compact filter row under the segment/Open-Mine header: free-text author,
/// mutually-exclusive "Assigned to me"/"My reviews" chips, and a search field.
/// Edits write straight into `model.githubPullsFilter`; the screen's debounced
/// `.task(id:)` picks up the change and re-fetches page 1.
private struct PullsFilterRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    /// The server's off-state detail when the identity lacks a github_login —
    /// disables the involvement chips and explains why via a footnote.
    let detail: String?
    /// Whether a login is known at all, independent of `detail` (a chip can be
    /// tapped before ever hitting the network, so this gates it too).
    let knowsLogin: Bool

    private var involvementDisabled: Bool { knowsLogin == false }

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "person")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(p.faint)
                    .accessibilityHidden(true)
                TextField("", text: $model.githubPullsFilter.author, prompt: Text("Filter by author"))
                    .ltype(.meta)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Filter by author")
            }
            .padding(9)
            .background(p.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(p.border, lineWidth: 1))

            HStack(spacing: 8) {
                involvementChip(.assigned)
                involvementChip(.reviewRequested)
            }
            if involvementDisabled {
                Text(detail ?? "Sign in with GitHub to use \u{201C}Assigned to me\u{201D} and \u{201C}My reviews.\u{201D}")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
            }

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(p.faint)
                    .accessibilityHidden(true)
                TextField("", text: $model.githubPullsFilter.q, prompt: Text("Search title and body"))
                    .ltype(.meta)
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("Search pull requests")
            }
            .padding(9)
            .background(p.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(p.border, lineWidth: 1))
        }
        .padding(.top, 4)
    }

    private func involvementChip(_ value: GitHubHubInvolvement) -> some View {
        LChip(value.chipLabel, selected: model.githubPullsFilter.involvement == value) {
            // Mutually exclusive with itself: tapping the active chip clears it
            // back to `.none` instead of leaving it stuck on.
            model.githubPullsFilter.involvement = model.githubPullsFilter.involvement == value ? .none : value
        }
        .disabled(involvementDisabled)
        .opacity(involvementDisabled ? 0.5 : 1)
    }
}

// MARK: - rows

/// Linear PR row: state glyph (open green / draft grey), mono #number, title, a
/// muted meta line (branch, checks, merge state, reviewers) and trailing time +
/// Start. The row itself navigates to the PR detail.
struct GitHubPullRowCard: View {
    @Environment(\.palette) private var p
    let pull: GitHubPullRow
    /// Bare Start (unassigned) and the agent-picker path.
    let onStartUnassigned: () -> Void
    let onStartWithAgent: () -> Void

    var body: some View {
        GitHubHubRow(
            glyph: "arrow.triangle.pull",
            glyphTint: pull.draft ? p.muted : p.ok,
            stateLabel: pull.draft ? "Draft pull request" : "Open pull request",
            number: pull.number,
            title: pull.title,
            updatedAt: pull.updatedAt,
            onStartUnassigned: onStartUnassigned,
            onStartWithAgent: onStartWithAgent
        ) {
            if pull.draft { LTag("Draft") }
            if !pull.head.isEmpty {
                Text(pull.head)
                    .ltype(.micro)
                    .monospaced()
                    .foregroundStyle(p.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            ChecksChip(checks: pull.checks)
            MergeStateChip(mergeableState: pull.mergeableState)
            if !pull.requestedReviewers.isEmpty {
                HStack(spacing: -6) {
                    ForEach(pull.requestedReviewers.prefix(3), id: \.self) { login in
                        LAvatar(name: login, size: 18)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Reviewers: \(pull.requestedReviewers.joined(separator: ", "))")
            }
        }
    }
}

/// Linear issue row: open glyph, mono #number, title, labels as tags, assignee
/// avatar, trailing time + Start. Navigates to the issue detail.
struct GitHubIssueRowCard: View {
    @Environment(\.palette) private var p
    let issue: GitHubIssueRow
    let onStartUnassigned: () -> Void
    let onStartWithAgent: () -> Void

    var body: some View {
        GitHubHubRow(
            glyph: "smallcircle.filled.circle",
            glyphTint: p.ok,
            stateLabel: "Open issue",
            number: issue.number,
            title: issue.title,
            updatedAt: issue.updatedAt,
            onStartUnassigned: onStartUnassigned,
            onStartWithAgent: onStartWithAgent
        ) {
            if let assignee = issue.assignee {
                LAvatar(name: assignee, size: 18)
                    .accessibilityLabel("Assigned to \(assignee)")
            }
            ForEach(issue.labels.prefix(3), id: \.self) { GitHubLabelChip(label: $0) }
            if issue.labels.count > 3 {
                Text("+\(issue.labels.count - 3)")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
            }
        }
    }
}

/// The shared Linear row anatomy for the hub lists.
private struct GitHubHubRow<Meta: View>: View {
    @Environment(\.palette) private var p
    let glyph: String
    let glyphTint: Color
    let stateLabel: String
    let number: Int
    let title: String
    let updatedAt: String?
    let onStartUnassigned: () -> Void
    let onStartWithAgent: () -> Void
    @ViewBuilder let meta: Meta

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: LSpace.m) {
                Image(systemName: glyph)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(glyphTint)
                    .frame(width: 18, height: 20)
                    .accessibilityLabel(stateLabel)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("#\(number)")
                            .ltype(.mono)
                            .foregroundStyle(p.faint)
                        Text(title)
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) { meta }
                    }
                    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 6) {
                    if let ago = MobileUx.agoLabel(updatedAt) {
                        Text(ago)
                            .ltype(.micro)
                            .foregroundStyle(p.faint)
                            .accessibilityLabel("Updated \(ago)")
                    }
                    StartRowButton(onStartUnassigned: onStartUnassigned, onStartWithAgent: onStartWithAgent)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
            .contentShape(Rectangle())
            LDivider()
                .padding(.leading, LSpace.l + 18 + LSpace.m)
        }
    }
}

/// The per-row Start control: a bare tap starts unassigned; the menu (long-press or
/// the disclosure) offers the agent picker. Both live on one control so a row has a
/// single, discoverable Start affordance (the menu is the long-press equivalent).
private struct StartRowButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    /// Bare Start — an unassigned task, one tap.
    let onStartUnassigned: () -> Void
    /// The agent picker.
    let onStartWithAgent: () -> Void

    var body: some View {
        Menu {
            Button("Start — unassigned", systemImage: "play.fill", action: onStartUnassigned)
            Button("Start with an agent…", systemImage: "person.badge.plus", action: onStartWithAgent)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "play.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("Start")
                    .ltype(.micro)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(p.text2)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(p.border2, lineWidth: 1))
            .contentShape(Rectangle().inset(by: -10))
        } primaryAction: {
            onStartUnassigned()
        }
        .disabled(model.actionInFlight)
        .accessibilityLabel("Start")
        .accessibilityHint("Starts an unassigned task; press and hold to pick an agent")
    }
}
