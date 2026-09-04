import Foundation

/// GitHub hub — the view-owned load/start surface on AppModel (the `AppModel+*`
/// per-feature extension pattern). Reads land in per-surface phase state (the same
/// `.loading / .unavailable / .loaded / .failed` machine `membersState` and
/// `RepoConnectPhase` use); `available:false` or a 404 on an older server both
/// resolve to `.unavailable` — never the app-wide error banner. Start rides the
/// shared `humanAction` guard and returns the task so the view can navigate.

/// The hub's list/checks fetch surface. `OrchaApiClient` is the production witness;
/// tests inject a gated fake via `AppModel.githubFetchOverride` so the delayed
/// cross-project / out-of-order races are driven through the REAL load paths
/// (PR #223 review round 3).
protocol GitHubHubFetching {
    func githubIssues(_ base: String, _ cid: String) async throws -> GitHubIssuesResponse
    func githubPulls(
        _ base: String, _ cid: String,
        author: String?, involvement: String?, q: String?,
        page: Int?, perPage: Int?
    ) async throws -> GitHubPullsResponse
    func githubChecks(_ base: String, _ cid: String, numbers: [Int]) async throws -> GitHubChecksBatchResponse
}

extension OrchaApiClient: GitHubHubFetching {}

extension AppModel {

    /// The fetch surface the loaders use — the injected test fake, or the real client.
    private var githubFetcher: any GitHubHubFetching { githubFetchOverride ?? api }

    /// True while a completion still belongs to the CURRENT pulls load of the
    /// still-selected workspace (PR #223 round 3) — stale completions return here.
    private func isCurrentGithubPullsLoad(_ generation: Int, from containerId: String) -> Bool {
        generation == githubPullsLoadGeneration && selectedContainer?.id == containerId
    }

    private func isCurrentGithubIssuesLoad(_ generation: Int, from containerId: String) -> Bool {
        generation == githubIssuesLoadGeneration && selectedContainer?.id == containerId
    }

    /// The container's currently-bound repo ("owner/name"), or nil — drives the
    /// hub entry point's visibility (no repo ⇒ the friendly connect state).
    var githubRepo: String? {
        snapshot?.container.githubRepo
    }

    /// The signed-in GitHub login used for the "Mine" filter, or nil (self-host /
    /// unmapped) — in which case "Mine" falls back to the full list.
    var githubLogin: String? {
        identity?.githubLogin
    }

    /// Live AI agents in this container — the Start assignee picker's roster
    /// (ReviewerPickerSheet lists humans; the hub assigns work to AI agents).
    var githubAssignableAgents: [AgentDto] {
        MobileUx.orderAgents((snapshot?.agents ?? []).filter { $0.kind == "ai" && $0.terminatedAt == nil })
    }

    // MARK: list loads (the graceful off state lives in the phase, not the banner)

    /// Load open issues into `githubIssuesPhase`. A decode of the hub's own
    /// `available:false` 200 becomes `.unavailable`; a transport / non-2xx / 404
    /// (older server without the surface) becomes `.unavailable` too — never `.failed`
    /// for the degrade-gracefully contract. Genuine transport failures land in `.failed`.
    func loadGithubIssues() async {
        guard let sel = selectedContainer else {
            githubIssuesPhase = .failed("No workspace is open — close this and try again.")
            return
        }
        githubIssuesLoadGeneration &+= 1
        let gen = githubIssuesLoadGeneration
        githubIssuesPhase = .loading
        do {
            let response = try await githubFetcher.githubIssues(sel.baseUrl, sel.id)
            guard isCurrentGithubIssuesLoad(gen, from: sel.id) else { return }
            githubIssuesPhase = GitHubHubUx.phase(from: response)
        } catch let error as OrchaApiError where error.status == 404 {
            // Older self-host server without the hub surface — degrade, don't error.
            guard isCurrentGithubIssuesLoad(gen, from: sel.id) else { return }
            githubIssuesPhase = .unavailable(reason: "repo_not_connected", detail: nil)
        } catch {
            guard isCurrentGithubIssuesLoad(gen, from: sel.id) else { return }
            githubIssuesPhase = .failed(friendly(error))
        }
    }

    /// Load open PRs into `githubPullsPhase`, applying the Open|Mine control plus
    /// `githubPullsFilter` (author/involvement/q) as server-side params. Same
    /// graceful-off contract as issues. Always fetches page 1 — call this whenever
    /// the filter/Open-Mine state changes, not `loadMoreGithubPulls`.
    func loadGithubPulls(filter: GitHubHubFilter = .open) async {
        guard let sel = selectedContainer else {
            githubPullsPhase = .failed("No workspace is open — close this and try again.")
            return
        }
        githubPullsLoadGeneration &+= 1
        let gen = githubPullsLoadGeneration
        githubPullsFilter = githubPullsFilter.resetToFirstPage()
        githubPullsPhase = .loading
        do {
            let response = try await fetchGithubPulls(sel, filter: filter, page: 1)
            guard isCurrentGithubPullsLoad(gen, from: sel.id) else { return }
            githubInvolvementUnavailableDetail = GitHubHubUx.involvementUnavailableDetail(response)
            githubPullsPhase = GitHubHubUx.phase(from: response)
            fillGithubChecks(for: response.pulls, containerId: sel.id, generation: gen)
        } catch let error as OrchaApiError where error.status == 404 {
            guard isCurrentGithubPullsLoad(gen, from: sel.id) else { return }
            githubPullsPhase = .unavailable(reason: "repo_not_connected", detail: nil)
        } catch {
            guard isCurrentGithubPullsLoad(gen, from: sel.id) else { return }
            githubPullsPhase = .failed(friendly(error))
        }
    }

    /// Fetch the next page and append it onto the rows already on screen. A no-op
    /// unless the phase is currently `.loaded` with `hasMore` — there is no page to
    /// load more of from `.idle`/`.loading`/`.unavailable`/`.failed`, and calling
    /// this mid-flight (already `.loadingMore`) would race two in-flight fetches.
    func loadMoreGithubPulls(filter: GitHubHubFilter = .open) async {
        guard let sel = selectedContainer,
              case let .loaded(repo, pulls, page) = githubPullsPhase,
              page.hasMore
        else { return }
        let nextPage = page.page + 1
        // NOT bumped: a load-more belongs to the current primary load's generation, so
        // a NEW primary load (filter change / project switch) invalidates this page.
        let gen = githubPullsLoadGeneration
        githubPullsPhase = .loadingMore(repo: repo, pulls: pulls, page: page)
        do {
            let response = try await fetchGithubPulls(sel, filter: filter, page: nextPage)
            guard isCurrentGithubPullsLoad(gen, from: sel.id) else { return }
            githubInvolvementUnavailableDetail = GitHubHubUx.involvementUnavailableDetail(response)
            let (merged, info) = GitHubHubUx.accumulate(existing: pulls, incoming: response)
            githubPullsFilter.page = info.page
            githubPullsPhase = response.available
                ? .loaded(repo: response.repo ?? repo, pulls: merged, page: info)
                : .unavailable(reason: response.reason, detail: response.detail)
            fillGithubChecks(for: response.pulls, containerId: sel.id, generation: gen)
        } catch let error as OrchaApiError where error.status == 404 {
            // Restore the page the user was already looking at rather than
            // dropping it behind a friendly-off screen for a load-more hiccup.
            guard isCurrentGithubPullsLoad(gen, from: sel.id) else { return }
            githubPullsPhase = .loaded(repo: repo, pulls: pulls, page: page)
        } catch {
            guard isCurrentGithubPullsLoad(gen, from: sel.id) else { return }
            githubPullsPhase = .loaded(repo: repo, pulls: pulls, page: page)
            self.error = friendly(error) // surfaces via the app-wide error banner, list stays put
        }
    }

    /// Progressive fill of the list's checks chips. The PR list ships `checks: null`
    /// on every row (the server's lazy split — one GitHub call per PR is too slow
    /// inline; the portal fills the same way), so once a page lands, batch its PR
    /// numbers through `…/github/checks` and merge the rollups into whatever phase is
    /// current. Fire-and-forget: a failed batch (or an older server's 404) just leaves
    /// those chips hidden, exactly as before this fill existed.
    func fillGithubChecks(for pulls: [GitHubPullRow], containerId: String, generation: Int) {
        guard let sel = selectedContainer, sel.id == containerId else { return }
        let numbers = pulls.map(\.number)
        guard !numbers.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            for batch in GitHubHubUx.checksBatches(numbers) {
                guard let response = try? await self.githubFetcher.githubChecks(sel.baseUrl, sel.id, numbers: batch),
                      response.available, !response.checks.isEmpty
                else { continue }
                self.applyGithubChecks(response.checks, from: containerId, generation: generation)
            }
        }
    }

    /// Merge a checks batch into the current phase — but ONLY while the load that
    /// requested it is still the CURRENT pulls load (generation) of the still-selected
    /// workspace. PR #223 rounds 2+3: rows are matched by PR number alone, so a delayed
    /// batch from a previous project OR an out-of-order same-project reload must never
    /// land on the newer list. Internal (not private) so the regression tests can
    /// drive it directly.
    func applyGithubChecks(_ checks: [String: GitHubChecks], from containerId: String, generation: Int) {
        guard generation == githubPullsLoadGeneration, selectedContainer?.id == containerId else { return }
        switch githubPullsPhase {
        case let .loaded(repo, pulls, page):
            githubPullsPhase = .loaded(repo: repo, pulls: GitHubHubUx.mergeChecks(pulls, checks), page: page)
        case let .loadingMore(repo, pulls, page):
            githubPullsPhase = .loadingMore(repo: repo, pulls: GitHubHubUx.mergeChecks(pulls, checks), page: page)
        default:
            break
        }
    }

    /// Shared param-building + network call for both the first page and load-more.
    private func fetchGithubPulls(
        _ sel: StoredContainer, filter: GitHubHubFilter, page: Int
    ) async throws -> GitHubPullsResponse {
        let params = GitHubHubUx.pullsQueryParams(filter: filter, state: githubPullsFilter, login: githubLogin)
        return try await githubFetcher.githubPulls(
            sel.baseUrl, sel.id,
            author: params.author,
            involvement: params.involvement,
            q: params.q,
            page: page,
            perPage: 30
        )
    }

    // MARK: detail loads (owned by the detail screens, phase returned)

    func loadGithubPullDetail(_ number: Int) async -> GitHubPullDetailPhase {
        guard let sel = selectedContainer else {
            return .failed("No workspace is open — close this and try again.")
        }
        do {
            return GitHubHubUx.phase(from: try await api.githubPullDetail(sel.baseUrl, sel.id, number))
        } catch let error as OrchaApiError where error.status == 404 {
            return .unavailable(reason: "not_found", detail: nil)
        } catch {
            return .failed(friendly(error))
        }
    }

    func loadGithubIssueDetail(_ number: Int) async -> GitHubIssueDetailPhase {
        guard let sel = selectedContainer else {
            return .failed("No workspace is open — close this and try again.")
        }
        do {
            return GitHubHubUx.phase(from: try await api.githubIssueDetail(sel.baseUrl, sel.id, number))
        } catch let error as OrchaApiError where error.status == 404 {
            return .unavailable(reason: "not_found", detail: nil)
        } catch {
            return .failed(friendly(error))
        }
    }

    // MARK: start

    /// `POST …/github/start` — create (or return the already-tracked) task for a GitHub
    /// item. Rides `humanAction` (retry-guard + toast + friendly error). Returns the
    /// server response so the caller can navigate to the task and distinguish a fresh
    /// start from an idempotent `existing:true` re-tap. The acting human is the task's
    /// creator (the grant model mirrors task creation exactly).
    func startGithubItem(
        kind: GitHubHubKind, number: Int,
        title: String?, bodyExcerpt: String?, htmlUrl: String?,
        assigneeAgentId: String?
    ) async -> GitHubStartResponse? {
        guard let sel = selectedContainer else { return nil }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return nil
        }
        let assigneeName = assigneeAgentId.flatMap { id in
            githubAssignableAgents.first { $0.id == id }?.alias
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let response = try await api.startGithubItem(
                sel.baseUrl, sel.id,
                kind: kind.startKind, number: number,
                title: title, bodyExcerpt: bodyExcerpt, htmlUrl: htmlUrl,
                assigneeAgentId: assigneeAgentId, createdByAgentId: actor
            )
            // `existing:true` — an OPEN `GH #N:` task already tracked this item; no
            // duplicate was created. Reflect that honestly instead of "Started".
            toast = response.existing
                ? "Already tracked — opening the existing task"
                : assigneeName.map { "Started · assigned to \($0)" } ?? "Started — parked as a task"
            await refresh()
            return response
        } catch {
            self.error = friendly(error)
            return nil
        }
    }
}
