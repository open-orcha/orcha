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
            VStack(spacing: 12) {
                SkeletonBlock(height: 60)
                SkeletonBlock(height: 160)
            }
            .padding(16)
        }
    }

    private func loaded(_ issue: GitHubIssueDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(issue)
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
            .padding(16)
        }
        .refreshable { await load() }
    }

    private func header(_ issue: GitHubIssueDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(issue.title)
                .font(p.uiFont(19, .bold))
                .foregroundStyle(p.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                StatusPill(status: issue.state, domain: .task)
            }
            if !issue.labels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(issue.labels, id: \.self) { GitHubLabelChip(label: $0) }
                    }
                }
            }
            HStack(spacing: 6) {
                if let author = issue.authorLogin {
                    AgentAvatar(alias: author, human: true, githubLogin: author, size: 22)
                    Text(author).font(p.uiFont(12)).foregroundStyle(p.text2)
                }
                if !issue.assignees.isEmpty {
                    MetaTag(text: "assigned: \(issue.assignees.joined(separator: ", "))")
                }
                Spacer()
                Text(MobileUx.agoLabel(issue.updatedAt).map { "updated \($0)" } ?? "")
                    .font(p.uiFont(11)).foregroundStyle(p.faint)
            }
        }
    }

    @ViewBuilder
    private func commentsSection(_ issue: GitHubIssueDetail) -> some View {
        section("Comments · \(issue.commentsCount)") {
            if issue.comments.isEmpty {
                Text(issue.commentsCount > 0
                     ? "The comment thread couldn't be loaded."
                     : "No comments yet.")
                    .font(p.uiFont(13)).foregroundStyle(p.muted)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if issue.commentsCount > issue.comments.count {
                        Text("Showing the most recent \(issue.comments.count) of \(issue.commentsCount) comments.")
                            .font(p.uiFont(11)).foregroundStyle(p.faint)
                    }
                    ForEach(issue.comments) { comment in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                AgentAvatar(
                                    alias: comment.authorLogin ?? "?",
                                    human: true, githubLogin: comment.authorLogin, size: 22
                                )
                                Text(comment.authorLogin ?? "someone")
                                    .font(p.uiFont(13, .semibold))
                                    .foregroundStyle(p.text)
                                Spacer()
                                Text(MobileUx.agoLabel(comment.createdAt) ?? "")
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(p.faint)
                            }
                            ChatMarkdownView(text: comment.bodyMarkdown)
                        }
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
