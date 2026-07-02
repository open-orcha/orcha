import SwiftUI

/// Flow 07 R1 — Requests list: the four binding groups, Done collapsed, expiry chips.
struct RequestsTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let groups: RequestGroups
    @State private var showDone = false

    var body: some View {
        Group {
            if model.snapshot == nil {
                if model.loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) } else { UnreachableState() }
            } else {
                content
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: 10) {
                ConnectionBanners()
                group("Needs your answer", groups.needsYourAnswer)
                group("Waiting on others", groups.waitingOnOthers)
                group("Answered — act on it", groups.answeredActOnIt)
                if !groups.done.isEmpty {
                    HStack {
                        SectionH(title: "Done", count: "\(groups.done.count)")
                        Button(showDone ? "hide" : "show") { showDone.toggle() }
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(p.accent)
                    }
                    if showDone {
                        rows(groups.done)
                    }
                }
                if groups.needsYourAnswer.isEmpty && groups.waitingOnOthers.isEmpty &&
                    groups.answeredActOnIt.isEmpty && groups.done.isEmpty {
                    OrchaCard {
                        Text("You're all caught up — no requests involve you.")
                            .foregroundStyle(p.muted)
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await model.refresh() }
    }

    @ViewBuilder
    private func group(_ title: String, _ requests: [RequestDto]) -> some View {
        if !requests.isEmpty {
            SectionH(title: title, count: "\(requests.count)")
            rows(requests)
        }
    }

    private func rows(_ requests: [RequestDto]) -> some View {
        ForEach(requests) { req in
            NavigationLink(value: WorkspaceRoute.request(req.id)) {
                RequestRowCard(request: req, humanId: model.humanId)
            }
            .buttonStyle(.plain)
        }
    }
}

/// Flow 07 request card: flow row, payload preview, meta row with expiry chip.
struct RequestRowCard: View {
    @Environment(\.palette) private var p
    let request: RequestDto
    let humanId: String?

    var body: some View {
        let expiry = MobileUx.expiryChip(request.expiresAt)
        OrchaCard {
            HStack(spacing: 8) {
                AgentAvatar(alias: request.requesterAlias ?? "?", human: request.requesterId == humanId, size: 30)
                Text("→")
                    .foregroundStyle(p.faint)
                AgentAvatar(
                    alias: request.targetId == nil ? "H" : (request.targetAlias ?? "?"),
                    human: request.targetId == humanId || request.targetId == nil,
                    size: 30
                )
                Text("\(request.requesterId == humanId ? "you" : request.requesterAlias ?? "agent") → \(request.targetId == humanId || request.targetId == nil ? "you" : request.targetAlias ?? "agent")")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(p.text)
                    .lineLimit(1)
            }
            Text(request.payload)
                .font(.system(size: 13))
                .foregroundStyle(p.muted)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            HStack(spacing: 8) {
                StatusPill(status: request.status, domain: .request)
                MetaTag(text: request.type)
                if request.chainDepth > 0 { MetaTag(text: "↳ chain") }
                switch expiry {
                case let .warn(label): MetaTag(text: label, tint: p.warn)
                case .expired: MetaTag(text: "expired", tint: p.danger)
                case nil: EmptyView()
                }
                Spacer()
                Text(MobileUx.agoLabel(request.createdAt) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.faint)
            }
        }
        .opacity(expiry == .expired ? 0.65 : 1)
    }
}
