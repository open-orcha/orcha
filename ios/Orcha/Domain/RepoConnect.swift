import Foundation

/// The Connect-repo sheet's binding-state machine — a pure mapping from the
/// `/api/github/repos` response (or its failure) to what the sheet renders.
/// Mirrors the portal's `home-github.js` states: loading → off / list / error.
enum RepoConnectPhase: Equatable {
    case loading
    /// `available:false` — the GitHub App isn't wired on the server. A friendly,
    /// deliberate off state (self-hosting without the App is fully supported).
    case unavailable(detail: String?)
    /// `available:true` — the searchable repo list (possibly empty: App installed
    /// on no repositories yet).
    case ready([GithubRepoDto])
    /// The request itself failed (network, auth perimeter, non-2xx).
    case failed(String)
}

/// Pure selectors for the Connect-repo sheet — kept out of the view for testing.
enum RepoConnect {

    /// A successfully decoded response is either the list or the graceful off state.
    static func phase(from response: GithubReposResponse) -> RepoConnectPhase {
        response.available ? .ready(response.repos) : .unavailable(detail: response.detail)
    }

    /// Case-insensitive search over "owner/name" and the description; a blank
    /// query keeps the full list (the sheet's search field starts empty).
    static func filter(_ repos: [GithubRepoDto], query: String) -> [GithubRepoDto] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard q.isEmpty == false else { return repos }
        return repos.filter { repo in
            repo.fullName.lowercased().contains(q)
                || (repo.description?.lowercased().contains(q) ?? false)
        }
    }
}
