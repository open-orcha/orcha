import SwiftUI

// Responsibility: Request operator-note, flow-header, and timeline-row components.

struct OperatorNote: View {
    @Environment(\.palette) private var p
    let you: String

    var body: some View {
        OrchaCard(borderColor: p.warn) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "flag.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(p.warn)
                Text("Acting as operator (\(you)). Closing another agent's request needs a reason — it's sent to the owner so they know why.")
                    .font(.system(size: 13))
                    .foregroundStyle(p.muted)
            }
        }
    }
}

/// Flow 07 header card: requester → target avatars with "you" substitution, status
/// pill, "type · opened ago" meta line, and the expiry tag when under 2h / expired.
struct RequestFlowHeader: View {
    @Environment(\.palette) private var p
    let request: RequestDto
    let isRequester: Bool
    let isTarget: Bool
    var agents: [AgentDto] = []

    private var requesterAlias: String? { MobileUx.aliasFor(request.requesterId, in: agents) }
    private var targetAlias: String? { MobileUx.aliasFor(request.targetId, in: agents) }
    private var escalated: Bool { request.status == "open" && MobileUx.isToHuman(request, agents: agents) }

    var body: some View {
        let expiry = MobileUx.expiryChip(request.expiresAt)
        OrchaCard {
            HStack(spacing: 10) {
                AgentAvatar(alias: requesterAlias ?? (isRequester ? "you" : "A"), human: isRequester)
                Text("→").font(.system(size: 17)).foregroundStyle(p.faint)
                AgentAvatar(alias: request.targetId == nil ? "H" : (targetAlias ?? "A"), human: isTarget)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(isRequester ? "you" : (requesterAlias ?? "agent")) → \(isTarget ? "you" : (targetAlias ?? "agent"))")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(p.text)
                    Text(metaLine)
                        .font(.system(size: 13))
                        .foregroundStyle(p.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                RequestStatusPill(status: request.status, escalated: escalated)
            }
            switch expiry {
            case let .warn(label): MetaTag(text: label, tint: p.warn)
            case .expired: MetaTag(text: "expired", tint: p.danger)
            case nil: EmptyView()
            }
        }
    }

    private var metaLine: String {
        [request.type, MobileUx.agoLabel(request.createdAt).map { "opened \($0)" }]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}

/// Flow 07 timeline row — reached dots render accent, unreached border2.
struct TimelineDotRow: View {
    @Environment(\.palette) private var p
    let label: String
    let at: String?
    let reached: Bool

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(reached ? p.accent : p.border2)
                .frame(width: 9, height: 9)
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(reached ? p.text : p.faint)
            Spacer()
            Text(MobileUx.agoLabel(at) ?? "")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(p.faint)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

/// Flow 07 — the shared one-field bottom sheet (respond / reject / nudge /
/// close-with-reason). Mirrors Android's `TextSheet`; dismisses only on success.
