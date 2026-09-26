import Foundation
import Testing
@testable import Orcha

/// The pure role/grant gate over `/api/me` (collab v1). Three lanes: self-host
/// permissive, trusted non-member locked, resolved member per role + grants.

private func member(role: String, grants: [String] = []) -> ActingIdentity {
    ActingIdentity(agentId: "h1", alias: "kai", githubLogin: "kai-gh", memberRole: role, grants: grants)
}

@Suite struct AccessSelfHostTests {

    @Test func trustOffIsFullyPermissive() {
        let access = Access.selfHost
        #expect(access.canWrite)
        #expect(access.writeDenialReason == nil)
        #expect(access.holds(Grant.manageAgents))
        #expect(access.canManage(Grant.manageAutonomy))
        #expect(access.manageDenialReason(Grant.manageAutonomy, action: "X") == nil)
    }
}

@Suite struct AccessTrustedNonMemberTests {

    private let access = Access(identity: nil, trusted: true)

    @Test func everyWriteIsLockedWithTheHonestReason() {
        #expect(!access.canWrite)
        #expect(access.writeDenialReason?.contains("member of this project") == true)
    }

    @Test func noGrantResolves() {
        #expect(!access.holds(Grant.manageAgents))
        #expect(!access.canManage(Grant.assignReviewers))
    }
}

@Suite struct AccessViewerTests {

    private let access = Access(identity: member(role: "viewer"), trusted: true)

    @Test func viewerIsReadOnlyAcrossTheBoard() {
        #expect(access.isViewer)
        #expect(!access.canWrite)
        #expect(access.writeDenialReason?.contains("viewer") == true)
    }

    @Test func aGrantOnAViewerNeverUnlocksWrites() {
        // Server parity: a grant on a viewer affects reads only — the write ban
        // is absolute (_forbid_viewer_write).
        let granted = Access(identity: member(role: "viewer", grants: [Grant.manageAutonomy]), trusted: true)
        #expect(granted.holds(Grant.manageAutonomy))
        #expect(!granted.canManage(Grant.manageAutonomy))
        #expect(granted.manageDenialReason(Grant.manageAutonomy, action: "X")?.contains("viewer") == true)
    }
}

@Suite struct AccessMemberAndOwnerTests {

    @Test func plainMemberWritesButHoldsNoManagementGates() {
        let access = Access(identity: member(role: "member"), trusted: true)
        #expect(access.canWrite)
        #expect(access.writeDenialReason == nil)
        #expect(!access.holds(Grant.manageAgents))
        #expect(!access.canManage(Grant.manageKeys))
        #expect(access.manageDenialReason(Grant.manageRepo, action: "Binding the repo")?.contains("manage repo") == true)
    }

    @Test func grantsUnlockExactlyTheNamedGate() {
        let access = Access(identity: member(role: "member", grants: [Grant.assignReviewers]), trusted: true)
        #expect(access.canManage(Grant.assignReviewers))
        #expect(!access.canManage(Grant.manageAgents))
        #expect(access.manageDenialReason(Grant.assignReviewers, action: "X") == nil)
    }

    @Test func ownersHoldEveryGrantImplicitly() {
        let access = Access(identity: member(role: "owner"), trusted: true)
        #expect(access.isOwner)
        for grant in [Grant.manageKeys, Grant.manageMembers, Grant.manageRepo,
                      Grant.manageAutonomy, Grant.manageAgents, Grant.assignReviewers] {
            #expect(access.canManage(grant))
        }
    }
}
