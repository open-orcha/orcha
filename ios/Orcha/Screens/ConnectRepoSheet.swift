import SwiftUI

/// The Connect-repo sheet — the portal's Connect-repo modal (`home-github.js`)
/// in house sheet form: loading skeletons → the graceful "App isn't wired" off
/// state, or a searchable repo list with the current binding checkmarked and an
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
            }
            .navigationTitle("Connect a GitHub repo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { phase = await model.loadGithubRepos() }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .loading:
            loadingState
        case let .unavailable(detail):
            offState(detail)
        case let .failed(message):
            failedState(message)
        case let .ready(repos):
            repoList(repos)
        }
    }

    // MARK: loading

    private var loadingState: some View {
        ScrollView {
            VStack(spacing: 10) {
                SkeletonBlock(height: 64)
                SkeletonBlock(height: 64)
                SkeletonBlock(height: 64)
            }
            .padding(16)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading repositories")
    }

    // MARK: off state — self-hosters without the App land here, on purpose

    private func offState(_ detail: String?) -> some View {
        StateLayout(
            title: "The GitHub App isn't wired on the server yet",
            sub: "No installation token was found, so this Orcha can't list repositories. Self-hosting without the App is fully supported — everything else keeps working; repo-connect simply stays off."
        ) {
            GitHubMark()
                .frame(width: 34, height: 34)
                .foregroundStyle(p.muted)
        } actions: {
            if let detail, detail.isEmpty == false {
                Text(detail)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(p.faint)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 290)
            }
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
            KitButton(title: "Try again", role: .neutral) {
                Task {
                    phase = .loading
                    phase = await model.loadGithubRepos()
                }
            }
            .frame(maxWidth: 220)
        }
    }

    // MARK: the searchable list

    private func repoList(_ repos: [GithubRepoDto]) -> some View {
        let visible = RepoConnect.filter(repos, query: query)
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Bind this workspace to a repository the Orcha GitHub App is installed on.")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
                if repos.isEmpty {
                    OrchaCard {
                        Text("The App is installed, but on no repositories yet.")
                            .font(p.uiFont(13))
                            .foregroundStyle(p.muted)
                    }
                } else {
                    searchField
                    SectionH(title: "Repositories", count: "\(visible.count)")
                    if visible.isEmpty {
                        OrchaCard {
                            Text("No repository matches “\(query)”.")
                                .font(p.uiFont(13))
                                .foregroundStyle(p.muted)
                        }
                    }
                    ForEach(visible) { repo in
                        RepoRow(
                            repo: repo,
                            bound: repo.fullName == boundRepo,
                            disabled: model.actionInFlight
                        ) {
                            save(repo.fullName)
                        }
                    }
                }
                if let bound = boundRepo {
                    KitButton(
                        title: "Unbind \(bound)",
                        role: .dangerTonal,
                        small: true,
                        enabled: model.actionInFlight == false
                    ) {
                        save(nil)
                    }
                    .padding(.top, 4)
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(16)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(p.faint)
                .accessibilityHidden(true)
            TextField("", text: $query, prompt: Text("Search repositories"))
                .font(p.uiFont(14))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Search repositories")
        }
        .padding(11)
        .background(p.surface2, in: RoundedRectangle(cornerRadius: p.radiusCard))
        .overlay(RoundedRectangle(cornerRadius: p.radiusCard).strokeBorder(p.border2, lineWidth: 1))
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
            OrchaCard(
                borderColor: bound ? p.accentLine : nil,
                container: bound ? p.accentSoft : nil
            ) {
                HStack(alignment: .top, spacing: 10) {
                    GitHubMark()
                        .frame(width: 15, height: 15)
                        .foregroundStyle(p.muted)
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(repo.fullName)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(p.text)
                                .lineLimit(1)
                            if repo.isPrivate {
                                MetaTag(text: "private", tint: p.warn)
                            }
                        }
                        if let description = repo.description, description.isEmpty == false {
                            Text(description)
                                .font(p.uiFont(12.5))
                                .foregroundStyle(p.muted)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if bound {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(p.accent)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .buttonStyle(.plain)
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
