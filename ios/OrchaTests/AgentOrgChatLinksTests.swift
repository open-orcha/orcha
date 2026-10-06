import Foundation
import Testing
@testable import Orcha

/// Agent2 slice: portal-link chips in chat markdown, their routing, and the reporting-line
/// editor's pure logic (candidates, loop guard, copy).
struct AgentOrgChatLinksTests {
    private let base = "http://127.0.0.1:8001"
    private let tasks = [TaskDto(id: "abcdef12-0000-0000-0000-000000000000", title: "Fix login")]

    private func links(_ attr: AttributedString) -> [(text: String, url: URL)] {
        attr.runs.compactMap { run in run.link.map { (String(attr.characters[run.range]), $0) } }
    }

    // MARK: chat portal links

    @Test func barePortalPathBecomesInAppChip() throws {
        let attr = ChatMarkdown.inline("Done — see /tasks?task=abcdef12 for **details**.", tasks: tasks, portalBase: base)
        let text = String(attr.characters)
        #expect(text == "Done — see ↗ Open task · Fix login for details.")
        let found = links(attr)
        #expect(found.count == 1)
        let link = try #require(PortalLinks.link(fromURL: found[0].url))
        #expect(link.target == .task("abcdef12"))
    }

    @Test func absolutePortalURLRewritesButOtherHostsStay() {
        let attr = ChatMarkdown.inline(
            "Open \(base)/requests?req=r1 or https://example.com/tasks?task=x",
            tasks: [], portalBase: base
        )
        let text = String(attr.characters)
        #expect(text.contains("↗ Open request r1"))
        #expect(text.contains("https://example.com/tasks?task=x"))
    }

    @Test func markdownLinkToPortalKeepsLabelAndGoesInApp() throws {
        let attr = ChatMarkdown.inline("Read [the plan](/agents?agent=atlas) first", tasks: [], portalBase: base)
        #expect(String(attr.characters) == "Read the plan first")
        let found = links(attr)
        #expect(found.count == 1)
        #expect(found[0].text == "the plan")
        #expect(PortalLinks.link(fromURL: found[0].url)?.target == .agent(alias: "atlas"))
    }

    @Test func externalMarkdownLinkAndInlineCodeAreUntouched() {
        let attr = ChatMarkdown.inline("Run `curl /tasks?task=abc` then [docs](https://example.com)", tasks: [], portalBase: base)
        #expect(String(attr.characters) == "Run curl /tasks?task=abc then docs")
        let found = links(attr)
        #expect(found.count == 1)
        #expect(found[0].url.absoluteString == "https://example.com")
    }

    @Test func taskIdInsidePortalPathStaysInTheChip() {
        let attr = ChatMarkdown.inline("/tasks?task=abcdef12 and abcdef12", tasks: tasks, portalBase: base)
        let found = links(attr)
        #expect(found.count == 2)
        #expect(PortalLinks.link(fromURL: found[0].url) != nil)
        #expect(MobileUx.taskIdFromLinkURL(found[1].url) == tasks[0].id)
    }

    // MARK: routing

    @Test func routesPortalLinksInAppOrToTheBrowser() throws {
        let agents = [(id: "a-1", alias: "atlas")]
        func dest(_ path: String) throws -> PortalLinkRouting.Destination {
            PortalLinkRouting.resolve(
                try #require(PortalLinks.parse(path)), tasks: tasks,
                requestIds: ["req-12345678"], agents: agents, portalBase: base
            )
        }
        #expect(try dest("/tasks?task=abcdef12") == .route(.task(tasks[0].id)))
        #expect(try dest("/requests?req=req-1234") == .route(.request("req-12345678")))
        #expect(try dest("/agents?agent=atlas") == .route(.agent("a-1")))
        #expect(try dest("/github?pr=7") == .route(.githubPull(7)))
        #expect(try dest("/routines") == .browser(URL(string: base + "/routines")!))
        #expect(try dest("/agents?agent=ghost") == .browser(URL(string: base + "/agents?agent=ghost")!))
    }

    // MARK: reporting-line editor

    @Test func candidatesExcludeSelfReportsAndRetiredHumansFirst() {
        let people: [(id: String, isHuman: Bool, retired: Bool)] = [
            ("lead", false, false), ("me", false, false), ("kid", false, false),
            ("grandkid", false, false), ("old", false, true), ("owner", true, false),
        ]
        let ids = AgentOrgUx.managerCandidates(
            for: "me", people: people,
            managerOf: ["me": "lead", "kid": "me", "grandkid": "kid"]
        )
        #expect(ids == ["owner", "lead"])
    }

    @Test func descendantsSurviveLoopsInTheData() {
        let below = AgentOrgUx.descendants(of: "a", managerOf: ["b": "a", "c": "b", "a": "c"])
        #expect(below == ["b", "c"])
    }

    @Test func managerGoneFlagsReportsOfRetiredManagers() {
        let gone = AgentOrgUx.managerGone(live: ["a", "b"], managerOf: ["a": "retired", "b": "a"])
        #expect(gone == ["a"])
    }

    @Test func changeCopyMirrorsTheWeb() {
        #expect(AgentOrgUx.changedToast(alias: "scout", managerAlias: "atlas") == "scout now reports to atlas")
        #expect(AgentOrgUx.changedToast(alias: "scout", managerAlias: nil) == "scout has no manager")
        #expect(AgentOrgUx.serverDetail(#"{"detail":"'a' cannot report to 'b' — that would make a loop in the reporting lines"}"#)?.hasSuffix("reporting lines") == true)
        #expect(AgentOrgUx.serverDetail("Internal Server Error") == nil)
    }

    @Test func decodesReportsToEchoForATopLevelAgent() throws {
        let dto = try JSONDecoder().decode(ReportsToDto.self, from: Data("""
        {"agent_id":"a1","reports_to_agent_id":null,"reports_to_alias":null,"chain":[]}
        """.utf8))
        #expect(dto.reportsToAgentId == nil)
        #expect(dto.chain.isEmpty)
    }
}
