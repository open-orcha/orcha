import Foundation
import Testing
@testable import Orcha

/// Collab v1 display selectors + wire contracts: avatar URLs and fallback logic,
/// human-alias resolution, the reviewer de-emphasis rule (web parity), and the
/// `/api/me` / members / reviewer decode shapes.

@Suite struct GithubAvatarURLTests {

    @Test func wellKnownURLForALogin() {
        #expect(
            MobileUx.githubAvatarURL("octocat")?.absoluteString
                == "https://github.com/octocat.png?size=96"
        )
    }

    @Test func nilBlankAndWhitespaceLoginsFallBackToTheLetterTile() {
        #expect(MobileUx.githubAvatarURL(nil) == nil)
        #expect(MobileUx.githubAvatarURL("") == nil)
        #expect(MobileUx.githubAvatarURL("   ") == nil)
    }

    @Test func hostileLoginsArePercentEncoded() {
        let url = MobileUx.githubAvatarURL("a/../b")
        #expect(url?.absoluteString.contains("..") == false)
    }
}

@Suite struct HumanAliasResolutionTests {

    private let agents = [
        AgentDto(id: "a1", alias: "ada", kind: "ai"),
        AgentDto(id: "h1", alias: "kai", kind: "human", githubLogin: "kai-gh", memberRole: "owner"),
        AgentDto(id: "h2", alias: "sam", kind: "human"),   // unmapped human
    ]

    @Test func humanLoginResolvesOnlyForMappedHumans() {
        #expect(MobileUx.humanLogin(alias: "kai", in: agents) == "kai-gh")
        #expect(MobileUx.humanLogin(alias: "sam", in: agents) == nil)
        #expect(MobileUx.humanLogin(alias: "ada", in: agents) == nil)   // AI never gets a face
        #expect(MobileUx.humanLogin(alias: nil, in: agents) == nil)
        #expect(MobileUx.humanLogin(alias: "ghost", in: agents) == nil)
    }

    @Test func isHumanAliasCoversUnmappedHumansToo() {
        #expect(MobileUx.isHumanAlias("kai", in: agents))
        #expect(MobileUx.isHumanAlias("sam", in: agents))
        #expect(!MobileUx.isHumanAlias("ada", in: agents))
        #expect(!MobileUx.isHumanAlias(nil, in: agents))
    }
}

@Suite struct ReviewTagTests {

    private let reviewer = TaskReviewerDto(agentId: "h2", alias: "sam", githubLogin: "sam-gh")
    private var task: TaskDto { TaskDto(id: "t1", title: "T", status: "needs_verification", reviewer: reviewer) }

    @Test func noReviewerNeverTags() {
        let plain = TaskDto(id: "t1", title: "T", status: "needs_verification")
        #expect(MobileUx.reviewTag(for: plain, identity: ActingIdentity(agentId: "h1")) == nil)
    }

    @Test func noIdentityNeverTags() {
        // Trust off / self-host: no identity resolved — the card renders normally.
        #expect(MobileUx.reviewTag(for: task, identity: nil) == nil)
    }

    @Test func theAssignedReviewerSeesTheCardNormally() {
        let me = ActingIdentity(agentId: "h2", memberRole: "member")
        #expect(MobileUx.reviewTag(for: task, identity: me) == nil)
    }

    @Test func ownersSeeTheCardNormally() {
        let owner = ActingIdentity(agentId: "h9", memberRole: "owner")
        #expect(MobileUx.reviewTag(for: task, identity: owner) == nil)
    }

    @Test func anotherMemberGetsTheDeEmphasisTag() {
        let other = ActingIdentity(agentId: "h9", memberRole: "member")
        #expect(MobileUx.reviewTag(for: task, identity: other) == "sam-gh")
    }

    @Test func tagFallsBackToAliasWhenNoLogin() {
        let aliasOnly = TaskDto(
            id: "t1", title: "T", status: "needs_verification",
            reviewer: TaskReviewerDto(agentId: "h2", alias: "sam")
        )
        let other = ActingIdentity(agentId: "h9", memberRole: "member")
        #expect(MobileUx.reviewTag(for: aliasOnly, identity: other) == "sam")
    }
}

@Suite struct IdentityWireContractTests {

    private let decoder = JSONDecoder()

    @Test func meResponseDecodesTheServerShape() throws {
        let json = """
        {"identity": {"agent_id": "h1", "alias": "kai", "github_login": "kai-gh",
                      "member_role": "member", "grants": ["assign_reviewers"],
                      "avatar_url": "https://github.com/kai-gh.png"},
         "trusted": true}
        """
        let me = try decoder.decode(MeResponse.self, from: Data(json.utf8))
        #expect(me.trusted)
        #expect(me.identity?.agentId == "h1")
        #expect(me.identity?.githubLogin == "kai-gh")
        #expect(me.identity?.grants == ["assign_reviewers"])
    }

    @Test func meResponseDecodesTheNullIdentityLanes() throws {
        let selfHost = try decoder.decode(MeResponse.self, from: Data(#"{"identity": null, "trusted": false}"#.utf8))
        #expect(selfHost.identity == nil)
        #expect(!selfHost.trusted)
        let nonMember = try decoder.decode(MeResponse.self, from: Data(#"{"identity": null, "trusted": true}"#.utf8))
        #expect(nonMember.identity == nil)
        #expect(nonMember.trusted)
    }

    @Test func membersResponseDecodesRosterAndRestriction() throws {
        let json = """
        {"members": [{"agent_id": "h1", "alias": "kai", "github_login": "kai-gh",
                      "member_role": "owner", "grants": [], "pending": false},
                     {"agent_id": "h2", "alias": "sam", "github_login": "sam-gh",
                      "member_role": "viewer", "grants": ["manage_members"], "pending": true}],
         "restricted": true}
        """
        let response = try decoder.decode(MembersResponse.self, from: Data(json.utf8))
        #expect(response.restricted)
        #expect(response.members.count == 2)
        #expect(response.members[1].pending)
        #expect(response.members[1].grants == ["manage_members"])
    }

    @Test func taskRowCarriesTheReviewerChip() throws {
        let json = """
        {"id": "t1", "title": "T", "status": "needs_verification",
         "reviewer_agent_id": "h2",
         "reviewer": {"agent_id": "h2", "alias": "sam", "github_login": "sam-gh"}}
        """
        let task = try decoder.decode(TaskDto.self, from: Data(json.utf8))
        #expect(task.reviewerAgentId == "h2")
        #expect(task.reviewer?.githubLogin == "sam-gh")
    }

    @Test func agentRowCarriesGithubIdentity() throws {
        let json = """
        {"id": "h1", "alias": "kai", "kind": "human",
         "github_login": "kai-gh", "member_role": "owner"}
        """
        let agent = try decoder.decode(AgentDto.self, from: Data(json.utf8))
        #expect(agent.githubLogin == "kai-gh")
        #expect(agent.memberRole == "owner")
    }
}
