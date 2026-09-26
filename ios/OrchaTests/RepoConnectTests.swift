import Foundation
import Testing
@testable import Orcha

/// GitHub repo-connect (portal `home-github.js` parity): the serialization
/// contract for both endpoints' shapes and the sheet's pure binding-state logic.

@Suite struct GithubDtoDecodeTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // ---------- container payloads carry github_repo ----------

    @Test func containerDtoCarriesGithubRepo() throws {
        let dto = try decode(ContainerDto.self, """
        {"id": "c1", "name": "Demo", "status": "active", "github_repo": "acme/widgets"}
        """)
        #expect(dto.githubRepo == "acme/widgets")
    }

    @Test(arguments: [
        #"{"id": "c1", "name": "Demo", "status": "active", "github_repo": null}"#,
        #"{"id": "c1", "name": "Demo", "status": "active"}"#,   // pre-binding server
    ])
    func containerDtoTreatsNullAndAbsentRepoAsUnbound(json: String) throws {
        let dto = try decode(ContainerDto.self, json)
        #expect(dto.githubRepo == nil)
    }

    @Test func snapshotContainerCarriesGithubRepo() throws {
        let snap = try decode(ContainerSnapshot.self, """
        {"container": {"id": "c1", "name": "Demo", "status": "active",
                       "autonomy_level": "plan", "github_repo": "acme/widgets"},
         "agents": [], "tasks": [], "requests": []}
        """)
        #expect(snap.container.githubRepo == "acme/widgets")
    }

    // ---------- GET /api/github/repos ----------

    @Test func reposPathScopesToTheSelectedProjectViaCid() {
        // The server reads a project's saved PAT ONLY when `cid` is passed (the React
        // client always sends it); an unscoped call lists nothing for a PAT-only project.
        let api = OrchaApiClient()
        #expect(api.githubReposPath(cid: nil) == "/api/github/repos")
        #expect(api.githubReposPath(cid: "c1") == "/api/github/repos?cid=c1")
        #expect(api.githubReposPath(cid: "a b/c") == "/api/github/repos?cid=a%20b%2Fc")
    }

    @Test func reposResponseDecodesTheAvailableShape() throws {
        let response = try decode(GithubReposResponse.self, """
        {"available": true, "repos": [
            {"full_name": "acme/widgets", "private": true,
             "description": "Widget factory", "html_url": "https://github.com/acme/widgets"},
            {"full_name": "acme/site", "private": false,
             "description": null, "html_url": "https://github.com/acme/site"}
        ]}
        """)
        #expect(response.available)
        #expect(response.detail == nil)
        #expect(response.repos.map(\.fullName) == ["acme/widgets", "acme/site"])
        #expect(response.repos[0].isPrivate)
        #expect(response.repos[0].description == "Widget factory")
        #expect(response.repos[0].htmlUrl == "https://github.com/acme/widgets")
        #expect(response.repos[1].isPrivate == false)
        #expect(response.repos[1].description == nil)
    }

    @Test func reposResponseDecodesTheGracefulOffState() throws {
        // No token file (self-hosters without the App) — a 200, never an error.
        let bare = try decode(GithubReposResponse.self, #"{"available": false, "repos": []}"#)
        #expect(bare.available == false)
        #expect(bare.repos.isEmpty)
        #expect(bare.detail == nil)

        // GitHub-side failure adds the user-showable detail string.
        let detailed = try decode(GithubReposResponse.self, """
        {"available": false, "repos": [], "detail": "GitHub returned 401 for installation/repositories"}
        """)
        #expect(detailed.available == false)
        #expect(detailed.detail == "GitHub returned 401 for installation/repositories")
    }

    // ---------- PUT /api/containers/{cid}/github ----------

    @Test func bindingResponseDecodesBoundAndUnbound() throws {
        #expect(try decode(GithubBindingResponse.self, #"{"repo": "acme/widgets"}"#).repo == "acme/widgets")
        #expect(try decode(GithubBindingResponse.self, #"{"repo": null}"#).repo == nil)
    }
}

@Suite struct RepoConnectLogicTests {
    private let repos = [
        GithubRepoDto(fullName: "acme/widgets", isPrivate: true, description: "Widget factory"),
        GithubRepoDto(fullName: "acme/site", description: "Marketing pages"),
        GithubRepoDto(fullName: "beta/tools"),
    ]

    // ---------- response → sheet phase ----------

    @Test func availableResponseBecomesTheReadyList() {
        let phase = RepoConnect.phase(from: GithubReposResponse(available: true, repos: repos))
        #expect(phase == .ready(repos))
    }

    @Test func unavailableResponseBecomesTheOffState() {
        #expect(RepoConnect.phase(from: GithubReposResponse(available: false))
            == .unavailable(detail: nil))
        #expect(RepoConnect.phase(from: GithubReposResponse(available: false, detail: "could not reach GitHub"))
            == .unavailable(detail: "could not reach GitHub"))
    }

    // ---------- search filter ----------

    @Test(arguments: ["", "   "])
    func blankQueryKeepsTheFullList(query: String) {
        #expect(RepoConnect.filter(repos, query: query) == repos)
    }

    @Test func filterMatchesOwnerNameCaseInsensitively() {
        #expect(RepoConnect.filter(repos, query: "ACME").map(\.fullName) == ["acme/widgets", "acme/site"])
        #expect(RepoConnect.filter(repos, query: "tools").map(\.fullName) == ["beta/tools"])
    }

    @Test func filterMatchesDescriptionsToo() {
        #expect(RepoConnect.filter(repos, query: "marketing").map(\.fullName) == ["acme/site"])
    }

    @Test func filterWithNoMatchIsEmpty() {
        #expect(RepoConnect.filter(repos, query: "zzz").isEmpty)
    }
}
