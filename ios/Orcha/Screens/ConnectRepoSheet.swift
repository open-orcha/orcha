import SwiftUI

/// The Connect-repo sheet — the portal's Connect-repo modal (`home-github.js`)
/// in house sheet form: loading skeletons → the graceful "GitHub isn't connected"
/// off state, or a searchable repo list with the current binding checkmarked and an
/// Unbind row. Picking a row PUTs the binding; the snapshot refresh then updates
/// every surface (Home chip, containers-home card) through the normal machinery.
struct ConnectRepoSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    @State private var phase: RepoConnectPhase = .loading
    @State private var query = ""

    private var boundRepo: String? { model.snapshot?.container.githubRepo }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                content
                    .background(p.bg)
            }
            .navigationTitle("Connect repository")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(p.bg)
        .task { phase = await model.loadGithubRepos() }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .loading:
            loadingState
        case .unavailable:
            offState
        case let .failed(message):
            failedState(message)
        case let .ready(repos):
            repoList(repos)
        }
    }

    // MARK: loading

    private var loadingState: some View {
        ScrollView {
            VStack(spacing: LSpace.s) {
                SkeletonBlock(height: 36)
                SkeletonBlock(height: 168)
            }
            .padding(LSpace.l)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading repositories")
    }

    // MARK: off state — self-hosters without the App land here, on purpose

    private var offState: some View {
        StateLayout(
            title: "GitHub isn't connected on this server",
            sub: "An admin can install the Embodent GitHub App from the portal under Settings › GitHub."
        ) {
            GitHubMark()
                .frame(width: 34, height: 34)
                .foregroundStyle(p.muted)
                .accessibilityHidden(true)
        } actions: {
            EmptyView()
        }
    }

    // MARK: failed — the request itself broke (network / auth), retryable

    private func failedState(_ message: String) -> some View {
        StateLayout(
            title: "Couldn't load repositories",
            sub: message,
            danger: true
        ) {
            GitHubMark()
                .frame(width: 34, height: 34)
                .foregroundStyle(p.danger)
        } actions: {
            LButton("Try again", icon: "arrow.clockwise", kind: .secondary) {
                Task {
                    phase = .loading
                    phase = await model.loadGithubRepos()
                }
            }
        }
    }

    // MARK: the searchable list

    private func repoList(_ repos: [GithubRepoDto]) -> some View {
        let visible = RepoConnect.filter(repos, query: query)
        return ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                Text("Bind this workspace to a repository the Embodent GitHub App is installed on.")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                if repos.isEmpty {
                    LEmptyState(
                        icon: "shippingbox",
                        title: "No repositories yet",
                        message: "The App is installed, but on no repositories yet."
                    )
                } else {
                    LSearchField("Search repositories", text: $query)
                    LSection("Repositories", count: visible.count) {
                        if visible.isEmpty {
                            LCard {
                                Text("No repository matches “\(query)”.")
                                    .ltype(.meta)
                                    .foregroundStyle(p.muted)
                            }
                        } else {
                            LCard(padding: 0) {
                                LazyVStack(spacing: 0) {
                                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, repo in
                                        if index > 0 { LDivider() }
                                        RepoRow(
                                            repo: repo,
                                            bound: repo.fullName == boundRepo,
                                            disabled: model.actionInFlight
                                        ) {
                                            save(repo.fullName)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if let bound = boundRepo {
                    LSection("Connected") {
                        HStack(spacing: LSpace.m) {
                            Text(bound)
                                .ltype(.mono)
                                .foregroundStyle(p.text2)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            LButton("Unbind", icon: "xmark", kind: .danger, size: .small) {
                                save(nil)
                            }
                            .disabled(model.actionInFlight)
                            .accessibilityLabel("Unbind \(bound)")
                        }
                        .padding(LSpace.m)
                        .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous).strokeBorder(p.border, lineWidth: 1))
                    }
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(LSpace.l)
        }
    }

    private func save(_ repo: String?) {
        guard model.actionInFlight == false else { return }
        Task {
            if await model.setGithubRepo(repo) {
                dismiss()
            }
        }
    }
}

/// One repo row: mark + mono owner/name (+ private tag) + description; the
/// current binding gets the accent border and a checkmark (web `.sel` parity).
private struct RepoRow: View {
    @Environment(\.palette) private var p
    let repo: GithubRepoDto
    let bound: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: LSpace.m) {
                GitHubMark()
                    .frame(width: 15, height: 15)
                    .foregroundStyle(p.muted)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(repo.fullName)
                            .ltype(.mono)
                            .foregroundStyle(p.text)
                            .lineLimit(1)
                        if repo.isPrivate {
                            LTag("private", tint: p.warn)
                        }
                    }
                    if let description = repo.description, description.isEmpty == false {
                        Text(description)
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if bound {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(p.accent)
                        .accessibilityHidden(true)
                }
            }
            .padding(LSpace.m)
            .frame(minHeight: 52)
            .background(bound ? p.lSelected : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.lRow)
        .disabled(disabled)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint(bound ? "Currently connected" : "Connects this workspace to the repository")
    }

    private var accessibilityText: String {
        var parts = [repo.fullName]
        if repo.isPrivate { parts.append("private") }
        if bound { parts.append("currently connected") }
        return parts.joined(separator: ", ")
    }
}
