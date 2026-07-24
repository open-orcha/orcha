import SwiftUI

// Responsibility: Request timeline, role-aware action bar, sheets, and action handlers.

extension RequestDetailScreen {
    // MARK: timeline (created → accepted → answered → closed/converted)

    func timeline(_ req: RequestDto) -> some View {
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
    func actionBar(_ req: RequestDto, isRequester: Bool, isTarget: Bool) -> some View {
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
    var toolbarMenu: some ToolbarContent {
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
    func sheetView(_ which: Sheet) -> some View {
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

    func acceptTask() {
        Task { _ = await model.acceptTaskRequest(requestId, note: nil) }
    }

    func closeNow() {
        Task { if await model.closeRequest(requestId, reason: nil) { dismiss() } }
    }

    func escalate() {
        Task { _ = await model.escalateRequest(requestId, reason: nil) }
    }

    // MARK: state-routed sheet copy (§5)

    /// Nudge sub-copy names who wakes: open → the target (owes the answer); answered → the
    /// requester (must act on it or close it).
    var nudgeSubcopy: String {
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
    var closeReasonSubcopy: String {
        let who = MobileUx.aliasFor(request?.requesterId, in: model.snapshot?.agents ?? []) ?? "the owner"
        return "Closing \(who)'s request needs a reason — it's sent to them so they know why."
    }
}
