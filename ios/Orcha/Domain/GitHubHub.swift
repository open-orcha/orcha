import Foundation

/// GitHub hub — the phone parity of the portal's GitHub hub page + Slack triggers.
/// Codable models mirroring the cloud contract (cloud PRs #94 + #95) exactly, with
/// tolerant decoders: every optional/absent field defaults, so an older self-host
/// server (missing keys, or the whole surface 404ing) degrades — never throws.
///
/// The whole surface rides the same `available:false` clean-error contract as
/// `GithubReposResponse`: an unbound repo, a rate limit, or a GitHub error all land
/// as a 200 with `available:false` + `reason`, mapped here to a friendly off state.

// MARK: - checks rollup (shared list + detail)

/// The four-count checks summary chip (`n passed / failing / pending` of total).
/// Absent (older server) → all-zeros, which the chip treats as "no checks".
struct GitHubChecks: Decodable, Equatable {
    var passed = 0
    var failing = 0
    var pending = 0
    var total = 0
    /// Per-run breakdown — detail-only (the list endpoint omits `runs`).
    var runs: [GitHubCheckRun] = []

    enum CodingKeys: String, CodingKey {
        case passed, failing, pending, total, runs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        passed = try c.decodeIfPresent(Int.self, forKey: .passed) ?? 0
        failing = try c.decodeIfPresent(Int.self, forKey: .failing) ?? 0
        pending = try c.decodeIfPresent(Int.self, forKey: .pending) ?? 0
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        runs = try c.decodeIfPresent([GitHubCheckRun].self, forKey: .runs) ?? []
    }

    init(passed: Int = 0, failing: Int = 0, pending: Int = 0, total: Int = 0, runs: [GitHubCheckRun] = []) {
        self.passed = passed
        self.failing = failing
        self.pending = pending
        self.total = total
        self.runs = runs
    }
}

/// One check run in the detail breakdown (legacy commit-status contexts are
/// normalized server-side into this same shape: `status:"completed"`, `conclusion`).
struct GitHubCheckRun: Decodable, Equatable, Identifiable {
    var name = ""
    /// `"completed"` | `"queued"` | `"in_progress"` (GitHub's raw value).
    var status = ""
    /// `"success"` | `"failure"` | … | null (only set once `status == "completed"`).
    var conclusion: String?
    var htmlUrl: String?

    /// Stable enough for `ForEach` — name + conclusion; runs aren't re-fetched mid-list.
    var id: String { "\(name)#\(conclusion ?? status)" }

    enum CodingKeys: String, CodingKey {
        case name, status, conclusion
        case htmlUrl = "html_url"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        conclusion = try c.decodeIfPresent(String.self, forKey: .conclusion)
        htmlUrl = try c.decodeIfPresent(String.self, forKey: .htmlUrl)
    }

    init(name: String, status: String, conclusion: String? = nil, htmlUrl: String? = nil) {
        self.name = name
        self.status = status
        self.conclusion = conclusion
        self.htmlUrl = htmlUrl
    }
}

// MARK: - labels

/// One issue label. The server moved from plain name strings to `{name, color}`
/// (GitHub's own label hex, no leading '#', e.g. "d73a4a") so the UI can render real
/// repo colors — this decoder accepts BOTH shapes (Android `GitHubLabelSerializer`
/// parity), so a labeled issue can never again fail the whole list decode.
/// `color` is nil for a colorless label, an older server's bare string, or junk.
struct GitHubLabel: Decodable, Hashable {
    var name: String
    var color: String?

    enum CodingKeys: String, CodingKey {
        case name, color
    }

    init(name: String, color: String? = nil) {
        self.name = name
        self.color = color
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let bare = try? single.decode(String.self) {
            name = bare
            color = nil
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        let raw = try c.decodeIfPresent(String.self, forKey: .color)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        color = (raw?.isEmpty == false) ? raw : nil
    }

    /// `color` as a 24-bit RGB value when it is a well-formed 6-digit hex (with or
    /// without a leading '#'); nil otherwise, so the chip falls back to the house tint.
    var rgb: UInt32? {
        guard var hex = color else { return nil }
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        return value
    }
}

// MARK: - list rows

/// `GET …/github/issues` → one open issue row.
struct GitHubIssueRow: Decodable, Equatable, Identifiable {
    let number: Int
    var title = ""
    var labels: [GitHubLabel] = []
    /// Primary assignee login, or nil.
    var assignee: String?
    var updatedAt: String?
    var htmlUrl: String?
    /// First ~200 chars of the body.
    var bodyExcerpt: String?

    var id: Int { number }

    enum CodingKeys: String, CodingKey {
        case number, title, labels, assignee
        case updatedAt = "updated_at"
        case htmlUrl = "html_url"
        case bodyExcerpt = "body_excerpt"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        labels = try c.decodeIfPresent([GitHubLabel].self, forKey: .labels) ?? []
        assignee = try c.decodeIfPresent(String.self, forKey: .assignee)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        htmlUrl = try c.decodeIfPresent(String.self, forKey: .htmlUrl)
        bodyExcerpt = try c.decodeIfPresent(String.self, forKey: .bodyExcerpt)
    }

    init(number: Int, title: String = "", labels: [GitHubLabel] = [], assignee: String? = nil,
         updatedAt: String? = nil, htmlUrl: String? = nil, bodyExcerpt: String? = nil) {
        self.number = number
        self.title = title
        self.labels = labels
        self.assignee = assignee
        self.updatedAt = updatedAt
        self.htmlUrl = htmlUrl
        self.bodyExcerpt = bodyExcerpt
    }
}

/// `GET …/github/pulls` → one open PR row.
struct GitHubPullRow: Decodable, Equatable, Identifiable {
    let number: Int
    var title = ""
    var head = ""
    var draft = false
    var updatedAt: String?
    var htmlUrl: String?
    var requestedReviewers: [String] = []
    var checks = GitHubChecks()
    /// GitHub's raw `mergeable_state` ("clean" | "dirty" | "blocked" | …) or null.
    var mergeableState: String?

    var id: Int { number }

    enum CodingKeys: String, CodingKey {
        case number, title, head, draft, checks
        case updatedAt = "updated_at"
        case htmlUrl = "html_url"
        case requestedReviewers = "requested_reviewers"
        case mergeableState = "mergeable_state"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        head = try c.decodeIfPresent(String.self, forKey: .head) ?? ""
        draft = try c.decodeIfPresent(Bool.self, forKey: .draft) ?? false
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        htmlUrl = try c.decodeIfPresent(String.self, forKey: .htmlUrl)
        requestedReviewers = try c.decodeIfPresent([String].self, forKey: .requestedReviewers) ?? []
        checks = try c.decodeIfPresent(GitHubChecks.self, forKey: .checks) ?? GitHubChecks()
        mergeableState = try c.decodeIfPresent(String.self, forKey: .mergeableState)
    }

    init(number: Int, title: String = "", head: String = "", draft: Bool = false,
         updatedAt: String? = nil, htmlUrl: String? = nil, requestedReviewers: [String] = [],
         checks: GitHubChecks = GitHubChecks(), mergeableState: String? = nil) {
        self.number = number
        self.title = title
        self.head = head
        self.draft = draft
        self.updatedAt = updatedAt
        self.htmlUrl = htmlUrl
        self.requestedReviewers = requestedReviewers
        self.checks = checks
        self.mergeableState = mergeableState
    }
}

// MARK: - list responses (the `available:false` clean-error contract)

/// `GET …/github/issues` envelope. `available:false` (unbound / rate-limited /
/// GitHub error / 404 on an older server) is the graceful off state — never thrown.
struct GitHubIssuesResponse: Decodable {
    var available = false
    var repo: String?
    var reason: String?
    var detail: String?
    var issues: [GitHubIssueRow] = []

    enum CodingKeys: String, CodingKey {
        case available, repo, reason, detail, issues
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        repo = try c.decodeIfPresent(String.self, forKey: .repo)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        issues = try c.decodeIfPresent([GitHubIssueRow].self, forKey: .issues) ?? []
    }

    init(available: Bool, repo: String? = nil, reason: String? = nil,
         detail: String? = nil, issues: [GitHubIssueRow] = []) {
        self.available = available
        self.repo = repo
        self.reason = reason
        self.detail = detail
        self.issues = issues
    }
}

/// `GET …/github/pulls` envelope. Same clean-error contract as issues, plus the
/// filter/pagination superset: `page`/`perPage` echo the effective request values
/// (defaulted server-side ⇒ never nil on a response that decoded at all), `totalCount`
/// is nullable (GitHub's search API doesn't always report a total), and `hasMore`
/// is absent on an older server — which this decodes as `false`, matching that
/// server's existing full-list-in-one-page behavior exactly.
struct GitHubPullsResponse: Decodable {
    var available = false
    var repo: String?
    var reason: String?
    var detail: String?
    var pulls: [GitHubPullRow] = []
    /// 1-based.
    var page = 1
    var perPage = 30
    /// nil when the server can't report a total (e.g. a search-sourced page).
    var totalCount: Int?
    /// Absent on an older server ⇒ `false` — that server always returned the full
    /// list in one page, so "no more" is the correct read of a missing key.
    var hasMore = false

    enum CodingKeys: String, CodingKey {
        case available, repo, reason, detail, pulls, page
        case perPage = "per_page"
        case totalCount = "total_count"
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        repo = try c.decodeIfPresent(String.self, forKey: .repo)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        pulls = try c.decodeIfPresent([GitHubPullRow].self, forKey: .pulls) ?? []
        page = try c.decodeIfPresent(Int.self, forKey: .page) ?? 1
        perPage = try c.decodeIfPresent(Int.self, forKey: .perPage) ?? 30
        totalCount = try c.decodeIfPresent(Int.self, forKey: .totalCount)
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }

    init(available: Bool, repo: String? = nil, reason: String? = nil,
         detail: String? = nil, pulls: [GitHubPullRow] = [],
         page: Int = 1, perPage: Int = 30, totalCount: Int? = nil, hasMore: Bool = false) {
        self.available = available
        self.repo = repo
        self.reason = reason
        self.detail = detail
        self.pulls = pulls
        self.page = page
        self.perPage = perPage
        self.totalCount = totalCount
        self.hasMore = hasMore
    }
}

/// `GET …/github/checks?numbers=1,2,3` — the PR list's progressive-fill follow-up.
/// The list route deliberately ships `checks: null` on every row (one GitHub call
/// per PR is too slow inline — the server's lazy split), and this batch call fills
/// them in. Keys are PR numbers as strings (JSON object keys); a number the server
/// couldn't resolve (e.g. a search-sourced row outside its open-PR cache) is absent.
struct GitHubChecksBatchResponse: Decodable {
    var available = false
    var reason: String?
    var detail: String?
    var checks: [String: GitHubChecks] = [:]

    enum CodingKeys: String, CodingKey {
        case available, reason, detail, checks
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        checks = try c.decodeIfPresent([String: GitHubChecks].self, forKey: .checks) ?? [:]
    }

    init(available: Bool, reason: String? = nil, detail: String? = nil, checks: [String: GitHubChecks] = [:]) {
        self.available = available
        self.reason = reason
        self.detail = detail
        self.checks = checks
    }
}

// MARK: - detail models

/// One changed file in a PR. Carries the diff text: `patch` is GitHub's raw
/// unified-diff hunk text for the file (hunk lines only — no `diff --git`/`+++`/`---`
/// headers), or `nil` when omitted. `patchOmitted` is true either because GitHub itself
/// never sent a patch (binary file, or GitHub judged it too large) or because the
/// server's own per-PR patch-byte budget was crossed (`github_hub_routes.py:_pr_files`);
/// both cases render the same honest "diff not available" affordance — the app has no
/// way (or need) to tell them apart. Absent on an older server ⇒ `patch: nil`,
/// `patchOmitted: false`, which the UI treats identically to "not available" via the
/// `nil` check, so old and new servers degrade the same way.
struct GitHubChangedFile: Decodable, Equatable, Identifiable {
    var filename = ""
    var additions = 0
    var deletions = 0
    /// `"added"` | `"modified"` | `"removed"` | `"renamed"`.
    var status = ""
    var patch: String?
    var patchOmitted = false

    var id: String { filename }

    enum CodingKeys: String, CodingKey {
        case filename, additions, deletions, status, patch
        case patchOmitted = "patch_omitted"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        filename = try c.decodeIfPresent(String.self, forKey: .filename) ?? ""
        additions = try c.decodeIfPresent(Int.self, forKey: .additions) ?? 0
        deletions = try c.decodeIfPresent(Int.self, forKey: .deletions) ?? 0
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        patch = try c.decodeIfPresent(String.self, forKey: .patch)
        patchOmitted = try c.decodeIfPresent(Bool.self, forKey: .patchOmitted) ?? false
    }

    init(filename: String, additions: Int = 0, deletions: Int = 0, status: String = "",
         patch: String? = nil, patchOmitted: Bool = false) {
        self.filename = filename
        self.additions = additions
        self.deletions = deletions
        self.status = status
        self.patch = patch
        self.patchOmitted = patchOmitted
    }
}

/// The `files` block on a PR detail: GitHub's honest `count`, the first-100 `items`,
/// `truncated:true` (present only when `count > items.count`; absent ⇒ false), and
/// `patchesTruncated:true` when the server's per-PR patch-byte budget cut off some
/// files' `patch` text (distinct from a per-file GitHub-side omission — see
/// `GitHubChangedFile`). Absent ⇒ false, so an older server (or a PR under budget)
/// never shows the "diffs cut off" note.
struct GitHubFiles: Decodable, Equatable {
    var count = 0
    var items: [GitHubChangedFile] = []
    var truncated = false
    var patchesTruncated = false

    enum CodingKeys: String, CodingKey {
        case count, items, truncated
        case patchesTruncated = "patches_truncated"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
        items = try c.decodeIfPresent([GitHubChangedFile].self, forKey: .items) ?? []
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        patchesTruncated = try c.decodeIfPresent(Bool.self, forKey: .patchesTruncated) ?? false
    }

    init(count: Int = 0, items: [GitHubChangedFile] = [], truncated: Bool = false, patchesTruncated: Bool = false) {
        self.count = count
        self.items = items
        self.truncated = truncated
        self.patchesTruncated = patchesTruncated
    }
}

/// `GET …/github/pulls/{number}` → the full PR.
struct GitHubPullDetail: Decodable, Equatable {
    let number: Int
    var title = ""
    var state = "open"
    var draft = false
    /// RAW markdown — render client-side (never html-rendered server-side).
    var bodyMarkdown = ""
    var authorLogin: String?
    var base = ""
    var head = ""
    var updatedAt: String?
    var createdAt: String?
    var htmlUrl: String?
    var mergeableState: String?
    var assignees: [String] = []
    var requestedReviewers: [String] = []
    var checks = GitHubChecks()
    var files = GitHubFiles()
    var commentsCount = 0
    var reviewCommentsCount = 0

    enum CodingKeys: String, CodingKey {
        case number, title, state, draft, base, head, assignees, checks, files
        case bodyMarkdown = "body_markdown"
        case authorLogin = "author_login"
        case updatedAt = "updated_at"
        case createdAt = "created_at"
        case htmlUrl = "html_url"
        case mergeableState = "mergeable_state"
        case requestedReviewers = "requested_reviewers"
        case commentsCount = "comments_count"
        case reviewCommentsCount = "review_comments_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "open"
        draft = try c.decodeIfPresent(Bool.self, forKey: .draft) ?? false
        bodyMarkdown = try c.decodeIfPresent(String.self, forKey: .bodyMarkdown) ?? ""
        authorLogin = try c.decodeIfPresent(String.self, forKey: .authorLogin)
        base = try c.decodeIfPresent(String.self, forKey: .base) ?? ""
        head = try c.decodeIfPresent(String.self, forKey: .head) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        htmlUrl = try c.decodeIfPresent(String.self, forKey: .htmlUrl)
        mergeableState = try c.decodeIfPresent(String.self, forKey: .mergeableState)
        assignees = try c.decodeIfPresent([String].self, forKey: .assignees) ?? []
        requestedReviewers = try c.decodeIfPresent([String].self, forKey: .requestedReviewers) ?? []
        checks = try c.decodeIfPresent(GitHubChecks.self, forKey: .checks) ?? GitHubChecks()
        files = try c.decodeIfPresent(GitHubFiles.self, forKey: .files) ?? GitHubFiles()
        commentsCount = try c.decodeIfPresent(Int.self, forKey: .commentsCount) ?? 0
        reviewCommentsCount = try c.decodeIfPresent(Int.self, forKey: .reviewCommentsCount) ?? 0
    }
}

/// One comment in an issue thread (most-recent 20, oldest-first).
struct GitHubComment: Decodable, Equatable, Identifiable {
    var authorLogin: String?
    /// RAW markdown — render client-side.
    var bodyMarkdown = ""
    var createdAt: String?

    /// Stable per-position id for `ForEach` (comments carry no server id here).
    let id = UUID()

    enum CodingKeys: String, CodingKey {
        case bodyMarkdown = "body_markdown"
        case authorLogin = "author_login"
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        authorLogin = try c.decodeIfPresent(String.self, forKey: .authorLogin)
        bodyMarkdown = try c.decodeIfPresent(String.self, forKey: .bodyMarkdown) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    init(authorLogin: String?, bodyMarkdown: String, createdAt: String?) {
        self.authorLogin = authorLogin
        self.bodyMarkdown = bodyMarkdown
        self.createdAt = createdAt
    }
}

/// `GET …/github/issues/{number}` → the full issue.
struct GitHubIssueDetail: Decodable, Equatable {
    let number: Int
    var title = ""
    var state = "open"
    /// RAW markdown — render client-side.
    var bodyMarkdown = ""
    var authorLogin: String?
    var labels: [GitHubLabel] = []
    var assignee: String?
    var assignees: [String] = []
    var updatedAt: String?
    var createdAt: String?
    var htmlUrl: String?
    var commentsCount = 0
    /// Most-recent 20, oldest-first.
    var comments: [GitHubComment] = []

    enum CodingKeys: String, CodingKey {
        case number, title, state, labels, assignee, assignees, comments
        case bodyMarkdown = "body_markdown"
        case authorLogin = "author_login"
        case updatedAt = "updated_at"
        case createdAt = "created_at"
        case htmlUrl = "html_url"
        case commentsCount = "comments_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "open"
        bodyMarkdown = try c.decodeIfPresent(String.self, forKey: .bodyMarkdown) ?? ""
        authorLogin = try c.decodeIfPresent(String.self, forKey: .authorLogin)
        labels = try c.decodeIfPresent([GitHubLabel].self, forKey: .labels) ?? []
        assignee = try c.decodeIfPresent(String.self, forKey: .assignee)
        assignees = try c.decodeIfPresent([String].self, forKey: .assignees) ?? []
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        htmlUrl = try c.decodeIfPresent(String.self, forKey: .htmlUrl)
        commentsCount = try c.decodeIfPresent(Int.self, forKey: .commentsCount) ?? 0
        comments = try c.decodeIfPresent([GitHubComment].self, forKey: .comments) ?? []
    }
}

/// Detail envelopes: `available:true` carries the item; `available:false` carries
/// the reason (`not_found` | `rate_limited` | `repo_not_connected` | …).
struct GitHubPullDetailResponse: Decodable {
    var available = false
    var repo: String?
    var reason: String?
    var detail: String?
    var pull: GitHubPullDetail?

    enum CodingKeys: String, CodingKey {
        case available, repo, reason, detail, pull
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        repo = try c.decodeIfPresent(String.self, forKey: .repo)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        pull = try c.decodeIfPresent(GitHubPullDetail.self, forKey: .pull)
    }

    init(available: Bool, repo: String? = nil, reason: String? = nil,
         detail: String? = nil, pull: GitHubPullDetail? = nil) {
        self.available = available
        self.repo = repo
        self.reason = reason
        self.detail = detail
        self.pull = pull
    }
}

struct GitHubIssueDetailResponse: Decodable {
    var available = false
    var repo: String?
    var reason: String?
    var detail: String?
    var issue: GitHubIssueDetail?

    enum CodingKeys: String, CodingKey {
        case available, repo, reason, detail, issue
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        repo = try c.decodeIfPresent(String.self, forKey: .repo)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        issue = try c.decodeIfPresent(GitHubIssueDetail.self, forKey: .issue)
    }

    init(available: Bool, repo: String? = nil, reason: String? = nil,
         detail: String? = nil, issue: GitHubIssueDetail? = nil) {
        self.available = available
        self.repo = repo
        self.reason = reason
        self.detail = detail
        self.issue = issue
    }
}

// MARK: - POST /start

/// `POST …/github/start` → the created (or already-tracked) task.
struct GitHubStartResponse: Decodable, Equatable {
    let taskId: String
    /// `true` ⇒ an OPEN `GH #N:` task already existed (idempotent, no duplicate).
    var existing = false

    enum CodingKeys: String, CodingKey {
        case existing
        case taskId = "task_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId)
        existing = try c.decodeIfPresent(Bool.self, forKey: .existing) ?? false
    }

    init(taskId: String, existing: Bool = false) {
        self.taskId = taskId
        self.existing = existing
    }
}
