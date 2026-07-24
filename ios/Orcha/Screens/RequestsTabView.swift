import SwiftUI

/// Flow 07 R1 — Requests. Default lens ("Yours") is the four binding groups (needs-you-first).
/// The web-parity lenses (All / Open / Answered / Escalations / Task reqs) surface EVERY
/// container request — including agent↔agent traffic the grouped view drops — with the web's
/// Time|Priority sort and a 15-per-page "Load more" (Issues 1 + 4). Aliases and status glyphs
/// are resolved client-side from the snapshot roster (Issue 1 — no more "?" avatars).
struct RequestsTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let groups: RequestGroups

    /// Persisted (not @State) so the pick survives tab switches, and auto-expanded
    /// when Done is the ONLY populated group — otherwise the screen renders blank
    /// with a lone collapsed "Done" header every time you navigate here.
    @AppStorage("orcha_requests_show_done") private var showDone = false
    @State private var lens: MobileUx.RequestLens = .yours
    @State private var sortKey: MobileUx.RequestSortKey = .time
    @State private var ascending = false                 // web default: time desc (newest first)
    @State private var shown = REQS_PAGE

    private static let REQS_PAGE = 15

    private var agents: [AgentDto] { model.snapshot?.agents ?? [] }

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
                lensChips
                if lens == .yours {
                    groupedView
                } else {
                    flatView
                }
            }
            .padding(16)
        }
        .refreshable { await model.refresh() }
    }

    // MARK: lens chips

    private var lensChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(MobileUx.RequestLens.allCases) { l in
                    FilterChip(label: l.label, on: lens == l) {
                        lens = l
                        shown = Self.REQS_PAGE
                    }
                }
            }
        }
    }

    // MARK: "Yours" — the four binding groups (flow 07)

    @ViewBuilder
    private var groupedView: some View {
        group("Needs your answer", groups.needsYourAnswer)
        group("Waiting on others", groups.waitingOnOthers)
        group("Answered — act on it", groups.answeredActOnIt)
        if !groups.done.isEmpty {
            let doneOnly = groups.needsYourAnswer.isEmpty && groups.waitingOnOthers.isEmpty &&
                groups.answeredActOnIt.isEmpty
            HStack {
                SectionH(title: "Done", count: "\(groups.done.count)")
                Button(showDone ? "hide" : "show") { showDone.toggle() }
                    .font(p.uiFont(11, .bold))
                    .foregroundStyle(p.accent)
            }
            .onAppear { if doneOnly { showDone = true } }
            if showDone {
                rows(groups.done)
            } else if doneOnly {
                OrchaCard {
                    Text("Nothing needs you — your \(groups.done.count) request\(groups.done.count == 1 ? " is" : "s are") all done. Tap “show” to see them.")
                        .foregroundStyle(p.muted)
                }
            }
        }
        if groups.needsYourAnswer.isEmpty && groups.waitingOnOthers.isEmpty &&
            groups.answeredActOnIt.isEmpty && groups.done.isEmpty {
            OrchaCard {
                Text("You're all caught up — no requests involve you. Tap “All” to see every request.")
                    .foregroundStyle(p.muted)
            }
        }
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
                RequestRowCard(request: req, humanId: model.humanId, agents: agents)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: web-parity lenses — flat filtered + sorted + paged list

    private var flatList: [RequestDto] {
        let filtered = MobileUx.filterRequests(model.snapshot?.requests ?? [], lens: lens, agents: agents)
        return MobileUx.sortRequests(filtered, key: sortKey, ascending: ascending)
    }

    @ViewBuilder
    private var flatView: some View {
        let list = flatList
        let visible = Array(list.prefix(shown))
        sortControl(total: list.count)
        if visible.isEmpty {
            OrchaCard {
                Text("No requests match this filter.").foregroundStyle(p.muted)
            }
        }
        ForEach(visible) { req in
            NavigationLink(value: WorkspaceRoute.request(req.id)) {
                RequestRowCard(request: req, humanId: model.humanId, agents: agents)
            }
            .buttonStyle(.plain)
        }
        if list.count > visible.count {
            Button("Load more · \(visible.count) of \(list.count)") { shown += Self.REQS_PAGE }
                .buttonStyle(.plain)
                .font(p.uiFont(13, .bold))
                .foregroundStyle(p.accent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
        }
    }

    private func sortControl(total: Int) -> some View {
        HStack(spacing: 6) {
            SectionH(title: "Requests", count: "\(total)")
            Spacer()
            sortKeyButton("Time", .time)
            sortKeyButton("Priority", .priority)
            Button {
                ascending.toggle()
            } label: {
                Image(systemName: ascending ? "arrow.up" : "arrow.down")
                    .font(p.uiFont(12, .bold))
                    .foregroundStyle(p.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(sortDirectionLabel)
        }
    }

    private func sortKeyButton(_ label: String, _ key: MobileUx.RequestSortKey) -> some View {
        Button {
            guard sortKey != key else { return }
            sortKey = key
            ascending = key == .time ? false : true   // reset to the key's natural default (web)
        } label: {
            Text(label)
                .font(p.uiFont(12, .bold))
                .foregroundStyle(sortKey == key ? p.accent : p.muted)
        }
        .buttonStyle(.plain)
    }

    private var sortDirectionLabel: String {
        switch (sortKey, ascending) {
        case (.time, true): "oldest first"
        case (.time, false): "newest first"
        case (.priority, true): "highest priority first"
        case (.priority, false): "lowest priority first"
        }
    }
}

/// Flow 07 request card: flow row (aliases resolved from the roster), payload preview,
/// meta row with status glyph, type tag, and expiry chip.
struct RequestRowCard: View {
    @Environment(\.palette) private var p
    let request: RequestDto
    let humanId: String?
    var agents: [AgentDto] = []

    private var requesterAlias: String? { MobileUx.aliasFor(request.requesterId, in: agents) }
    private var targetAlias: String? { MobileUx.aliasFor(request.targetId, in: agents) }
    private var escalated: Bool {
        request.status == "open" && MobileUx.isToHuman(request, agents: agents)
    }

    var body: some View {
        let expiry = MobileUx.expiryChip(request.expiresAt)
        let fromLabel = request.requesterId == humanId ? "you" : (requesterAlias ?? "agent")
        let toIsYou = request.targetId == humanId || request.targetId == nil
        let toLabel = toIsYou ? "you" : (targetAlias ?? "agent")
        OrchaCard {
            HStack(spacing: 8) {
                AgentAvatar(alias: requesterAlias ?? fromLabel, human: request.requesterId == humanId, size: 30)
                Text("→")
                    .foregroundStyle(p.faint)
                AgentAvatar(
                    alias: request.targetId == nil ? "H" : (targetAlias ?? "A"),
                    human: toIsYou,
                    size: 30
                )
                Text("\(fromLabel) → \(toLabel)")
                    .font(p.uiFont(15, .semibold))
                    .foregroundStyle(p.text)
                    .lineLimit(1)
            }
            Text(request.payload)
                .font(p.uiFont(13))
                .foregroundStyle(p.muted)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            HStack(spacing: 8) {
                RequestStatusPill(status: request.status, escalated: escalated)
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
