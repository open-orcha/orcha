import Foundation

/// GitHub hub API surface (cloud PRs #94 + #95) — the phone parity of the portal's
/// GitHub hub. Reads ride the same `available:false` clean-error contract as the
/// repo-connect endpoints (every failure is a 200 with `available:false`, never a
/// 5xx), so these `get`s only throw on transport / auth-perimeter / non-2xx.
///
/// `startGithubItem` is the one write: it creates (or returns the already-tracked)
/// Orcha task for an issue/PR, optionally assigned to an AI agent.
extension OrchaApiClient {

    // MARK: reads (graceful off-state rides a 200)

    func githubIssues(_ base: String, _ cid: String) async throws -> GitHubIssuesResponse {
        try await get(base, "/api/containers/\(cid)/github/issues")
    }

    /// `author`/`involvement`/`q`/`page`/`perPage` are the frozen contract's
    /// server-side filter/pagination params, all optional — omitting all of them is
    /// exactly the pre-existing unfiltered call (a nil-only `query` builds `""`), so
    /// an older server that ignores unknown query params behaves identically either
    /// way. `involvement` takes the raw wire value (`"assigned"` | `"review_requested"`);
    /// build it from `GitHubHubInvolvement.queryValue` at the call site.
    func githubPulls(
        _ base: String, _ cid: String,
        author: String? = nil, involvement: String? = nil, q: String? = nil,
        page: Int? = nil, perPage: Int? = nil
    ) async throws -> GitHubPullsResponse {
        try await get(base, "/api/containers/\(cid)/github/pulls" + query([
            "author": author,
            "involvement": involvement,
            "q": q,
            "page": page.map(String.init),
            "per_page": perPage.map(String.init),
        ]))
    }

    /// `GET …/github/checks?numbers=` — the list's checks progressive fill (see
    /// `GitHubChecksBatchResponse`). Callers split through `GitHubHubUx.checksBatches`:
    /// the server caps one call at 30 numbers.
    func githubChecks(_ base: String, _ cid: String, numbers: [Int]) async throws -> GitHubChecksBatchResponse {
        try await get(base, "/api/containers/\(cid)/github/checks" + query([
            "numbers": numbers.map(String.init).joined(separator: ","),
        ]))
    }

    func githubIssueDetail(_ base: String, _ cid: String, _ number: Int) async throws -> GitHubIssueDetailResponse {
        try await get(base, "/api/containers/\(cid)/github/issues/\(number)")
    }

    func githubPullDetail(_ base: String, _ cid: String, _ number: Int) async throws -> GitHubPullDetailResponse {
        try await get(base, "/api/containers/\(cid)/github/pulls/\(number)")
    }

    // MARK: write

    /// `POST …/github/start` — create (or return the already-tracked) task for a
    /// GitHub item. `assigneeAgentId` (a live AI agent) → assigned + wake; nil → an
    /// unassigned `ready` task. The enrichment fields (`title`/`bodyExcerpt`/`htmlUrl`)
    /// let the server title/describe the task without a second GitHub fetch; nil ones
    /// are dropped by `send`, so an older server ignores what it doesn't read.
    /// `createdByAgentId` is the acting human (the task's creator), per the grant model.
    func startGithubItem(
        _ base: String, _ cid: String,
        kind: String, number: Int,
        title: String? = nil, bodyExcerpt: String? = nil, htmlUrl: String? = nil,
        assigneeAgentId: String? = nil, createdByAgentId: String? = nil
    ) async throws -> GitHubStartResponse {
        try await postDecoding(base, "/api/containers/\(cid)/github/start", Self.startBody(
            kind: kind, number: number,
            title: title, bodyExcerpt: bodyExcerpt, htmlUrl: htmlUrl,
            assigneeAgentId: assigneeAgentId, createdByAgentId: createdByAgentId
        ))
    }

    /// The `POST …/github/start` request body. Nil optionals are carried as nil and
    /// dropped by the JSON layer (`send`'s `compactMapValues`), so an older server
    /// never sees a key it doesn't read. Extracted for testing the exact wire shape.
    static func startBody(
        kind: String, number: Int,
        title: String?, bodyExcerpt: String?, htmlUrl: String?,
        assigneeAgentId: String?, createdByAgentId: String?
    ) -> [String: Any?] {
        [
            "kind": kind,
            "number": number,
            "title": title,
            "body_excerpt": bodyExcerpt,
            "html_url": htmlUrl,
            "assignee_agent_id": assigneeAgentId,
            "created_by_agent_id": createdByAgentId,
        ]
    }
}
