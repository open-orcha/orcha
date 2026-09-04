import Foundation

/// The GitHub hub's binding-state machine + pure selectors — kept out of the views
/// for testing, mirroring `RepoConnect`. A response (or its failure) maps straight
/// to what the list renders: loading → off / list / error.

/// Which segment the list is showing.
enum GitHubHubKind: String, CaseIterable, Equatable {
    case issues
    case pulls

    var title: String {
        switch self {
        case .issues: "Issues"
        case .pulls: "Pull requests"
        }
    }

    /// The `POST /start` `kind` value (contract: "issue" | "pull").
    var startKind: String {
        switch self {
        case .issues: "issue"
        case .pulls: "pull"
        }
    }
}

/// Open / Mine filter over a list. "Mine" = assigned to (issues) or review-requested
/// from (PRs) the signed-in GitHub login; with no known login it falls back to Open.
enum GitHubHubFilter: String, CaseIterable, Equatable {
    case open
    case mine

    var label: String {
        switch self {
        case .open: "Open"
        case .mine: "Mine"
        }
    }
}

/// The PR list's server-side involvement filter — mutually exclusive with itself
/// (only one can be active) and orthogonal to `author`/`q`. Maps 1:1 to the
/// frozen contract's `involvement=assigned|review_requested` query param.
enum GitHubHubInvolvement: String, CaseIterable, Equatable {
    case none
    case assigned
    case reviewRequested

    /// The wire value for `involvement=`, or nil for `.none` (param omitted).
    var queryValue: String? {
        switch self {
        case .none: nil
        case .assigned: "assigned"
        case .reviewRequested: "review_requested"
        }
    }

    var chipLabel: String {
        switch self {
        case .none: ""
        case .assigned: "Assigned to me"
        case .reviewRequested: "My reviews"
        }
    }
}

/// The PR list's compact filter row state — pure value type, so the query-building
/// and pagination logic below is fully unit-testable without SwiftUI. `author` and
/// `q` are free text; `involvement` is mutually exclusive with itself (setting one
/// value replaces any other — there is no "assigned AND review_requested").
struct GitHubPullsFilterState: Equatable {
    var author: String = ""
    var involvement: GitHubHubInvolvement = .none
    var q: String = ""
    /// 1-based; bumped by "load more", reset to 1 by any filter change.
    var page: Int = 1

    /// Trims free text and treats blank as absent — the query never sends `author=`
    /// or `q=` for whitespace-only input.
    var trimmedAuthor: String? {
        let value = author.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    var trimmedQuery: String? {
        let value = q.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    /// Whether any filter beyond the bare "Open" list is active — drives whether
    /// the list is showing a filtered subset (vs. the plain open-PRs list).
    var isFiltering: Bool {
        trimmedAuthor != nil || involvement != .none || trimmedQuery != nil
    }

    /// A copy reset to page 1 — every filter-field edit calls this so a stale
    /// deeper page never mixes with a freshly-typed filter.
    func resetToFirstPage() -> Self {
        var copy = self
        copy.page = 1
        return copy
    }
}

/// The list's loading → available:false → loaded machine for issues.
enum GitHubIssuesPhase: Equatable {
    case idle
    case loading
    /// `available:false` (unbound / rate-limited / GitHub error) OR the endpoint
    /// 404'd on an older server — the friendly "connect a repo" off state.
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, issues: [GitHubIssueRow])
    /// The request itself failed (network / auth perimeter / non-2xx that isn't the
    /// hub's own 200-off contract).
    case failed(String)
}

/// The PR list's machine (same shape, distinct payload), plus the pagination
/// metadata a `.loaded` page carries: `page`/`totalCount`/`hasMore` mirror the
/// frozen contract's response fields exactly, so the load-more footer and the
/// "N of ~total" caption read straight off the phase with no extra plumbing.
enum GitHubPullsPhase: Equatable {
    case idle
    case loading
    /// Set only by a load-more fetch (page > 1) — the list keeps showing the
    /// already-loaded rows underneath while the next page is in flight.
    case loadingMore(repo: String?, pulls: [GitHubPullRow], page: Info)
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, pulls: [GitHubPullRow], page: Info = Info())
    case failed(String)

    /// Pagination metadata for a loaded page — bundled so `.loaded` keeps a
    /// stable arity as fields are added, and so tests can construct it directly.
    struct Info: Equatable {
        var page = 1
        var perPage = 30
        var totalCount: Int?
        var hasMore = false
    }
}

/// Detail machines (PR / issue), same graceful-off contract.
enum GitHubPullDetailPhase: Equatable {
    case loading
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, pull: GitHubPullDetail)
    case failed(String)
}

enum GitHubIssueDetailPhase: Equatable {
    case loading
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, issue: GitHubIssueDetail)
    case failed(String)
}

/// Pure selectors for the GitHub hub — response→phase mapping, Open/Mine filtering,
/// and the checks-chip summary. No SwiftUI here so it's all unit-testable.
enum GitHubHubUx {

    // MARK: response → phase

    static func phase(from response: GitHubIssuesResponse) -> GitHubIssuesPhase {
        response.available
            ? .loaded(repo: response.repo, issues: response.issues)
            : .unavailable(reason: response.reason, detail: response.detail)
    }

    static func phase(from response: GitHubPullsResponse) -> GitHubPullsPhase {
        response.available
            ? .loaded(repo: response.repo, pulls: response.pulls, page: pageInfo(from: response))
            : .unavailable(reason: response.reason, detail: response.detail)
    }

    /// Bundle a response's pagination fields into `GitHubPullsPhase.Info`.
    static func pageInfo(from response: GitHubPullsResponse) -> GitHubPullsPhase.Info {
        GitHubPullsPhase.Info(
            page: response.page, perPage: response.perPage,
            totalCount: response.totalCount, hasMore: response.hasMore
        )
    }

    /// Page-1 replaces; page>1 appends onto the rows already showing, de-duplicating
    /// by PR number (a re-requested page — e.g. a retry after a transient failure —
    /// must not double a row already on screen). The incoming page's own metadata
    /// (`hasMore`/`totalCount`/`page`) always wins, since it's the freshest read of
    /// the server's cursor.
    static func accumulate(
        existing: [GitHubPullRow], incoming: GitHubPullsResponse
    ) -> (pulls: [GitHubPullRow], page: GitHubPullsPhase.Info) {
        let info = pageInfo(from: incoming)
        guard incoming.page > 1 else { return (incoming.pulls, info) }
        var seen = Set(existing.map(\.number))
        var merged = existing
        for pull in incoming.pulls where seen.insert(pull.number).inserted {
            merged.append(pull)
        }
        return (merged, info)
    }

    // MARK: checks progressive fill

    /// The server caps one `…/github/checks` call at this many PR numbers
    /// (`github_hub_routes.CHECKS_BATCH_MAX_NUMBERS`); a longer request is a 400.
    static let checksBatchMax = 30

    /// Split a page's PR numbers into server-sized batches, order preserved.
    static func checksBatches(_ numbers: [Int], max: Int = checksBatchMax) -> [[Int]] {
        guard max > 0, !numbers.isEmpty else { return [] }
        return stride(from: 0, to: numbers.count, by: max).map { start in
            Array(numbers[start..<min(start + max, numbers.count)])
        }
    }

    /// Fill list rows' checks from one batch response. Rows are matched by PR number
    /// (the batch is keyed by the number as a string); a row the batch didn't answer
    /// for keeps what it had, so a filter change mid-flight can't misattribute a rollup.
    static func mergeChecks(_ pulls: [GitHubPullRow], _ checks: [String: GitHubChecks]) -> [GitHubPullRow] {
        guard !checks.isEmpty else { return pulls }
        return pulls.map { row in
            guard let rollup = checks[String(row.number)] else { return row }
            var filled = row
            filled.checks = rollup
            return filled
        }
    }

    static func phase(from response: GitHubPullDetailResponse) -> GitHubPullDetailPhase {
        if response.available, let pull = response.pull {
            return .loaded(repo: response.repo, pull: pull)
        }
        return .unavailable(reason: response.reason, detail: response.detail)
    }

    static func phase(from response: GitHubIssueDetailResponse) -> GitHubIssueDetailPhase {
        if response.available, let issue = response.issue {
            return .loaded(repo: response.repo, issue: issue)
        }
        return .unavailable(reason: response.reason, detail: response.detail)
    }

    // MARK: Open / Mine filtering

    /// Issues assigned to `login` (matched against the primary assignee). A blank
    /// login yields the full list — "Mine" can't be answered, so it shows everything.
    static func filterIssues(_ issues: [GitHubIssueRow], filter: GitHubHubFilter, login: String?) -> [GitHubIssueRow] {
        guard filter == .mine, let login = normalizedLogin(login) else { return issues }
        return issues.filter { normalizedLogin($0.assignee) == login }
    }

    /// PRs whose review is requested from `login`. Same blank-login fallback.
    static func filterPulls(_ pulls: [GitHubPullRow], filter: GitHubHubFilter, login: String?) -> [GitHubPullRow] {
        guard filter == .mine, let login = normalizedLogin(login) else { return pulls }
        return pulls.filter { pull in
            pull.requestedReviewers.contains { normalizedLogin($0) == login }
        }
    }

    private static func normalizedLogin(_ login: String?) -> String? {
        guard let value = login?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              value.isEmpty == false else { return nil }
        return value
    }

    // MARK: server-side filter params (author / involvement / q / page)

    /// The typed request params for `GET …/github/pulls`, reconciled from the
    /// filter row's state plus the Open|Mine control.
    struct PullsQueryParams: Equatable {
        var author: String?
        var involvement: String?
        var q: String?
    }

    /// Reconcile the Open|Mine control with the filter row's state. "Mine" is a
    /// shortcut for `author=<my login>` — it is NOT `involvement`, so it always
    /// wins over any free-typed `author` text (the view keeps the author field
    /// disabled while "Mine" is active, so the two never fight over a request in
    /// practice; this still resolves deterministically if they did). Involvement
    /// (`assigned`/`review_requested`) is mutually exclusive with itself and
    /// orthogonal to `author`/`q` — all can combine in one request.
    static func pullsQueryParams(
        filter: GitHubHubFilter, state: GitHubPullsFilterState, login: String?
    ) -> PullsQueryParams {
        let mineAuthor = filter == .mine ? normalizedLogin(login) : nil
        return PullsQueryParams(
            author: mineAuthor ?? state.trimmedAuthor,
            involvement: state.involvement.queryValue,
            q: state.trimmedQuery
        )
    }

    /// Whether the identity backing "Assigned to me" / "My reviews" lacks a mapped
    /// GitHub login — the contract's `available:true`, empty `pulls`, informative
    /// `detail` shape for an unmapped identity. Both involvement chips disable with
    /// this string as their footnote so the empty list reads as "can't answer this",
    /// never as "there's nothing here".
    static func involvementUnavailableDetail(_ response: GitHubPullsResponse) -> String? {
        guard response.available, response.pulls.isEmpty, let detail = response.detail,
              detail.isEmpty == false else { return nil }
        return detail
    }

    // MARK: load-more footer copy

    /// The load-more footer's "N of ~total" caption, or nil to hide the footer
    /// entirely (nothing loaded yet, or the list is already complete with no more
    /// to fetch and no total to report).
    static func loadMoreCaption(loadedCount: Int, totalCount: Int?, hasMore: Bool) -> String? {
        guard loadedCount > 0, hasMore || totalCount != nil else { return nil }
        if let totalCount {
            return "\(loadedCount) of ~\(totalCount)"
        }
        return hasMore ? "\(loadedCount) loaded" : nil
    }

    // MARK: checks chip summary

    /// The compact "n passed / m failing / k pending" summary a checks chip shows,
    /// plus the one-glance verdict color the chip tints itself with.
    struct ChecksSummary: Equatable {
        /// A short chip label, e.g. "3✓ 2✗ 2•" or "no checks".
        let label: String
        /// The dominant state: failing beats pending beats passed beats none.
        let verdict: Verdict
        /// Whether any checks exist at all (total > 0).
        let hasChecks: Bool

        enum Verdict: Equatable {
            case failing   // at least one failing → red
            case pending   // none failing, some pending → amber
            case passing   // all resolved, at least one passed → green
            case none      // no checks reported → neutral
        }
    }

    /// Roll the four counts up into a chip summary. The dominant verdict follows the
    /// portal: any failing → failing; else any pending → pending; else any passed →
    /// passing; else none. `total == 0` (older server or no CI) → the "no checks" pill.
    static func checksSummary(_ checks: GitHubChecks) -> ChecksSummary {
        guard checks.total > 0 else {
            return ChecksSummary(label: "no checks", verdict: .none, hasChecks: false)
        }
        var parts: [String] = []
        if checks.passed > 0 { parts.append("\(checks.passed)✓") }
        if checks.failing > 0 { parts.append("\(checks.failing)✗") }
        if checks.pending > 0 { parts.append("\(checks.pending)•") }
        let label = parts.isEmpty ? "\(checks.total) checks" : parts.joined(separator: " ")

        let verdict: ChecksSummary.Verdict =
            checks.failing > 0 ? .failing :
            checks.pending > 0 ? .pending :
            checks.passed > 0 ? .passing : .none
        return ChecksSummary(label: label, verdict: verdict, hasChecks: true)
    }

    /// Per-run status glyph for the detail checks list. Maps GitHub's status +
    /// conclusion onto one of the four verdict families.
    static func runVerdict(_ run: GitHubCheckRun) -> ChecksSummary.Verdict {
        guard run.status == "completed" else { return .pending }
        switch run.conclusion {
        case "success", "neutral", "skipped": return .passing
        case "failure", "timed_out", "action_required", "cancelled", "stale", "startup_failure": return .failing
        default: return .pending
        }
    }

    // MARK: mergeable-state chip copy

    /// Human copy for GitHub's raw `mergeable_state`. nil / unknown → no chip.
    static func mergeStateLabel(_ state: String?) -> String? {
        switch state {
        case "clean": "ready to merge"
        case "dirty": "conflicts"
        case "blocked": "blocked"
        case "behind": "behind base"
        case "unstable": "unstable"
        case "has_hooks": "checks running"
        case "draft": "draft"
        case "unknown", "", nil: nil
        default: state?.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// A short human line for an `available:false` reason — the empty-state copy.
    static func unavailableCopy(reason: String?, detail: String?) -> String {
        switch reason {
        case "repo_not_connected":
            return "No GitHub repository is connected to this Orcha yet. Connect one from the Home tab to see its issues and pull requests here."
        case "rate_limited":
            return "GitHub is rate-limiting requests right now. This will clear on its own — try again in a few minutes."
        case "not_found":
            return "That item no longer exists on GitHub, or the repository binding changed."
        case "unreachable":
            return "Couldn't reach GitHub from this Orcha. Check the server's connection and try again."
        case "github_error":
            return detail ?? "GitHub returned an error. Try again shortly."
        default:
            return detail ?? "The GitHub surface isn't available for this Orcha right now."
        }
    }
}
