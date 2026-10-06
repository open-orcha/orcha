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
            LazyVStack(alignment: .leading, spacing: LSpace.l) {
                ConnectionBanners()
                lensChips
                if lens == .yours {
                    groupedView
                } else {
                    flatView
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .refreshable { await model.refresh() }
    }

    // MARK: lens chips

    private var lensChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: LSpace.s) {
                ForEach(MobileUx.RequestLens.allCases) { l in
                    LChip(lensLabel(l), selected: lens == l) {
                        lens = l
                        shown = Self.REQS_PAGE
                    }
                }
            }
        }
    }

    /// Web parity copy — the escalations lens reads "To a human".
    private func lensLabel(_ l: MobileUx.RequestLens) -> String {
        l == .escalated ? "To a human" : l.label
    }

    // MARK: "Yours" — the four binding groups (flow 07)

    @ViewBuilder
    private var groupedView: some View {
        group("Needs your answer", groups.needsYourAnswer)
        group("Waiting on others", groups.waitingOnOthers)
        // A Resolve inside its undo window leaves the queue at once (web resolveUndo.ts).
        group("Answered — act on it", groups.answeredActOnIt.filter { !ResolveUndoQueue.shared.isResolving($0.id) })
        if !groups.done.isEmpty {
            let doneOnly = groups.needsYourAnswer.isEmpty && groups.waitingOnOthers.isEmpty &&
                groups.answeredActOnIt.isEmpty
            LSection(
                "Done",
                count: groups.done.count,
                trailing: AnyView(
                    LButton(showDone ? "Hide" : "Show", kind: .ghost, size: .small) { showDone.toggle() }
                )
            ) {
                if showDone {
                    rows(groups.done)
                } else if doneOnly {
                    Text("Nothing needs you — your \(groups.done.count) request\(groups.done.count == 1 ? " is" : "s are") all done. Tap “Show” to see them.")
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                }
            }
            .onAppear { if doneOnly { showDone = true } }
        }
        if groups.needsYourAnswer.isEmpty && groups.waitingOnOthers.isEmpty &&
            groups.answeredActOnIt.isEmpty && groups.done.isEmpty {
            LEmptyState(
                icon: "tray",
                title: "You're all caught up",
                message: "No requests involve you. Tap “All” to see every request."
            )
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ requests: [RequestDto]) -> some View {
        if !requests.isEmpty {
            LSection(title, count: requests.count) {
                rows(requests)
            }
        }
    }

    private func rows(_ requests: [RequestDto]) -> some View {
        RequestListPanel {
            ForEach(requests) { req in
                NavigationLink(value: WorkspaceRoute.request(req.id)) {
                    RequestRowCard(request: req, humanId: model.humanId, agents: agents)
                }
                .buttonStyle(.lRow)
                if req.id != requests.last?.id { LDivider().padding(.leading, 60) }
            }
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
            LEmptyState(icon: "line.3.horizontal.decrease", title: "Nothing here", message: "No requests match this filter.")
        } else {
            rows(visible)
        }
        if list.count > visible.count {
            LButton("Load more · \(visible.count) of \(list.count)", kind: .ghost, size: .small) { shown += Self.REQS_PAGE }
                .frame(maxWidth: .infinity)
        }
    }

    private func sortControl(total: Int) -> some View {
        HStack(spacing: LSpace.xs) {
            Text("Requests").ltype(.meta).foregroundStyle(p.muted)
            Text("\(total)").ltype(.meta).foregroundStyle(p.faint)
            Spacer()
            sortKeyButton("Time", .time)
            sortKeyButton("Priority", .priority)
            Button {
                ascending.toggle()
            } label: {
                Image(systemName: ascending ? "arrow.up" : "arrow.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(p.text2)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
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
                .ltype(.meta)
                .fontWeight(sortKey == key ? .semibold : .regular)
                .foregroundStyle(sortKey == key ? p.text : p.muted)
                .padding(.horizontal, 8)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(sortKey == key ? .isSelected : [])
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

/// One bordered surface holding a run of request rows (hairline-divided).
private struct RequestListPanel<Content: View>: View {
    @Environment(\.palette) private var p
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(p.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 1).allowsHitTesting(false))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// Linear request row: requester avatar with the target avatar tucked bottom-right,
/// the question as the title, "from → to" + kind tag as meta, status glyph + time trailing.
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
    private var fromIsYou: Bool { request.requesterId == humanId }
    private var toIsYou: Bool { request.targetId == humanId || request.targetId == nil }
    private var fromLabel: String { fromIsYou ? "You" : (requesterAlias ?? "agent") }
    private var toLabel: String { toIsYou ? "you" : (targetAlias ?? "agent") }
    private var title: String {
        // Human text only: a legacy combined code-thread payload loses its agent-only blocks.
        let human = InboxRequestText.humanize(payload: request.payload, detail: nil).question
        return human.split(whereSeparator: \.isNewline).first.map(String.init) ?? human
    }

    var body: some View {
        let expiry = MobileUx.expiryChip(request.expiresAt)
        HStack(alignment: .center, spacing: LSpace.m) {
            RequestAvatarPair(
                from: requesterAlias ?? fromLabel, fromHuman: fromIsYou,
                to: request.targetId == nil ? "Human" : (targetAlias ?? "A"), toHuman: toIsYou
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text("\(fromLabel) → \(toLabel)")
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                    LTag(request.type == "task" ? "Task" : "Question")
                    if request.chainDepth > 0 { LTag("↳ chain") }
                    switch expiry {
                    case let .warn(label): LTag(label, tint: p.warn)
                    case .expired: LTag("Expired", tint: p.danger)
                    case nil: EmptyView()
                    }
                }
            }
            Spacer(minLength: LSpace.xs)
            VStack(alignment: .trailing, spacing: 4) {
                LStatusGlyph(status: Self.glyphStatus(request.status, escalated: escalated))
                Text(MobileUx.agoLabel(request.createdAt) ?? "")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
            }
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, LSpace.m)
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .opacity(expiry == .expired ? 0.6 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(fromLabel) to \(toLabel), \(request.type == "task" ? "task request" : "question")")
        .accessibilityValue([escalated ? "to a human" : MobileUx.statusCopy(request.status), MobileUx.agoLabel(request.createdAt)].compactMap { $0 }.joined(separator: ", "))
    }

    /// Request status → the shared Linear status glyph vocabulary.
    /// The request's own status for the glyph (web `StatusIcon` parity); escalated wins.
    static func glyphStatus(_ status: String, escalated: Bool) -> String {
        escalated ? "escalated" : status
    }
}

/// Requester avatar with the target's avatar overlapping bottom-right (web flow avatars).
struct RequestAvatarPair: View {
    @Environment(\.palette) private var p
    let from: String
    let fromHuman: Bool
    let to: String
    let toHuman: Bool
    var size: CGFloat = 32

    var body: some View {
        LAvatar(name: from, isAI: !fromHuman, size: size)
            .overlay(alignment: .bottomTrailing) {
                LAvatar(name: to, isAI: !toHuman, size: size * 0.56)
                    .padding(1.5)
                    .background(p.surface, in: Circle())
                    .offset(x: size * 0.18, y: size * 0.18)
            }
            .padding(.trailing, size * 0.18)
            .padding(.bottom, size * 0.18)
            .accessibilityHidden(true)
    }
}
