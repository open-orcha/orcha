import SwiftUI

/// Issue detail — title + state, labels + assignees, the body (ChatMarkdownView),
/// the recent comment thread (oldest-first), and an open-on-GitHub link.
/// Start-from-detail lives in the toolbar. Same locally-owned phase + graceful-off
/// contract as the PR detail.
struct GitHubIssueDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let number: Int

    @State private var phase: GitHubIssueDetailPhase = .loading
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
            case let .loaded(_, issue):
                loaded(issue)
            }
        }
        .navigationTitle("Issue #\(number)")
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
            if case let .loaded(_, issue) = phase {
                GitHubStartPickerSheet(
                    kind: .issues, number: issue.number, title: issue.title,
                    bodyExcerpt: String(issue.bodyMarkdown.prefix(200)), htmlUrl: issue.htmlUrl
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
        phase = await model.loadGithubIssueDetail(number)
    }

    private var loadingState: some View {
        ScrollView {
            VStack(spacing: LSpace.m) {
                SkeletonBlock(height: 72)
                SkeletonBlock(height: 160)
            }
            .padding(LSpace.l)
        }
    }

    private func loaded(_ issue: GitHubIssueDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.xl) {
                header(issue)
                GitHubTrackedCard(startedTaskId: startedTask, disabled: model.actionInFlight) {
                    showStartPicker = true
                }
                if !issue.bodyMarkdown.isEmpty {
                    section("Description") {
                        ChatMarkdownView(text: issue.bodyMarkdown)
                    }
                }
                commentsSection(issue)
                if let url = issue.htmlUrl.flatMap(URL.init(string:)) {
                    OpenOnGitHubLink(url: url)
                }
            }
            .padding(LSpace.l)
        }
        .background(p.bg)
        .refreshable { await load() }
    }

    private func header(_ issue: GitHubIssueDetail) -> some View {
        GitHubDetailHeader(state: .issue(state: issue.state), number: issue.number, title: issue.title) {
            if let author = issue.authorLogin {
                GitHubPersonMeta(login: author)
            }
            ForEach(issue.labels, id: \.self) { GitHubLabelChip(label: $0) }
            if !issue.assignees.isEmpty {
                LTag("Assigned: \(issue.assignees.joined(separator: ", "))")
            }
            if let ago = MobileUx.agoLabel(issue.updatedAt) {
                Text("Updated \(ago)").ltype(.micro).foregroundStyle(p.faint)
            }
        }
    }

    @ViewBuilder
    private func commentsSection(_ issue: GitHubIssueDetail) -> some View {
        section("Comments", count: issue.commentsCount) {
            if issue.comments.isEmpty {
                Text(issue.commentsCount > 0
                     ? "The comment thread couldn't be loaded."
                     : "No comments yet.")
                    .ltype(.meta).foregroundStyle(p.muted)
            } else {
                VStack(alignment: .leading, spacing: LSpace.l) {
                    if issue.commentsCount > issue.comments.count {
                        Text("Showing the most recent \(issue.comments.count) of \(issue.commentsCount) comments.")
                            .ltype(.micro).foregroundStyle(p.faint)
                    }
                    ForEach(issue.comments) { comment in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: LSpace.s) {
                                LAvatar(name: comment.authorLogin ?? "?", size: 22)
                                Text(comment.authorLogin ?? "someone")
                                    .ltype(.meta)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(p.text)
                                Text(MobileUx.agoLabel(comment.createdAt) ?? "")
                                    .ltype(.micro)
                                    .foregroundStyle(p.faint)
                                Spacer()
                            }
                            .accessibilityElement(children: .combine)
                            ChatMarkdownView(text: comment.bodyMarkdown)
                        }
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
