import Foundation

/// The granular permission grants (mig 039, identity_routes.GRANTS). Grants are
/// ADDITIVE extras on top of the member role; owners hold all of them implicitly.
enum Grant {
    static let manageKeys = "manage_keys"
    static let manageMembers = "manage_members"
    static let manageRepo = "manage_repo"
    static let manageAutonomy = "manage_autonomy"
    static let manageAgents = "manage_agents"
    static let assignReviewers = "assign_reviewers"
}

/// Pure role/grant gating over the `/api/me` payload — honest UI only; the server
/// still enforces every gate (403). Three lanes, mirroring the web portal:
///   * `trusted == false` (self-host / trust-off): PERMISSIVE — the paired-human
///     convention is unchanged, nothing is gated client-side.
///   * `trusted == true, identity == nil`: signed in but NOT a member of this
///     project — every write affordance is disabled with the honest reason.
///   * resolved member: the viewer role is read-only across the board; grants gate
///     the management controls (owners hold every grant implicitly).
struct Access: Equatable {
    var identity: ActingIdentity?
    var trusted = false

    /// Self-host default — permissive, matching pre-collab behavior byte-for-byte.
    static let selfHost = Access(identity: nil, trusted: false)

    var isViewer: Bool { identity?.memberRole == "viewer" }
    var isOwner: Bool { identity?.memberRole == "owner" }

    /// May the acting human perform plain member writes (verify, plan decisions,
    /// task create, chat/thread sends, request actions)?
    var canWrite: Bool {
        guard trusted else { return true }
        guard let identity else { return false }
        return identity.memberRole != "viewer"
    }

    /// The honest label for a disabled write affordance (nil when writes are allowed).
    var writeDenialReason: String? {
        guard trusted, !canWrite else { return nil }
        if identity == nil {
            return "Your GitHub account isn't a member of this project — ask an owner for an invite."
        }
        return "Your role in this project is viewer — it's read-only."
    }

    /// Does the acting member hold a permission grant? Owners hold every grant
    /// implicitly (has_grant parity). Untrusted lanes stay permissive.
    func holds(_ grant: String) -> Bool {
        guard trusted else { return true }
        guard let identity else { return false }
        if identity.memberRole == "owner" { return true }
        return identity.grants.contains(grant)
    }

    /// A management WRITE needs both the write ban lifted (viewer excluded) and the
    /// named grant — the same owner-or-grant rule as `enforce_grant`.
    func canManage(_ grant: String) -> Bool {
        canWrite && holds(grant)
    }

    /// The honest label for a grant-gated control (nil when the action is allowed).
    func manageDenialReason(_ grant: String, action: String) -> String? {
        guard trusted else { return nil }
        if let reason = writeDenialReason { return reason }
        guard !holds(grant) else { return nil }
        return "\(action) needs the owner role or the \(grantLabel(grant)) permission."
    }

    private func grantLabel(_ grant: String) -> String {
        "'" + grant.replacingOccurrences(of: "_", with: " ") + "'"
    }
}
