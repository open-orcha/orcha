import Foundation
import Testing
@testable import Orcha

/// GitHub hub (cloud PRs #94 + #95) — the serialization contract for all four
/// endpoint shapes, the start-request body, and the pure hub logic (phase mapping,
/// Open/Mine filtering, checks-chip summary).

// MARK: - decoding fixtures

@Suite struct GitHubHubDecodeTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // ---------- GET …/github/issues ----------

    @Test func issuesResponseDecodesTheAvailableShape() throws {
        // The REAL shape `github_hub_routes._labels()` emits: {name, color} objects,
        // color = GitHub's bare hex, or null on a colorless label.
        let response = try decode(GitHubIssuesResponse.self, """
        {"available": true, "repo": "owner/name", "issues": [
            {"number": 7, "title": "Bug",
             "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p1", "color": null}],
             "assignee": "octocat",
             "updated_at": "2026-07-01T00:00:00Z",
             "html_url": "https://github.com/owner/name/issues/7",
             "body_excerpt": "first 200 chars"}
        ]}
        """)
        #expect(response.available)
        #expect(response.repo == "owner/name")
        let issue = try #require(response.issues.first)
        #expect(issue.number == 7)
        #expect(issue.title == "Bug")
        #expect(issue.labels == [GitHubLabel(name: "bug", color: "d73a4a"), GitHubLabel(name: "p1")])
        #expect(issue.labels.first?.rgb == 0xD73A4A)
        #expect(issue.labels.last?.rgb == nil)
        #expect(issue.assignee == "octocat")
        #expect(issue.htmlUrl == "https://github.com/owner/name/issues/7")
        #expect(issue.bodyExcerpt == "first 200 chars")
    }

    @Test func issueLabelsTolerateTheLegacyBareStringShape() throws {
        // An older self-host server still sends plain names — one list, both shapes,
        // must decode (the pre-fix `[String]` decoder failed the WHOLE issue list on
        // the first labeled issue from a current server).
        let response = try decode(GitHubIssuesResponse.self, """
        {"available": true, "repo": "o/n", "issues": [
            {"number": 1, "title": "Old", "labels": ["bug", "p1"]},
            {"number": 2, "title": "New", "labels": [{"name": "bug", "color": "#d73a4a"}]},
            {"number": 3, "title": "Mixed", "labels": ["legacy", {"name": "typed", "color": "  "}]}
        ]}
        """)
        #expect(response.issues.map { $0.labels.map(\.name) } == [["bug", "p1"], ["bug"], ["legacy", "typed"]])
        #expect(response.issues[0].labels.allSatisfy { $0.color == nil })
        #expect(response.issues[1].labels.first?.rgb == 0xD73A4A)   // leading '#' tolerated
        #expect(response.issues[2].labels.last?.color == nil)        // blank color → nil
    }

    @Test(arguments: ["zzzzzz", "d73a4", "d73a4a00", ""])
    func malformedLabelColorFallsBackToNoTint(color: String) throws {
        let label = try decode(GitHubLabel.self, #"{"name": "x", "color": "\#(color)"}"#)
        #expect(label.name == "x")
        #expect(label.rgb == nil)
    }

    @Test func issueRowToleratesNullAndAbsentOptionalFields() throws {
        // Unassigned issue with no labels/excerpt (a pre-triage item on a lean server).
        let response = try decode(GitHubIssuesResponse.self, """
        {"available": true, "repo": "o/n", "issues": [
            {"number": 3, "title": "Bare", "assignee": null}
        ]}
        """)
        let issue = try #require(response.issues.first)
        #expect(issue.assignee == nil)
        #expect(issue.labels.isEmpty)
        #expect(issue.bodyExcerpt == nil)
        #expect(issue.updatedAt == nil)
    }

    @Test(arguments: [
        #"{"available": false, "reason": "repo_not_connected", "detail": "no repo"}"#,
        #"{"available": false, "reason": "rate_limited", "detail": "GitHub 403", "repo": "o/n"}"#,
    ])
    func issuesResponseDecodesTheGracefulOffState(json: String) throws {
        let response = try decode(GitHubIssuesResponse.self, json)
        #expect(response.available == false)
        #expect(response.reason != nil)
        #expect(response.issues.isEmpty)
    }

    // ---------- GET …/github/pulls ----------

    @Test func pullsResponseDecodesChecksAndReviewers() throws {
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [
            {"number": 12, "title": "Feature", "head": "feat/x", "draft": false,
             "updated_at": "2026-07-02T00:00:00Z", "html_url": "https://github.com/o/n/pull/12",
             "requested_reviewers": ["hubot"],
             "checks": {"passed": 3, "failing": 2, "pending": 2, "total": 7},
             "mergeable_state": "clean"}
        ]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.number == 12)
        #expect(pull.head == "feat/x")
        #expect(pull.draft == false)
        #expect(pull.requestedReviewers == ["hubot"])
        #expect(pull.checks.passed == 3)
        #expect(pull.checks.failing == 2)
        #expect(pull.checks.pending == 2)
        #expect(pull.checks.total == 7)
        #expect(pull.mergeableState == "clean")
    }

    @Test func draftPullWithEmptyReviewersAndNullMergeState() throws {
        // A freshly-pushed draft: no reviewers, checks not yet reported, null merge state
        // (the live server's actual shape for a just-opened PR).
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [
            {"number": 221, "title": "WIP", "head": "wip/x", "draft": true,
             "requested_reviewers": [],
             "checks": {"passed": 0, "failing": 0, "pending": 0, "total": 0},
             "mergeable_state": null}
        ]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.draft)
        #expect(pull.requestedReviewers.isEmpty)
        #expect(pull.checks.total == 0)
        #expect(pull.mergeableState == nil)
    }

    @Test func pullRowToleratesEntirelyAbsentChecksBlock() throws {
        // An older server that predates the checks rollup — the row still decodes.
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [{"number": 5, "title": "Old"}]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.checks.total == 0)
        #expect(pull.head.isEmpty)
    }

    // ---------- filter/pagination superset (frozen contract) ----------

    @Test func pullsResponseDecodesPaginationFields() throws {
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [{"number": 1, "title": "A"}],
         "page": 2, "per_page": 50, "total_count": 137, "has_more": true}
        """)
        #expect(response.page == 2)
        #expect(response.perPage == 50)
        #expect(response.totalCount == 137)
        #expect(response.hasMore)
    }

    @Test func pullsResponseTotalCountToleratesNull() throws {
        // Search-sourced pages don't always carry a reliable total.
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [], "page": 1, "per_page": 30,
         "total_count": null, "has_more": false}
        """)
        #expect(response.totalCount == nil)
        #expect(response.hasMore == false)
    }

    @Test func pullsResponseWithoutPaginationFieldsDefaultsToFalseHasMore() throws {
        // An older server, before this contract existed — `has_more` absent must
        // read as false (that server always returned the complete list in one shot).
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [{"number": 1, "title": "A"}]}
        """)
        #expect(response.page == 1)
        #expect(response.perPage == 30)
        #expect(response.totalCount == nil)
        #expect(response.hasMore == false)
    }

    @Test func searchSourcedRowToleratesMissingHeadBaseChecksReviewers() throws {
        // A search-sourced row (author/q hit GitHub's search API) may omit fields
        // the plain list endpoint always includes — the row still decodes cleanly.
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [
            {"number": 44, "title": "Search hit"}
        ]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.number == 44)
        #expect(pull.head.isEmpty)
        #expect(pull.requestedReviewers.isEmpty)
        #expect(pull.checks.total == 0)
        #expect(pull.mergeableState == nil)
    }

    @Test func involvementUnavailableIdentityShape() throws {
        // The contract's "identity without github_login" shape: available:true,
        // empty items, an informative detail string.
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [],
         "detail": "This identity has no linked GitHub login."}
        """)
        #expect(response.available)
        #expect(response.pulls.isEmpty)
        #expect(response.detail == "This identity has no linked GitHub login.")
    }

    // ---------- GET …/github/pulls/{number} ----------

    @Test func pullDetailDecodesFullShape() throws {
        let response = try decode(GitHubPullDetailResponse.self, """
        {"available": true, "repo": "o/n", "pull": {
            "number": 12, "title": "Add feature", "state": "open", "draft": false,
            "body_markdown": "## Why\\n...", "author_login": "octocat",
            "base": "main", "head": "feat/x",
            "updated_at": "2026-07-02T00:00:00Z", "created_at": "2026-07-01T00:00:00Z",
            "html_url": "https://github.com/o/n/pull/12", "mergeable_state": "clean",
            "assignees": ["octocat", "hubot"], "requested_reviewers": ["reviewer1"],
            "checks": {"passed": 2, "failing": 0, "pending": 1, "total": 3,
                       "runs": [{"name": "build", "status": "completed",
                                 "conclusion": "success", "html_url": "https://x"}]},
            "files": {"count": 2, "truncated": true, "items": [
                {"filename": "a.py", "additions": 10, "deletions": 2, "status": "modified"}
            ]},
            "comments_count": 3, "review_comments_count": 5
        }}
        """)
        let pull = try #require(response.pull)
        #expect(pull.bodyMarkdown == "## Why\n...")
        #expect(pull.base == "main")
        #expect(pull.head == "feat/x")
        #expect(pull.assignees == ["octocat", "hubot"])
        #expect(pull.checks.runs.count == 1)
        #expect(pull.checks.runs.first?.name == "build")
        #expect(pull.checks.runs.first?.conclusion == "success")
        #expect(pull.commentsCount == 3)
        #expect(pull.reviewCommentsCount == 5)
    }

    @Test func pullDetailFilesTruncatedFlag() throws {
        // truncated:true present exactly when count > items returned.
        let truncated = try decode(GitHubFiles.self,
            #"{"count": 120, "truncated": true, "items": [{"filename": "a", "additions": 1, "deletions": 0, "status": "added"}]}"#)
        #expect(truncated.count == 120)
        #expect(truncated.items.count == 1)
        #expect(truncated.truncated)

        // truncated omitted ⇒ false (the small-PR case).
        let whole = try decode(GitHubFiles.self,
            #"{"count": 1, "items": [{"filename": "a", "additions": 1, "deletions": 0, "status": "added"}]}"#)
        #expect(whole.truncated == false)
    }

    // ---------- per-file `patch` (github_hub_routes.py:_pr_files) ----------

    @Test func changedFileDecodesItsPatchText() throws {
        let file = try decode(GitHubChangedFile.self, """
        {"filename": "src/app.py", "additions": 2, "deletions": 1, "status": "modified",
         "patch": "@@ -1,2 +1,3 @@\\n line\\n-old\\n+new\\n+added", "patch_omitted": false}
        """)
        #expect(file.filename == "src/app.py")
        #expect(file.patch == "@@ -1,2 +1,3 @@\n line\n-old\n+new\n+added")
        #expect(file.patchOmitted == false)
    }

    @Test func changedFilePatchOmittedCarriesNilPatch() throws {
        // Binary file, GitHub-side "too large", or the server's own patch-byte budget —
        // all three collapse to this same shape (github_hub_routes.py:_pr_files).
        let file = try decode(GitHubChangedFile.self, """
        {"filename": "assets/logo.png", "additions": 0, "deletions": 0, "status": "modified",
         "patch": null, "patch_omitted": true}
        """)
        #expect(file.patch == nil)
        #expect(file.patchOmitted)
    }

    @Test func changedFileToleratesAbsentPatchFields() throws {
        // An older server, before `patch`/`patch_omitted` existed on this shape.
        let file = try decode(GitHubChangedFile.self,
            #"{"filename": "a.py", "additions": 1, "deletions": 0, "status": "added"}"#)
        #expect(file.patch == nil)
        #expect(file.patchOmitted == false)
    }

    @Test func filesDecodesPatchesTruncatedFlag() throws {
        let cut = try decode(GitHubFiles.self, """
        {"count": 2, "items": [
            {"filename": "big.py", "additions": 500, "deletions": 10, "status": "modified",
             "patch": "@@ -1,1 +1,1 @@\\n-x\\n+y", "patch_omitted": false},
            {"filename": "also-big.py", "additions": 400, "deletions": 5, "status": "modified",
             "patch": null, "patch_omitted": true}
        ], "patches_truncated": true}
        """)
        #expect(cut.patchesTruncated)
        #expect(cut.items[0].patchOmitted == false)
        #expect(cut.items[1].patchOmitted)

        // Absent ⇒ false — the common case, a PR under the patch-byte budget.
        let underBudget = try decode(GitHubFiles.self,
            #"{"count": 1, "items": [{"filename": "a", "additions": 1, "deletions": 0, "status": "added"}]}"#)
        #expect(underBudget.patchesTruncated == false)
    }

    // ---------- GET …/github/issues/{number} ----------

    @Test func issueDetailDecodesCommentsOldestFirst() throws {
        let response = try decode(GitHubIssueDetailResponse.self, """
        {"available": true, "repo": "o/n", "issue": {
            "number": 7, "title": "Bug: crash", "state": "open",
            "body_markdown": "steps to repro", "author_login": "reporter",
            "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p1", "color": "0075ca"}],
            "assignee": "octocat",
            "assignees": ["octocat", "hubot"],
            "updated_at": "2026-07-03T00:00:00Z", "created_at": "2026-07-01T00:00:00Z",
            "html_url": "https://github.com/o/n/issues/7",
            "comments_count": 2, "comments": [
                {"author_login": "a", "body_markdown": "first (older)", "created_at": "2026-07-01T00:00:00Z"},
                {"author_login": "b", "body_markdown": "second (newer)", "created_at": "2026-07-02T00:00:00Z"}
            ]
        }}
        """)
        let issue = try #require(response.issue)
        #expect(issue.bodyMarkdown == "steps to repro")
        #expect(issue.labels.map(\.name) == ["bug", "p1"])
        #expect(issue.labels.map(\.color) == ["d73a4a", "0075ca"])
        #expect(issue.assignee == "octocat")
        #expect(issue.assignees == ["octocat", "hubot"])
        #expect(issue.comments.map(\.bodyMarkdown) == ["first (older)", "second (newer)"])
        #expect(issue.comments.first?.authorLogin == "a")
    }

    @Test func issueDetailWithNoCommentsDecodesEmpty() throws {
        let response = try decode(GitHubIssueDetailResponse.self, """
        {"available": true, "repo": "o/n", "issue": {
            "number": 1, "title": "Quiet", "body_markdown": "", "comments_count": 0, "comments": []
        }}
        """)
        let issue = try #require(response.issue)
        #expect(issue.comments.isEmpty)
        #expect(issue.commentsCount == 0)
        #expect(issue.labels.isEmpty)
    }

    // ---------- detail off states ----------

    @Test(arguments: ["not_found", "rate_limited", "repo_not_connected"])
    func detailOffStateHasNoItem(reason: String) throws {
        let pull = try decode(GitHubPullDetailResponse.self,
            #"{"available": false, "reason": "\#(reason)", "detail": "…", "repo": "o/n"}"#)
        #expect(pull.available == false)
        #expect(pull.pull == nil)
        #expect(pull.reason == reason)

        let issue = try decode(GitHubIssueDetailResponse.self,
            #"{"available": false, "reason": "\#(reason)", "detail": "…", "repo": "o/n"}"#)
        #expect(issue.available == false)
        #expect(issue.issue == nil)
    }

    // ---------- POST …/github/start response ----------

    @Test func startResponseDecodesFreshAndExisting() throws {
        let fresh = try decode(GitHubStartResponse.self, #"{"task_id": "abc-123", "existing": false}"#)
        #expect(fresh.taskId == "abc-123")
        #expect(fresh.existing == false)

        let existing = try decode(GitHubStartResponse.self, #"{"task_id": "abc-123", "existing": true}"#)
        #expect(existing.existing)

        // `existing` absent ⇒ false (older server).
        let bare = try decode(GitHubStartResponse.self, #"{"task_id": "abc-123"}"#)
        #expect(bare.existing == false)
    }
}

// MARK: - start-request body encoding

@Suite struct GitHubStartBodyTests {
    @Test func bodyCarriesKindNumberAndAssignee() {
        let body = OrchaApiClient.startBody(
            kind: "issue", number: 7,
            title: "Bug", bodyExcerpt: "excerpt", htmlUrl: "https://x",
            assigneeAgentId: "agent-1", createdByAgentId: "human-1"
        )
        #expect(body["kind"] as? String == "issue")
        #expect(body["number"] as? Int == 7)
        #expect(body["assignee_agent_id"] as? String == "agent-1")
        #expect(body["created_by_agent_id"] as? String == "human-1")
        #expect(body["body_excerpt"] as? String == "excerpt")
        #expect(body["html_url"] as? String == "https://x")
    }

    @Test func unassignedStartCarriesNilAssignee() {
        // Bare Start (no agent) — the assignee key is present-but-nil so the JSON
        // layer drops it, yielding an unassigned `ready` task server-side.
        let body = OrchaApiClient.startBody(
            kind: "pull", number: 12,
            title: nil, bodyExcerpt: nil, htmlUrl: nil,
            assigneeAgentId: nil, createdByAgentId: "human-1"
        )
        #expect(body["kind"] as? String == "pull")
        // `Any?` stored explicitly nil: the value is `.some(nil)`.
        let assignee = body["assignee_agent_id"] ?? nil
        #expect(assignee == nil)
        // A real POST drops nil keys — proven by round-tripping through the same
        // compactMapValues the client uses.
        let cleaned = body.compactMapValues { $0 }
        #expect(cleaned["assignee_agent_id"] == nil)
        #expect(cleaned["title"] == nil)
        #expect(cleaned["kind"] as? String == "pull")
        #expect(cleaned["number"] as? Int == 12)
    }
}

// MARK: - phase mapping (loading / available:false / loaded)

@Suite struct GitHubHubPhaseTests {
    @Test func availableIssuesBecomeLoaded() {
        let response = GitHubIssuesResponse(available: true, repo: "o/n",
                                            issues: [GitHubIssueRow(number: 1, title: "A")])
        #expect(GitHubHubUx.phase(from: response) == .loaded(repo: "o/n", issues: [GitHubIssueRow(number: 1, title: "A")]))
    }

    @Test func unavailableIssuesBecomeOffState() {
        let response = GitHubIssuesResponse(available: false, reason: "repo_not_connected", detail: "no repo")
        #expect(GitHubHubUx.phase(from: response) == .unavailable(reason: "repo_not_connected", detail: "no repo"))
    }

    @Test func availablePullsBecomeLoaded() {
        let response = GitHubPullsResponse(available: true, repo: "o/n",
                                           pulls: [GitHubPullRow(number: 2, title: "P")])
        #expect(GitHubHubUx.phase(from: response) == .loaded(repo: "o/n", pulls: [GitHubPullRow(number: 2, title: "P")]))
    }

    @Test func availableButMissingItemFallsToOffState() {
        // available:true with no `pull` body (a malformed / partial server response)
        // must degrade to the off state, never crash.
        let response = GitHubPullDetailResponse(available: true, repo: "o/n", reason: nil, detail: nil, pull: nil)
        #expect(GitHubHubUx.phase(from: response) == .unavailable(reason: nil, detail: nil))
    }

    @Test func detailLoadedCarriesItem() {
        let pull = makePull(number: 9)
        let response = GitHubPullDetailResponse(available: true, repo: "o/n", reason: nil, detail: nil, pull: pull)
        #expect(GitHubHubUx.phase(from: response) == .loaded(repo: "o/n", pull: pull))
    }

    @Test func loadedPullsCarriesPageInfoFromResponse() {
        let response = GitHubPullsResponse(
            available: true, repo: "o/n", pulls: [GitHubPullRow(number: 1)],
            page: 2, perPage: 50, totalCount: 137, hasMore: true
        )
        let phase = GitHubHubUx.phase(from: response)
        #expect(phase == .loaded(
            repo: "o/n", pulls: [GitHubPullRow(number: 1)],
            page: .init(page: 2, perPage: 50, totalCount: 137, hasMore: true)
        ))
    }
}

// MARK: - PR filter-row state (author / involvement / q / page)

@Suite struct GitHubPullsFilterStateTests {
    @Test func trimmedAuthorAndQueryTreatWhitespaceAsAbsent() {
        var state = GitHubPullsFilterState()
        state.author = "   "
        state.q = "\n\t "
        #expect(state.trimmedAuthor == nil)
        #expect(state.trimmedQuery == nil)
    }

    @Test func trimmedAuthorAndQueryStripSurroundingWhitespace() {
        var state = GitHubPullsFilterState()
        state.author = "  octocat  "
        state.q = "  fix bug  "
        #expect(state.trimmedAuthor == "octocat")
        #expect(state.trimmedQuery == "fix bug")
    }

    @Test func isFilteringIsFalseForTheBareDefaultState() {
        #expect(GitHubPullsFilterState().isFiltering == false)
    }

    @Test(arguments: [
        { (s: inout GitHubPullsFilterState) in s.author = "octocat" },
        { (s: inout GitHubPullsFilterState) in s.involvement = .assigned },
        { (s: inout GitHubPullsFilterState) in s.involvement = .reviewRequested },
        { (s: inout GitHubPullsFilterState) in s.q = "bug" },
    ] as [(inout GitHubPullsFilterState) -> Void])
    func isFilteringIsTrueWhenAnyFieldIsActive(mutate: (inout GitHubPullsFilterState) -> Void) {
        var state = GitHubPullsFilterState()
        mutate(&state)
        #expect(state.isFiltering)
    }

    @Test func resetToFirstPageOnlyTouchesPage() {
        var state = GitHubPullsFilterState()
        state.author = "octocat"
        state.involvement = .assigned
        state.q = "bug"
        state.page = 5
        let reset = state.resetToFirstPage()
        #expect(reset.page == 1)
        #expect(reset.author == "octocat")
        #expect(reset.involvement == .assigned)
        #expect(reset.q == "bug")
    }
}

// MARK: - server-side query param reconciliation (Open|Mine + filter row)

@Suite struct GitHubPullsQueryParamsTests {
    @Test func openFilterWithNoRowStateSendsNoParams() {
        let params = GitHubHubUx.pullsQueryParams(filter: .open, state: GitHubPullsFilterState(), login: "octocat")
        #expect(params.author == nil)
        #expect(params.involvement == nil)
        #expect(params.q == nil)
    }

    @Test func mineFilterBecomesAuthorEqualsMyLogin() {
        let params = GitHubHubUx.pullsQueryParams(filter: .mine, state: GitHubPullsFilterState(), login: "Octocat")
        // Normalized (trimmed + lowercased) like the existing Mine login handling.
        #expect(params.author == "octocat")
    }

    @Test func mineFilterWithNoKnownLoginSendsNoAuthorParam() {
        // Self-host / unmapped identity: "Mine" can't be answered server-side either
        // — send no author param rather than a bogus one.
        let params = GitHubHubUx.pullsQueryParams(filter: .mine, state: GitHubPullsFilterState(), login: nil)
        #expect(params.author == nil)
    }

    @Test func mineFilterOverridesFreeTypedAuthorText() {
        var state = GitHubPullsFilterState()
        state.author = "someone-else"
        let params = GitHubHubUx.pullsQueryParams(filter: .mine, state: state, login: "octocat")
        #expect(params.author == "octocat")
    }

    @Test func openFilterUsesFreeTypedAuthorVerbatim() {
        var state = GitHubPullsFilterState()
        state.author = "someone-else"
        let params = GitHubHubUx.pullsQueryParams(filter: .open, state: state, login: "octocat")
        #expect(params.author == "someone-else")
    }

    @Test func involvementAndQueryPassThroughIndependentlyOfAuthor() {
        var state = GitHubPullsFilterState()
        state.involvement = .reviewRequested
        state.q = "flaky test"
        let params = GitHubHubUx.pullsQueryParams(filter: .open, state: state, login: "octocat")
        #expect(params.involvement == "review_requested")
        #expect(params.q == "flaky test")
        #expect(params.author == nil)
    }

    @Test func involvementQueryValueMapsToWireStrings() {
        #expect(GitHubHubInvolvement.none.queryValue == nil)
        #expect(GitHubHubInvolvement.assigned.queryValue == "assigned")
        #expect(GitHubHubInvolvement.reviewRequested.queryValue == "review_requested")
    }
}

// MARK: - the "identity lacks github_login" off-state

@Suite struct GitHubInvolvementUnavailableTests {
    @Test func unmappedIdentityShapeSurfacesItsDetail() {
        let response = GitHubPullsResponse(
            available: true, repo: "o/n", detail: "This identity has no linked GitHub login.", pulls: []
        )
        #expect(GitHubHubUx.involvementUnavailableDetail(response) == "This identity has no linked GitHub login.")
    }

    @Test func nonEmptyPullsNeverCountsAsTheUnavailableShape() {
        // available:true with rows and a detail string (unrelated informational
        // detail) must not be mistaken for the unmapped-identity off-state.
        let response = GitHubPullsResponse(
            available: true, repo: "o/n", detail: "note", pulls: [GitHubPullRow(number: 1)]
        )
        #expect(GitHubHubUx.involvementUnavailableDetail(response) == nil)
    }

    @Test func unavailableResponseIsNotTheIdentityShapeEitherWay() {
        let response = GitHubPullsResponse(available: false, reason: "repo_not_connected", detail: "no repo")
        #expect(GitHubHubUx.involvementUnavailableDetail(response) == nil)
    }

    @Test func emptyDetailStringDoesNotCountAsInformative() {
        let response = GitHubPullsResponse(available: true, repo: "o/n", detail: "", pulls: [])
        #expect(GitHubHubUx.involvementUnavailableDetail(response) == nil)
    }
}

// MARK: - pagination accumulation (load more)

@Suite struct GitHubPullsAccumulateTests {
    @Test func firstPageReplacesRatherThanAppends() {
        let existing = [GitHubPullRow(number: 1), GitHubPullRow(number: 2)]
        let incoming = GitHubPullsResponse(available: true, pulls: [GitHubPullRow(number: 99)], page: 1, hasMore: true)
        let (merged, info) = GitHubHubUx.accumulate(existing: existing, incoming: incoming)
        #expect(merged.map(\.number) == [99])
        #expect(info.hasMore)
    }

    @Test func laterPageAppendsOntoExistingRows() {
        let existing = [GitHubPullRow(number: 1), GitHubPullRow(number: 2)]
        let incoming = GitHubPullsResponse(available: true, pulls: [GitHubPullRow(number: 3)], page: 2, hasMore: false)
        let (merged, info) = GitHubHubUx.accumulate(existing: existing, incoming: incoming)
        #expect(merged.map(\.number) == [1, 2, 3])
        #expect(info.hasMore == false)
    }

    @Test func laterPageDeduplicatesByNumber() {
        // A retried page (e.g. after a transient failure) must not double a row
        // that's already on screen from a previous fetch.
        let existing = [GitHubPullRow(number: 1), GitHubPullRow(number: 2)]
        let incoming = GitHubPullsResponse(available: true, pulls: [GitHubPullRow(number: 2), GitHubPullRow(number: 3)], page: 2)
        let (merged, _) = GitHubHubUx.accumulate(existing: existing, incoming: incoming)
        #expect(merged.map(\.number) == [1, 2, 3])
    }

    @Test func incomingPageInfoAlwaysWins() {
        let incoming = GitHubPullsResponse(available: true, pulls: [], page: 3, perPage: 30, totalCount: 61, hasMore: false)
        let (_, info) = GitHubHubUx.accumulate(existing: [GitHubPullRow(number: 1)], incoming: incoming)
        #expect(info.page == 3)
        #expect(info.totalCount == 61)
        #expect(info.hasMore == false)
    }
}

// MARK: - load-more footer caption

@Suite struct GitHubHubLoadMoreCaptionTests {
    @Test func noRowsLoadedYetHidesTheFooter() {
        #expect(GitHubHubUx.loadMoreCaption(loadedCount: 0, totalCount: 100, hasMore: true) == nil)
    }

    @Test func knownTotalShowsNOfApproxTotal() {
        #expect(GitHubHubUx.loadMoreCaption(loadedCount: 30, totalCount: 137, hasMore: true) == "30 of ~137")
    }

    @Test func completeListWithKnownTotalStillShowsCaption() {
        // hasMore false but a total is known — still worth the caption ("that's everything").
        #expect(GitHubHubUx.loadMoreCaption(loadedCount: 137, totalCount: 137, hasMore: false) == "137 of ~137")
    }

    @Test func unknownTotalWithMoreAvailableShowsLoadedCount() {
        #expect(GitHubHubUx.loadMoreCaption(loadedCount: 30, totalCount: nil, hasMore: true) == "30 loaded")
    }

    @Test func unknownTotalWithNoMoreHidesTheFooterEntirely() {
        // Nothing left to load and no total to report — the footer would say nothing useful.
        #expect(GitHubHubUx.loadMoreCaption(loadedCount: 12, totalCount: nil, hasMore: false) == nil)
    }
}

// MARK: - Open / Mine filtering

@Suite struct GitHubHubFilterTests {
    private let issues = [
        GitHubIssueRow(number: 1, title: "mine", assignee: "octocat"),
        GitHubIssueRow(number: 2, title: "theirs", assignee: "hubot"),
        GitHubIssueRow(number: 3, title: "unassigned", assignee: nil),
    ]
    private let pulls = [
        GitHubPullRow(number: 10, title: "review me", requestedReviewers: ["octocat", "hubot"]),
        GitHubPullRow(number: 11, title: "not mine", requestedReviewers: ["hubot"]),
        GitHubPullRow(number: 12, title: "no reviewers", requestedReviewers: []),
    ]

    @Test func openFilterKeepsEverything() {
        #expect(GitHubHubUx.filterIssues(issues, filter: .open, login: "octocat").count == 3)
        #expect(GitHubHubUx.filterPulls(pulls, filter: .open, login: "octocat").count == 3)
    }

    @Test func mineIssuesMatchAssigneeCaseInsensitively() {
        let mine = GitHubHubUx.filterIssues(issues, filter: .mine, login: "OCTOCAT")
        #expect(mine.map(\.number) == [1])
    }

    @Test func minePullsMatchRequestedReviewer() {
        let mine = GitHubHubUx.filterPulls(pulls, filter: .mine, login: "octocat")
        #expect(mine.map(\.number) == [10])
    }

    @Test(arguments: [nil, "", "   "] as [String?])
    func mineWithNoKnownLoginFallsBackToFullList(login: String?) {
        // Self-host / unmapped: "Mine" can't be answered, so it shows everything.
        #expect(GitHubHubUx.filterIssues(issues, filter: .mine, login: login).count == 3)
        #expect(GitHubHubUx.filterPulls(pulls, filter: .mine, login: login).count == 3)
    }
}

// MARK: - checks-chip summary logic

@Suite struct GitHubChecksSummaryTests {
    @Test func noChecksIsTheEmptyPill() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(total: 0))
        #expect(summary.hasChecks == false)
        #expect(summary.verdict == .none)
        #expect(summary.label == "no checks")
    }

    @Test func anyFailingDominates() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 3, failing: 2, pending: 2, total: 7))
        #expect(summary.verdict == .failing)
        #expect(summary.label == "3✓ 2✗ 2•")
    }

    @Test func pendingBeatsPassedWhenNoneFailing() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 3, failing: 0, pending: 1, total: 4))
        #expect(summary.verdict == .pending)
    }

    @Test func allPassedIsPassing() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 4, failing: 0, pending: 0, total: 4))
        #expect(summary.verdict == .passing)
        #expect(summary.label == "4✓")
    }

    @Test func totalWithoutBreakdownStillReportsCount() {
        // total>0 but no per-bucket counts (a lean rollup) — the chip still shows it.
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 0, failing: 0, pending: 0, total: 3))
        #expect(summary.hasChecks)
        #expect(summary.label == "3 checks")
        #expect(summary.verdict == .none)
    }

    // ---------- per-run verdict ----------

    @Test(arguments: [
        ("completed", "success", GitHubHubUx.ChecksSummary.Verdict.passing),
        ("completed", "neutral", .passing),
        ("completed", "skipped", .passing),
        ("completed", "failure", .failing),
        ("completed", "timed_out", .failing),
        ("completed", "cancelled", .failing),
        ("in_progress", nil, .pending),
        ("queued", nil, .pending),
    ] as [(String, String?, GitHubHubUx.ChecksSummary.Verdict)])
    func runVerdictMapsStatusAndConclusion(status: String, conclusion: String?, expected: GitHubHubUx.ChecksSummary.Verdict) {
        let run = GitHubCheckRun(name: "x", status: status, conclusion: conclusion)
        #expect(GitHubHubUx.runVerdict(run) == expected)
    }

    // ---------- merge-state copy ----------

    @Test func mergeStateCopyMapsKnownStates() {
        #expect(GitHubHubUx.mergeStateLabel("clean") == "ready to merge")
        #expect(GitHubHubUx.mergeStateLabel("dirty") == "conflicts")
        #expect(GitHubHubUx.mergeStateLabel("blocked") == "blocked")
        #expect(GitHubHubUx.mergeStateLabel(nil) == nil)
        #expect(GitHubHubUx.mergeStateLabel("unknown") == nil)
        #expect(GitHubHubUx.mergeStateLabel("") == nil)
    }
}

// MARK: - fixtures

private func makePull(number: Int) -> GitHubPullDetail {
    let json = """
    {"number": \(number), "title": "P", "state": "open", "base": "main", "head": "feat",
     "body_markdown": "", "checks": {"total": 0}, "files": {"count": 0, "items": []}}
    """
    return try! JSONDecoder().decode(GitHubPullDetail.self, from: Data(json.utf8))
}


// MARK: - checks progressive fill (PR #223 audit)

/// The PR list route ships `checks: null` on every row and the batch
/// `…/github/checks?numbers=` call fills them in — without this fill the phone never
/// showed a CI chip on any PR row (the portal did).
@Suite struct GitHubChecksFillTests {
    @Test func batchResponseDecodesNumberKeyedRollups() throws {
        let response = try JSONDecoder().decode(GitHubChecksBatchResponse.self, from: Data("""
        {"available": true, "checks": {
            "12": {"passed": 3, "failing": 1, "pending": 0, "total": 4},
            "15": {"passed": 0, "failing": 0, "pending": 2, "total": 2}
        }}
        """.utf8))
        #expect(response.available)
        #expect(response.checks["12"]?.failing == 1)
        #expect(response.checks["15"]?.pending == 2)
        #expect(response.checks["99"] == nil)
    }

    @Test func batchResponseToleratesTheOffStateAndAbsentChecks() throws {
        let off = try JSONDecoder().decode(GitHubChecksBatchResponse.self,
            from: Data(#"{"available": false, "reason": "rate_limited"}"#.utf8))
        #expect(off.available == false && off.checks.isEmpty && off.reason == "rate_limited")
        let empty = try JSONDecoder().decode(GitHubChecksBatchResponse.self,
            from: Data(#"{"available": true, "checks": {}}"#.utf8))
        #expect(empty.available && empty.checks.isEmpty)
    }

    @Test func mergeFillsOnlyTheRowsTheBatchAnswered() {
        let rows = [
            GitHubPullRow(number: 12, title: "a"),
            GitHubPullRow(number: 15, title: "b", checks: GitHubChecks(passed: 1, total: 1)),
            GitHubPullRow(number: 20, title: "c"),
        ]
        let merged = GitHubHubUx.mergeChecks(rows, [
            "12": GitHubChecks(passed: 3, failing: 1, total: 4),
            "77": GitHubChecks(passed: 9, total: 9),   // not on screen — ignored
        ])
        #expect(merged.map(\.number) == [12, 15, 20])   // order + membership untouched
        #expect(merged[0].checks == GitHubChecks(passed: 3, failing: 1, total: 4))
        #expect(merged[1].checks == GitHubChecks(passed: 1, total: 1))  // kept what it had
        #expect(merged[2].checks == GitHubChecks())                    // still "not loaded"
        #expect(GitHubHubUx.mergeChecks(rows, [:]) == rows)
    }

    @Test func batchesSplitAtTheServerCapInOrder() {
        let numbers = Array(1...65)
        let batches = GitHubHubUx.checksBatches(numbers)
        #expect(batches.map(\.count) == [30, 30, 5])
        #expect(batches.flatMap { $0 } == numbers)
        #expect(GitHubHubUx.checksBatches([]).isEmpty)
        #expect(GitHubHubUx.checksBatches([1, 2, 3], max: 2) == [[1, 2], [3]])
    }
}


// MARK: - checks fill: delayed cross-project response guard (PR #223 review)

/// A delayed `…/github/checks` batch from project A must never merge into project
/// B's list after a workspace switch — rows are matched by PR number alone, so two
/// repos both having a PR #12 would show A's CI rollup on B's row. The guard lives
/// in `AppModel.applyGithubChecks(_:from:)`; these tests drive it with the exact
/// delayed-response-after-switch sequence.
@MainActor
@Suite struct GitHubChecksFillGuardTests {
    private func container(_ id: String) -> StoredContainer {
        StoredContainer(
            id: id, displayName: id, baseUrl: "http://\(id).local",
            humanAgentId: nil, humanAlias: nil, pairingToken: nil, remoteBaseUrl: nil
        )
    }

    /// Rows/rollups come through the real decoders (the row types are decode-only).
    private func rows(_ json: String) throws -> [GitHubPullRow] {
        try JSONDecoder().decode([GitHubPullRow].self, from: Data(json.utf8))
    }

    private func rollups(_ json: String) throws -> [String: GitHubChecks] {
        try JSONDecoder().decode([String: GitHubChecks].self, from: Data(json.utf8))
    }

    @Test func delayedBatchFromAnotherProjectIsDiscarded() throws {
        let model = AppModel()
        model.selectedContainer = container("project-b")
        let bRows = try rows(#"[{"number": 12, "title": "B's PR 12"}]"#)
        model.githubPullsPhase = .loaded(repo: "b/repo", pulls: bRows, page: .init())

        // Project A's checks call returns AFTER the switch to B — same PR number.
        let aChecks = try rollups(#"{"12": {"passed": 3, "failing": 1, "total": 4}}"#)
        model.applyGithubChecks(aChecks, from: "project-a", generation: model.githubPullsLoadGeneration)

        #expect(model.githubPullsPhase == .loaded(repo: "b/repo", pulls: bRows, page: .init()))
    }

    @Test func staleGenerationBatchIsDiscardedEvenForTheSameProject() throws {
        // Round 3: an out-of-order same-project reload — the batch belongs to a
        // superseded load (older generation), so it must not merge.
        let model = AppModel()
        model.selectedContainer = container("project-b")
        model.githubPullsLoadGeneration = 4
        let bRows = try rows(#"[{"number": 12, "title": "B's PR 12"}]"#)
        model.githubPullsPhase = .loaded(repo: "b/repo", pulls: bRows, page: .init())

        let staleChecks = try rollups(#"{"12": {"passed": 3, "total": 3}}"#)
        model.applyGithubChecks(staleChecks, from: "project-b", generation: 3)

        #expect(model.githubPullsPhase == .loaded(repo: "b/repo", pulls: bRows, page: .init()))
    }

    @Test func batchForTheStillSelectedProjectMerges() throws {
        let model = AppModel()
        model.selectedContainer = container("project-b")
        let bRows = try rows(#"[{"number": 12, "title": "B's PR 12"}]"#)
        model.githubPullsPhase = .loaded(repo: "b/repo", pulls: bRows, page: .init())

        let bChecks = try rollups(#"{"12": {"passed": 2, "pending": 1, "total": 3}}"#)
        model.applyGithubChecks(bChecks, from: "project-b", generation: model.githubPullsLoadGeneration)

        guard case let .loaded(_, pulls, _) = model.githubPullsPhase else {
            Issue.record("expected .loaded, got \(model.githubPullsPhase)")
            return
        }
        #expect(pulls[0].checks.passed == 2)
        #expect(pulls[0].checks.pending == 1)
        #expect(pulls[0].checks.total == 3)
    }
}


// MARK: - primary list loads: delayed-response races through the REAL load paths (PR #223 round 3)

/// A gated `GitHubHubFetching` fake: every pulls/checks call suspends until the test
/// releases it, so the exact delayed-response orderings from the review are driven
/// through the REAL `loadGithubPulls` / `fillGithubChecks` code, not helper calls.
actor GatedHubFetcher: GitHubHubFetching {
    private var pendingPulls: [(cid: String, cont: CheckedContinuation<GitHubPullsResponse, Never>)] = []
    private var pendingChecks: [(cid: String, cont: CheckedContinuation<GitHubChecksBatchResponse, Never>)] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var gateChecks = false

    func setGateChecks(_ on: Bool) { gateChecks = on }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func notifyWaiters() {
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }

    func githubIssues(_ base: String, _ cid: String) async throws -> GitHubIssuesResponse {
        try decode(GitHubIssuesResponse.self, #"{"available": false}"#)
    }

    func githubPulls(
        _ base: String, _ cid: String,
        author: String?, involvement: String?, q: String?,
        page: Int?, perPage: Int?
    ) async throws -> GitHubPullsResponse {
        await withCheckedContinuation { cont in
            pendingPulls.append((cid, cont))
            notifyWaiters()
        }
    }

    func githubChecks(_ base: String, _ cid: String, numbers: [Int]) async throws -> GitHubChecksBatchResponse {
        if gateChecks {
            return await withCheckedContinuation { cont in
                pendingChecks.append((cid, cont))
                notifyWaiters()
            }
        }
        return try decode(GitHubChecksBatchResponse.self, #"{"available": false}"#)
    }

    func waitForPulls(count: Int) async {
        while pendingPulls.count < count {
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    func pendingChecksCount() -> Int { pendingChecks.count }

    func waitForChecks(count: Int) async {
        while pendingChecks.count < count {
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    func releasePulls(at index: Int, json: String) throws {
        let pending = pendingPulls.remove(at: index)
        pending.cont.resume(returning: try decode(GitHubPullsResponse.self, json))
    }

    func releaseChecks(at index: Int, json: String) throws {
        let pending = pendingChecks.remove(at: index)
        pending.cont.resume(returning: try decode(GitHubChecksBatchResponse.self, json))
    }
}

@MainActor
@Suite struct GitHubHubListRaceTests {
    private func container(_ id: String) -> StoredContainer {
        StoredContainer(
            id: id, displayName: id, baseUrl: "http://\(id).local",
            humanAgentId: nil, humanAlias: nil, pairingToken: nil, remoteBaseUrl: nil
        )
    }

    private func pullsJson(repo: String, title: String, number: Int = 12) -> String {
        #"{"available": true, "repo": "\#(repo)", "pulls": [{"number": \#(number), "title": "\#(title)"}], "items": [{"number": \#(number), "title": "\#(title)"}]}"#
    }

    private func loadedTitles(_ phase: GitHubPullsPhase) -> (repo: String?, titles: [String])? {
        guard case let .loaded(repo, pulls, _) = phase else { return nil }
        return (repo, pulls.map(\.title))
    }

    @Test func delayedListFromAnotherProjectIsDiscarded() async throws {
        let model = AppModel()
        let gate = GatedHubFetcher()
        model.githubFetchOverride = gate

        // A's list request goes out…
        model.selectedContainer = container("project-a")
        let loadA = Task { await model.loadGithubPulls() }
        await gate.waitForPulls(count: 1)

        // …the user switches to B, whose list loads fine…
        model.selectedContainer = container("project-b")
        let loadB = Task { await model.loadGithubPulls() }
        await gate.waitForPulls(count: 2)
        try await gate.releasePulls(at: 1, json: pullsJson(repo: "b/repo", title: "B PR"))
        await loadB.value
        #expect(loadedTitles(model.githubPullsPhase)?.repo == "b/repo")

        // …then A's stale response finally arrives. It must be discarded.
        try await gate.releasePulls(at: 0, json: pullsJson(repo: "a/repo", title: "A PR"))
        await loadA.value
        let result = try #require(loadedTitles(model.githubPullsPhase))
        #expect(result.repo == "b/repo")
        #expect(result.titles == ["B PR"])
    }

    @Test func outOfOrderSameProjectLoadsKeepTheNewest() async throws {
        // Two rapid loads within ONE project (a filter change): the SECOND request
        // resolves first; the first (now stale) resolves after and must be discarded.
        let model = AppModel()
        let gate = GatedHubFetcher()
        model.githubFetchOverride = gate
        model.selectedContainer = container("project-a")

        let firstLoad = Task { await model.loadGithubPulls() }
        await gate.waitForPulls(count: 1)
        let secondLoad = Task { await model.loadGithubPulls() }
        await gate.waitForPulls(count: 2)

        try await gate.releasePulls(at: 1, json: pullsJson(repo: "a/repo", title: "newest"))
        await secondLoad.value
        try await gate.releasePulls(at: 0, json: pullsJson(repo: "a/repo", title: "stale"))
        await firstLoad.value

        #expect(loadedTitles(model.githubPullsPhase)?.titles == ["newest"])
    }

    @Test func staleChecksBatchAfterReloadIsDiscardedAndCurrentOneMerges() async throws {
        // The checks fill rides the load's generation: a batch requested by a
        // superseded load must not merge; the current load's batch must. This also
        // proves the fill runs through the REAL load path (a no-op fill fails it).
        let model = AppModel()
        let gate = GatedHubFetcher()
        await gate.setGateChecks(true)
        model.githubFetchOverride = gate
        model.selectedContainer = container("project-a")

        let firstLoad = Task { await model.loadGithubPulls() }
        await gate.waitForPulls(count: 1)
        try await gate.releasePulls(at: 0, json: pullsJson(repo: "a/repo", title: "first"))
        await firstLoad.value
        await gate.waitForChecks(count: 1) // first load's fill is now in flight

        let secondLoad = Task { await model.loadGithubPulls() }
        await gate.waitForPulls(count: 1)
        try await gate.releasePulls(at: 0, json: pullsJson(repo: "a/repo", title: "second"))
        await secondLoad.value
        await gate.waitForChecks(count: 2) // second load's fill is in flight too

        // The FIRST (stale-generation) batch resolves — it must not touch the list.
        try await gate.releaseChecks(at: 0, json: #"{"available": true, "checks": {"12": {"passed": 9, "total": 9}}}"#)
        while (await gateChecksPending(gate)) > 1 { await Task.yield() }
        await Task.yield()
        let afterStale = try #require(loadedTitles(model.githubPullsPhase))
        #expect(afterStale.titles == ["second"])
        if case let .loaded(_, pulls, _) = model.githubPullsPhase {
            #expect(pulls[0].checks.total == 0) // stale rollup did NOT merge
        }

        // The CURRENT batch resolves — it must merge (kills a no-op fill mutation).
        try await gate.releaseChecks(at: 0, json: #"{"available": true, "checks": {"12": {"passed": 2, "failing": 1, "total": 3}}}"#)
        var merged = false
        for _ in 0..<1000 {
            if case let .loaded(_, pulls, _) = model.githubPullsPhase, pulls[0].checks.total == 3 {
                merged = true
                break
            }
            await Task.yield()
        }
        #expect(merged, "the current load's checks batch never merged")
    }

    private func gateChecksPending(_ gate: GatedHubFetcher) async -> Int {
        await gate.pendingChecksCount()
    }
}
