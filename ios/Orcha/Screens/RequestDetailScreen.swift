import SwiftUI

/// Flow 07 — Request detail: flow header, chain context, spawned-task link, payload,
/// response quote, rejection, timeline, and the state×role action matrix. Actions run
/// through bottom sheets (`.medium`/`.large`); terminal closes pop back to the list.
/// A pushed screen — the parent tab owns the NavigationStack.
struct RequestDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let requestId: String

    private enum Sheet: Identifiable {
        case respond, reject, convert, nudge, closeWithReason
        var id: Self { self }
    }
    @State private var sheet: Sheet?
    /// Flow 07a — owner-close (no reason needed) confirms via a dialog, not a sheet.
    @State private var showCloseConfirm = false
    /// GH #140 — a tapped task-id link in the payload/response/rejection text pushes here.
    @State private var linkedTaskId: String?
    /// Portal-link chips that open in the app (task / request / agent / GitHub).
    @State private var portalRoute: WorkspaceRoute?
    /// Fields the snapshot row leaves out: `detail` (auto-resolve, display title, code
    /// thread) and close attribution. `agent_payload` is decoded there but never shown.
    @State private var extras: InboxRequestExtrasDto?
    private var undo: ResolveUndoQueue { .shared }

    private var request: RequestDto? {
        model.snapshot?.requests.first { $0.id == requestId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                if let req = request {
                    detailSections(req)
                } else {
                    LEmptyState(icon: "questionmark.bubble", title: "Request not found", message: "Refresh the workspace.")
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .refreshable { await model.refresh() }
        .navigationTitle("Request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarMenu }
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        .navigationDestination(item: $portalRoute) { route in portalDestination(route) }
        .overlay(alignment: .bottom) { resolveUndoToast }
        .task(id: "\(requestId)|\(request?.status ?? "")") { await loadExtras() }
        .sheet(item: $sheet) { which in sheetView(which) }
        .confirmationDialog("Close this request?", isPresented: $showCloseConfirm, titleVisibility: .visible) {
            Button("Close request", role: .destructive, action: closeNow)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The owner sees it closed on the next sync.")
        }
    }

    // MARK: sections

    @ViewBuilder
    private func detailSections(_ req: RequestDto) -> some View {
        let isRequester = req.requesterId == model.humanId
        let isTarget = req.targetId == model.humanId || req.targetId == nil
        let tasks = model.snapshot?.tasks ?? []
        let agents = model.snapshot?.agents ?? []

        RequestFlowHeader(request: req, isRequester: isRequester, isTarget: isTarget, agents: agents)

        // The question itself — the clean title + any further lines as body.
        let human = InboxRequestText.humanize(payload: req.payload, detail: extras?.detail)
        RequestQuestion(
            payload: human.question, displayTitle: human.title, tasks: tasks,
            portalBase: portalBase, onTapPortal: openPortal, onTapTask: { linkedTaskId = $0 }
        )

        RequestLinkChips(
            portalLinks: portalLinks(req, human: human),
            externalTexts: [human.question, req.response, req.rejectionReason].compactMap { $0 },
            portalBase: portalBase,
            tasks: tasks,
            onTap: openPortal
        )

        if req.status == "closed", let auto = InboxRequestText.autoResolvedCopy(extras?.detail?.autoResolved) {
            Label(auto, systemImage: "checkmark.circle")
                .ltype(.meta)
                .foregroundStyle(p.ok)
        }

        if req.parentRequestId != nil {
            Label("Part of a request chain · depth \(req.chainDepth)", systemImage: "arrow.turn.down.right")
                .ltype(.meta)
                .foregroundStyle(p.muted)
        }

        if let tid = req.taskLink?.taskId {
            NavigationLink(value: WorkspaceRoute.task(tid)) {
                LCard {
                    HStack(spacing: LSpace.s) {
                        LStatusGlyph(status: "in_progress")
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Spawned task").ltype(.micro).foregroundStyle(p.muted)
                            Text(req.taskLink?.title ?? tid)
                                .ltype(.bodyEmph)
                                .foregroundStyle(p.text)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(p.faint)
                            .accessibilityHidden(true)
                    }
                }
            }
            .buttonStyle(.plain)
        }

        if let response = req.response {
            AnswerCard(
                responder: isTarget && req.targetId != nil ? "You" : (MobileUx.aliasFor(req.targetId, in: agents) ?? "Agent"),
                responderIsHuman: isTarget,
                answeredAgo: MobileUx.agoLabel(req.respondedAt),
                text: response,
                tasks: tasks,
                resolving: undo.isResolving(req.id),
                portalBase: portalBase,
                onTapPortal: openPortal,
                onTapTask: { linkedTaskId = $0 }
            ) {
                answerActions(req, isRequester: isRequester)
            }
        }

        if let rejection = req.rejectionReason {
            LCard {
                Label("Rejected", systemImage: "xmark.circle")
                    .ltype(.micro)
                    .foregroundStyle(p.danger)
                LinkedMessageText(text: rejection, tasks: tasks, onTapTask: { linkedTaskId = $0 }, portalBase: portalBase, onTapPortal: openPortal)
                    .ltype(.body)
                    .foregroundStyle(p.text2)
            }
        }

        if !undo.isResolving(req.id) {
            actionBar(req, isRequester: isRequester, isTarget: isTarget)
        }

        LSection("Activity") {
            timeline(req)
        }
    }

    // MARK: timeline (created → accepted → answered → closed/converted)

    private func timeline(_ req: RequestDto) -> some View {
        let s = req.status
        return VStack(alignment: .leading, spacing: 0) {
            TimelineDotRow(label: "Created", at: req.createdAt, reached: true)
            if ["accepted", "answered", "closed", "converted_to_task"].contains(s) {
                TimelineDotRow(label: "Accepted", at: nil, reached: s != "open")
            }
            if req.respondedAt != nil || ["answered", "closed", "converted_to_task"].contains(s) {
                TimelineDotRow(label: "Answered", at: req.respondedAt, reached: true)
            }
            if req.closedAt != nil || ["closed", "rejected", "converted_to_task"].contains(s) {
                TimelineDotRow(label: closedTimelineLabel(req), at: req.closedAt ?? req.respondedAt, reached: true)
            }
        }
    }

    // MARK: answer card actions (requester, answered — Resolve primary, Turn into a task)

    @ViewBuilder
    private func answerActions(_ req: RequestDto, isRequester: Bool) -> some View {
        if req.status == "answered" && isRequester && undo.isResolving(req.id) {
            HStack(spacing: LSpace.s) {
                LButton("Undo", icon: "arrow.uturn.backward", size: .small) { undoResolve(req.id) }
                Text("Leaves every queue now; the close is sent in a few seconds unless you undo.")
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
            }
        } else if req.status == "answered" && isRequester {
            let busy = model.actionInFlight
            HStack(spacing: LSpace.s) {
                LButton("Resolve", icon: "checkmark", kind: .primary, size: .small) { resolve(req.id) }
                    .disabled(busy)
                LButton("Turn into a task", icon: "arrow.triangle.branch", size: .small) { sheet = .convert }
                    .disabled(busy)
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: action bar (state × role matrix, flow 07 — binding)

    /// Flow 07a — two tiers. TIER 1 "Your move" is role-specific (Respond / Accept·Reject;
    /// the requester's Resolve / Turn-into-a-task live on the answer card). TIER 2
    /// "Operator actions" (Nudge · Close) is universal, computed purely from status +
    /// owner/target identity so it lights up on ANY request the human can see —
    /// including agent↔agent traffic they are no party to.
    @ViewBuilder
    private func actionBar(_ req: RequestDto, isRequester: Bool, isTarget: Bool) -> some View {
        let busy = model.actionInFlight
        let neither = !isRequester && !isTarget
        // Operator-tier visibility (§4). `targetIsYou` is a LITERAL human match (not a null
        // target) — hiding a nudge that would only wake yourself.
        let targetIsYou = req.targetId == model.humanId
        // The requester's answered-close is the answer card's "Resolve".
        let resolvedOnCard = req.status == "answered" && isRequester && req.response != nil
        let showClose = ["open", "answered", "accepted"].contains(req.status) && !resolvedOnCard
        let showNudge = ["open", "answered"].contains(req.status)
            && !(req.status == "open" && targetIsYou)
            && !(req.status == "answered" && isRequester)
        let closeNeedsReason = req.requesterId != model.humanId

        VStack(alignment: .leading, spacing: LSpace.s) {
            // TIER 1 — Your move (role-specific)
            // Respond shares its row with the operator tier (Linear: one action bar,
            // one primary). It needs isTarget, so the operator note never splits them.
            let respondInline = req.status == "open" && isTarget && req.type == "info"
            if req.status == "open" && isTarget && req.type == "task" {
                HStack(spacing: LSpace.s) {
                    LButton("Accept task", icon: "checkmark", kind: .primary, action: acceptTask)
                        .disabled(busy)
                    LButton("Reject…", kind: .danger) { sheet = .reject }
                        .disabled(busy)
                }
            }
            if req.status == "answered" && isRequester && req.response == nil {
                LButton("Turn into a task", icon: "arrow.triangle.branch") { sheet = .convert }
                    .disabled(busy)
            }

            // Operator note — only when acting on someone else's request (neither role).
            if neither && (showNudge || showClose) {
                OperatorNote(you: model.selectedContainer?.humanAlias ?? "you")
            }

            // TIER 2 — Operator actions (universal)
            if respondInline || showNudge || showClose {
                HStack(spacing: LSpace.s) {
                    if respondInline {
                        LButton("Respond", icon: "arrowshape.turn.up.left", kind: .primary) { sheet = .respond }
                            .disabled(busy)
                    }
                    if showNudge {
                        LButton("Nudge", icon: "bell", kind: .secondary, size: respondInline ? .regular : .small) { sheet = .nudge }
                            .disabled(busy)
                    }
                    if showClose {
                        LButton("Close", icon: "xmark", kind: .ghost, size: respondInline ? .regular : .small) {
                            if closeNeedsReason { sheet = .closeWithReason } else { showCloseConfirm = true }
                        }
                        .disabled(busy)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: toolbar menu (escalate — Nudge/Close are now the operator tier, §4)

    @ToolbarContentBuilder
    private var toolbarMenu: some ToolbarContent {
        if let req = request {
            let isRequester = req.requesterId == model.humanId
            if isRequester && ["open", "answered"].contains(req.status) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Escalate to a human", action: escalate)
                    } label: {
                        Label("Request actions", systemImage: "ellipsis.circle")
                            .labelStyle(.iconOnly)
                    }
                }
            }
        }
    }

    // MARK: sheets

    @ViewBuilder
    private func sheetView(_ which: Sheet) -> some View {
        switch which {
        case .respond:
            RequestTextSheet(
                kicker: "RESPOND", title: request?.payload ?? "",
                label: "Your answer", required: true, confirm: "Respond"
            ) { text in
                await model.respondRequest(requestId, response: text)
            }
        case .reject:
            RequestTextSheet(
                kicker: "REJECT TASK REQUEST", title: request?.payload ?? "",
                label: "Why not? (required)", required: true, confirm: "Reject", destructive: true
            ) { text in
                await model.rejectTaskRequest(requestId, reason: text)
            }
        case .nudge:
            RequestTextSheet(
                kicker: "NUDGE", title: nudgeSubcopy,
                label: "Note (optional)", required: false, confirm: "Nudge"
            ) { text in
                await model.nudgeRequest(requestId, note: text.isEmpty ? nil : text)
            }
        case .closeWithReason:
            RequestTextSheet(
                kicker: "CLOSE REQUEST", title: closeReasonSubcopy,
                label: "Reason (required)", required: true, confirm: "Close", destructive: true
            ) { reason in
                let ok = await model.closeRequest(requestId, reason: reason)
                if ok { dismiss() }
                return ok
            }
        case .convert:
            ConvertSheet(requestId: requestId)
        }
    }

    // MARK: actions

    private func acceptTask() {
        Task { _ = await model.acceptTaskRequest(requestId, note: nil) }
    }

    private func closeNow() {
        Task { if await model.closeRequest(requestId, reason: nil) { dismiss() } }
    }

    private func escalate() {
        Task { _ = await model.escalateRequest(requestId, reason: nil) }
    }

    /// One tap, no dialog: the close is deferred for the undo window (web resolveUndo.ts).
    private func resolve(_ id: String) {
        let model = model
        undo.schedule(id) {
            _ = await model.closeRequest(id, reason: nil)
        }
    }

    private func undoResolve(_ id: String) {
        if undo.undo(id) { model.toast = "Kept open" }
    }

    // MARK: resolve undo toast

    @ViewBuilder
    private var resolveUndoToast: some View {
        if undo.isResolving(requestId) {
            HStack(spacing: LSpace.m) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(p.ok)
                    .accessibilityHidden(true)
                Text("Resolved")
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                Spacer(minLength: 0)
                Button("Undo") { undoResolve(requestId) }
                    .font(p.uiFont(14, .semibold))
                    .foregroundStyle(p.accent)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .padding(.horizontal, LSpace.l)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(p.border2, lineWidth: 1))
            .padding(.horizontal, LSpace.l)
            .padding(.bottom, LSpace.m)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
            .onAppear {
                UIAccessibility.post(notification: .announcement, argument: "Resolved. Undo available for 5 seconds.")
            }
        }
    }

    // MARK: request extras + portal links

    private var portalBase: String? { model.selectedContainer?.baseUrl }

    private func loadExtras() async {
        guard let sel = model.selectedContainer, let req = request else { return }
        do {
            let list = try await model.api.inboxRequestExtras(sel.baseUrl, sel.id, status: req.status)
            extras = list.requests.first { $0.id == requestId }
        } catch {
            // Extras only enrich the screen (titles, auto-resolve copy) — the snapshot row still renders.
        }
    }

    private func closedTimelineLabel(_ req: RequestDto) -> String {
        if req.status == "closed" {
            if let auto = InboxRequestText.autoResolvedCopy(extras?.detail?.autoResolved) { return auto }
            if extras != nil {
                return InboxRequestText.closedCopy(closedBy: extras?.closedByAlias, reason: extras?.closeDecision?.reason)
            }
        }
        return MobileUx.statusCopy(req.status).capitalized
    }

    private func portalLinks(_ req: RequestDto, human: InboxRequestText.Human) -> [PortalLink] {
        var links = PortalLinks.links(
            in: [human.question, req.response, req.rejectionReason].compactMap { $0 },
            baseURL: portalBase
        )
        if let thread = human.threadLink, let link = PortalLinks.parse(thread),
           !links.contains(where: { $0.path == link.path }) {
            links.insert(link, at: 0)
        }
        return links
    }

    private func openPortal(_ link: PortalLink) {
        switch link.target {
        case let .task(id):
            let tasks = model.snapshot?.tasks ?? []
            linkedTaskId = MobileUx.resolveTaskRef(id, in: tasks)?.id ?? id
        case let .request(id):
            let match = model.snapshot?.requests.first { $0.id == id || $0.id.hasPrefix(id) }
            portalRoute = .request(match?.id ?? id)
        case let .agent(alias):
            if let agent = model.snapshot?.agents.first(where: { $0.alias == alias }) {
                portalRoute = .agent(agent.id)
            } else if let url = link.absoluteURL(base: portalBase) {
                openURL(url)
            }
        case let .githubPull(n): portalRoute = .githubPull(n)
        case let .githubIssue(n): portalRoute = .githubIssue(n)
        case .web:
            if let url = link.absoluteURL(base: portalBase) { openURL(url) }
        }
    }

    @ViewBuilder
    private func portalDestination(_ route: WorkspaceRoute) -> some View {
        OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
            switch route {
            case let .task(id): TaskDetailScreen(taskId: id)
            case let .request(id): RequestDetailScreen(requestId: id)
            case let .agent(id): AgentDetailScreen(agentId: id)
            case let .githubPull(n): GitHubPullDetailScreen(number: n)
            case let .githubIssue(n): GitHubIssueDetailScreen(number: n)
            default: EmptyView()
            }
        }
    }

    // MARK: state-routed sheet copy (§5)

    /// Nudge sub-copy names who wakes: open → the target (owes the answer); answered → the
    /// requester (must act on it or close it).
    private var nudgeSubcopy: String {
        guard let req = request else { return "Wake whoever owes the next action." }
        let agents = model.snapshot?.agents ?? []
        if req.status == "answered" {
            let who = MobileUx.aliasFor(req.requesterId, in: agents) ?? "the requester"
            return "Wakes \(who) — they must act on the answer or close it."
        }
        let who = MobileUx.aliasFor(req.targetId, in: agents) ?? "the target"
        return "Wakes \(who) — they still owe an answer."
    }

    /// Forced-close reason helper names the owner it's routed to.
    private var closeReasonSubcopy: String {
        let who = MobileUx.aliasFor(request?.requesterId, in: model.snapshot?.agents ?? []) ?? "the owner"
        return "Closing \(who)'s request needs a reason — it's sent to them so they know why."
    }
}

/// Flow 07a — the operator note above the operator-action tier, shown only when the human
/// is neither requester nor target. Mirrors the portal's "Arbitrating as {alias}…" banner.
private struct OperatorNote: View {
    @Environment(\.palette) private var p
    let you: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
            Image(systemName: "flag")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(p.warn)
                .accessibilityHidden(true)
            Text("Acting as operator (\(you)). Closing another agent's request needs a reason — it's sent to the owner so they know why.")
                .ltype(.meta)
                .foregroundStyle(p.muted)
        }
    }
}

/// Flow 07 header: requester → target avatars with "you" substitution, kind tag,
/// "opened ago", status glyph, and the expiry tag when under 2h / expired.
private struct RequestFlowHeader: View {
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
        HStack(spacing: LSpace.s) {
            RequestAvatarPair(
                from: requesterAlias ?? (isRequester ? "You" : "A"), fromHuman: isRequester,
                to: request.targetId == nil ? "Human" : (targetAlias ?? "A"), toHuman: isTarget,
                size: 24
            )
            Text("\(isRequester ? "You" : (requesterAlias ?? "agent")) → \(isTarget ? "you" : (targetAlias ?? "agent"))")
                .ltype(.meta)
                .foregroundStyle(p.text2)
                .lineLimit(1)
            LTag(request.type == "task" ? "Task" : "Question")
            switch expiry {
            case let .warn(label): LTag(label, tint: p.warn)
            case .expired: LTag("Expired", tint: p.danger)
            case nil: EmptyView()
            }
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                LStatusGlyph(status: RequestRowCard.glyphStatus(request.status, escalated: escalated), size: 12)
                Text(escalated ? "To a human" : MobileUx.statusCopy(request.status).capitalized)
                    .ltype(.micro)
                    .foregroundStyle(p.text2)
            }
        }
        .accessibilityElement(children: .combine)
        if let opened = MobileUx.agoLabel(request.createdAt) {
            Text("Opened \(opened)")
                .ltype(.micro)
                .foregroundStyle(p.faint)
                .padding(.top, -LSpace.s)
        }
    }
}

/// The request's question: first line as the clean title, the rest as body text.
private struct RequestQuestion: View {
    @Environment(\.palette) private var p
    let payload: String
    /// A stored display title (code-thread questions) — then the whole payload is the body.
    var displayTitle: String?
    let tasks: [TaskDto]
    var portalBase: String?
    var onTapPortal: ((PortalLink) -> Void)?
    let onTapTask: (String) -> Void

    private var parts: (title: String, rest: String?) {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        if let displayTitle { return (displayTitle, trimmed.isEmpty ? nil : trimmed) }
        guard let nl = trimmed.firstIndex(where: \.isNewline) else { return (trimmed, nil) }
        let rest = trimmed[nl...].trimmingCharacters(in: .whitespacesAndNewlines)
        return (String(trimmed[..<nl]), rest.isEmpty ? nil : rest)
    }

    var body: some View {
        let (title, rest) = parts
        VStack(alignment: .leading, spacing: LSpace.s) {
            LinkedMessageText(text: title, tasks: tasks, onTapTask: onTapTask, portalBase: portalBase, onTapPortal: onTapPortal)
                .ltype(.title)
                .foregroundStyle(p.text)
                .accessibilityAddTraits(.isHeader)
            if let rest {
                LinkedMessageText(text: rest, tasks: tasks, onTapTask: onTapTask, portalBase: portalBase, onTapPortal: onTapPortal)
                    .ltype(.body)
                    .foregroundStyle(p.text2)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Atlas answered · 1m ago" — the answer card, with the requester's actions inside.
private struct AnswerCard<Actions: View>: View {
    @Environment(\.palette) private var p
    let responder: String
    let responderIsHuman: Bool
    let answeredAgo: String?
    let text: String
    let tasks: [TaskDto]
    /// Inside the Resolve undo window: the card reads "Resolved" and offers only Undo.
    var resolving = false
    var portalBase: String?
    var onTapPortal: ((PortalLink) -> Void)?
    let onTapTask: (String) -> Void
    @ViewBuilder var actions: Actions

    var body: some View {
        LCard(padding: LSpace.l) {
            VStack(alignment: .leading, spacing: LSpace.m) {
                HStack(spacing: 6) {
                    if resolving {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(p.ok)
                            .accessibilityHidden(true)
                        Text("Resolved").ltype(.bodyEmph).foregroundStyle(p.text)
                    } else {
                        LAvatar(name: responder, isAI: !responderIsHuman, size: 20)
                            .accessibilityHidden(true)
                        Text(responder).ltype(.bodyEmph).foregroundStyle(p.text)
                        Text(["answered", answeredAgo].compactMap { $0 }.joined(separator: " · "))
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                    }
                }
                .accessibilityElement(children: .combine)
                if !resolving {
                    LinkedMessageText(text: text, tasks: tasks, onTapTask: onTapTask, portalBase: portalBase, onTapPortal: onTapPortal)
                        .ltype(.body)
                        .foregroundStyle(p.text)
                        .textSelection(.enabled)
                }
                actions
            }
        }
    }
}

/// Flow 07 activity row — reached dots fill accent, unreached stay hollow.
private struct TimelineDotRow: View {
    @Environment(\.palette) private var p
    let label: String
    let at: String?
    let reached: Bool

    var body: some View {
        HStack(spacing: LSpace.m) {
            Circle()
                .fill(reached ? p.text2 : Color.clear)
                .overlay(Circle().strokeBorder(reached ? p.text2 : p.border2, lineWidth: 1))
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(label)
                .ltype(.meta)
                .foregroundStyle(reached ? p.text2 : p.faint)
            Spacer()
            Text(MobileUx.agoLabel(at) ?? "")
                .ltype(.micro)
                .foregroundStyle(p.faint)
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .combine)
    }
}

/// Flow 07 — the shared one-field bottom sheet (respond / reject / nudge /
/// close-with-reason). Mirrors Android's `TextSheet`; dismisses only on success.
struct RequestTextSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let kicker: String
    let title: String
    let label: String
    let required: Bool
    let confirm: String
    var destructive: Bool = false
    let onConfirm: (String) async -> Bool

    @State private var text = ""

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canConfirm: Bool {
        (!required || !trimmed.isEmpty) && !model.actionInFlight
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(kicker)
                            .font(p.uiFont(11, .bold)).tracking(0.8)
                            .foregroundStyle(destructive ? p.danger : p.accent)
                        Text(title)
                            .font(p.uiFont(15, .semibold))
                            .foregroundStyle(p.text2)
                        TextField(label, text: $text, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(12)
                            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                        HStack(spacing: 8) {
                            LButton(confirm, kind: destructive ? .danger : .primary, action: submit)
                                .disabled(!canConfirm)
                            LButton("Cancel", kind: .ghost) { dismiss() }
                                .disabled(model.actionInFlight)
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() {
        Task { if await onConfirm(trimmed) { dismiss() } }
    }
}

/// Flow 07 — Convert-to-task sheet: Title + DoD + assignee picker (live AI agents),
/// same validation as Create task. Assignee defaults to unassigned.
struct ConvertSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let requestId: String

    @State private var title = ""
    @State private var dod = ""
    @State private var assignee: String?

    private var agents: [String] {
        (model.snapshot?.agents ?? [])
            .filter { $0.kind == "ai" && $0.terminatedAt == nil }
            .map(\.alias)
    }

    private var canConfirm: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !dod.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !model.actionInFlight
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("CONVERT TO TASK")
                            .font(p.uiFont(11, .bold)).tracking(0.8)
                            .foregroundStyle(p.violet)
                        field("Task title", text: $title, multiline: false)
                        field("Definition of done", text: $dod, multiline: true)
                        SectionH(title: "Assign to", count: assignee ?? "unassigned")
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                PillChip(label: "Unassigned", selected: assignee == nil) { assignee = nil }
                                ForEach(agents, id: \.self) { alias in
                                    PillChip(label: alias, selected: assignee == alias) { assignee = alias }
                                }
                            }
                        }
                        LButton("Convert", kind: .primary, action: submit)
                            .disabled(!canConfirm)
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func field(_ label: String, text: Binding<String>, multiline: Bool) -> some View {
        TextField(label, text: text, axis: multiline ? .vertical : .horizontal)
            .lineLimit(multiline ? 3...6 : 1...1)
            .padding(12)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
    }

    private func submit() {
        Task {
            let ok = await model.convertRequest(
                requestId,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                dod: dod.trimmingCharacters(in: .whitespacesAndNewlines),
                assignee: assignee
            )
            if ok { dismiss() }
        }
    }
}

/// A pill chip for assignee / cadence / fresh-chat hint selection (Android's `AssigneeChip`).
struct PillChip: View {
    @Environment(\.palette) private var p
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .ltype(.meta)
                .fontWeight(.medium)
                .foregroundStyle(selected ? p.text : p.text2)
                .padding(.horizontal, 10)
                .frame(minHeight: 28)
                .background(selected ? p.lSelected : p.surface2, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? p.border2 : p.border, lineWidth: 1))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
