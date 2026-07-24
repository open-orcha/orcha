import SwiftUI

/// Flow 07 — Request detail: flow header, chain context, spawned-task link, payload,
/// response quote, rejection, timeline, and the state×role action matrix. Actions run
/// through bottom sheets (`.medium`/`.large`); terminal closes pop back to the list.
/// A pushed screen — the parent tab owns the NavigationStack.
struct RequestDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
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

    private var request: RequestDto? {
        model.snapshot?.requests.first { $0.id == requestId }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let req = request {
                    detailSections(req)
                } else {
                    OrchaCard {
                        Text("Request not found — refresh the workspace.")
                            .foregroundStyle(p.muted)
                    }
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(16)
        }
        .refreshable { await model.refresh() }
        .navigationTitle("Request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarMenu }
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
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

        RequestFlowHeader(request: req, isRequester: isRequester, isTarget: isTarget, agents: model.snapshot?.agents ?? [])

        if req.parentRequestId != nil {
            OrchaCard {
                Text("↳ part of a request chain (depth \(req.chainDepth))")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            }
        }

        if let tid = req.taskLink?.taskId {
            NavigationLink(value: WorkspaceRoute.task(tid)) {
                OrchaCard {
                    Text("SPAWNED TASK →")
                        .font(p.uiFont(11, .bold)).tracking(0.8)
                        .foregroundStyle(p.violet)
                    Text(req.taskLink?.title ?? tid)
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                        .multilineTextAlignment(.leading)
                }
            }
            .buttonStyle(.plain)
        }

        SectionH(title: "Payload")
        OrchaCard {
            LinkedMessageText(text: req.payload, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                .font(p.uiFont(15))
                .foregroundStyle(p.text)
        }

        if let response = req.response {
            SectionH(title: "Response")
            OrchaCard(borderColor: p.okLine) {
                LinkedMessageText(text: response, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                    .font(p.uiFont(15)).foregroundStyle(p.text2)
            }
        }

        if let rejection = req.rejectionReason {
            SectionH(title: "Rejection")
            OrchaCard(borderColor: p.dangerLine) {
                LinkedMessageText(text: rejection, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                    .font(p.uiFont(15)).foregroundStyle(p.text2)
            }
        }

        SectionH(title: "Timeline")
        timeline(req)

        actionBar(req, isRequester: isRequester, isTarget: isTarget)
    }

    // MARK: timeline (created → accepted → answered → closed/converted)

    private func timeline(_ req: RequestDto) -> some View {
        let s = req.status
        return OrchaCard {
            TimelineDotRow(label: "created", at: req.createdAt, reached: true)
            if ["accepted", "answered", "closed", "converted_to_task"].contains(s) {
                TimelineDotRow(label: "accepted", at: nil, reached: s != "open")
            }
            if req.respondedAt != nil || ["answered", "closed", "converted_to_task"].contains(s) {
                TimelineDotRow(label: "answered", at: req.respondedAt, reached: true)
            }
            if req.closedAt != nil || ["closed", "rejected", "converted_to_task"].contains(s) {
                TimelineDotRow(label: MobileUx.statusCopy(s), at: req.closedAt, reached: true)
            }
        }
    }

    // MARK: action bar (state × role matrix, flow 07 — binding)

    /// Flow 07a — two tiers. TIER 1 "Your move" is role-specific (Respond / Accept·Reject /
    /// Convert). TIER 2 "Operator actions" (Nudge · Close) is universal, computed purely from
    /// status + owner/target identity so it lights up on ANY request the human can see —
    /// including agent↔agent traffic they are no party to.
    @ViewBuilder
    private func actionBar(_ req: RequestDto, isRequester: Bool, isTarget: Bool) -> some View {
        let busy = model.actionInFlight
        let neither = !isRequester && !isTarget
        // Operator-tier visibility (§4). `targetIsYou` is a LITERAL human match (not a null
        // target) — hiding a nudge that would only wake yourself.
        let targetIsYou = req.targetId == model.humanId
        let showClose = ["open", "answered", "accepted"].contains(req.status)
        let showNudge = ["open", "answered"].contains(req.status)
            && !(req.status == "open" && targetIsYou)
            && !(req.status == "answered" && isRequester)
        let closeNeedsReason = req.requesterId != model.humanId

        VStack(spacing: 8) {
            // TIER 1 — Your move (role-specific)
            if req.status == "open" && isTarget && req.type == "info" {
                KitButton(title: "Respond", role: .primary, enabled: !busy) { sheet = .respond }
            }
            if req.status == "open" && isTarget && req.type == "task" {
                HStack(spacing: 8) {
                    KitButton(title: "Accept task", role: .primary, enabled: !busy, action: acceptTask)
                    KitButton(title: "Reject…", role: .dangerTonal, enabled: !busy) { sheet = .reject }
                }
            }
            if req.status == "answered" && isRequester {
                KitButton(title: "Convert to task", role: .tonal, enabled: !busy) { sheet = .convert }
            }

            // Operator note — only when acting on someone else's request (neither role).
            if neither && (showNudge || showClose) {
                OperatorNote(you: model.selectedContainer?.humanAlias ?? "you")
            }

            // TIER 2 — Operator actions (universal)
            if showNudge || showClose {
                HStack(spacing: 8) {
                    if showNudge {
                        KitButton(title: "Nudge", role: .tonal, enabled: !busy) { sheet = .nudge }
                    }
                    if showClose {
                        KitButton(
                            title: "Close",
                            role: closeNeedsReason ? .dangerTonal : .neutral,
                            enabled: !busy
                        ) {
                            if closeNeedsReason { sheet = .closeWithReason } else { showCloseConfirm = true }
                        }
                    }
                }
            }
        }
    }

    // MARK: toolbar menu (escalate — Nudge/Close are now the operator tier, §4)

    @ToolbarContentBuilder
    private var toolbarMenu: some ToolbarContent {
        if let req = request {
            let isRequester = req.requesterId == model.humanId
            if isRequester && ["open", "answered"].contains(req.status) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Escalate", action: escalate)
                    } label: {
                        Image(systemName: "ellipsis.circle")
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
        OrchaCard(borderColor: p.warn) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "flag.fill")
                    .font(p.uiFont(12))
                    .foregroundStyle(p.warn)
                Text("Acting as operator (\(you)). Closing another agent's request needs a reason — it's sent to the owner so they know why.")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            }
        }
    }
}

/// Flow 07 header card: requester → target avatars with "you" substitution, status
/// pill, "type · opened ago" meta line, and the expiry tag when under 2h / expired.
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
        OrchaCard {
            HStack(spacing: 10) {
                AgentAvatar(alias: requesterAlias ?? (isRequester ? "you" : "A"), human: isRequester)
                Text("→").font(p.uiFont(17)).foregroundStyle(p.faint)
                AgentAvatar(alias: request.targetId == nil ? "H" : (targetAlias ?? "A"), human: isTarget)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(isRequester ? "you" : (requesterAlias ?? "agent")) → \(isTarget ? "you" : (targetAlias ?? "agent"))")
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                    Text(metaLine)
                        .font(p.uiFont(13))
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
private struct TimelineDotRow: View {
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
                .font(p.uiFont(13))
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
                            KitButton(
                                title: confirm,
                                role: destructive ? .dangerTonal : .primary,
                                enabled: canConfirm,
                                action: submit
                            )
                            KitButton(title: "Cancel", role: .neutral, enabled: !model.actionInFlight) { dismiss() }
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
                        KitButton(title: "Convert", role: .primary, enabled: canConfirm, action: submit)
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
                .font(p.uiFont(13, .semibold))
                .foregroundStyle(selected ? p.accent : p.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? p.accentSoft : p.surface2, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? p.accentLine : p.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
