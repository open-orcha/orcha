import SwiftUI

// Responsibility: Request detail content, timeline, role-aware actions, and sheet routing.

/// Flow 07 — Request detail: flow header, chain context, spawned-task link, payload,
/// response quote, rejection, timeline, and the state×role action matrix. Actions run
/// through bottom sheets (`.medium`/`.large`); terminal closes pop back to the list.
/// A pushed screen — the parent tab owns the NavigationStack.
struct RequestDetailScreen: View {
    @Environment(AppModel.self) var model
    @Environment(\.palette) var p
    @Environment(\.dismiss) var dismiss
    let requestId: String

    enum Sheet: Identifiable {
        case respond, reject, convert, nudge, closeWithReason
        var id: Self { self }
    }
    @State var sheet: Sheet?
    /// Flow 07a — owner-close (no reason needed) confirms via a dialog, not a sheet.
    @State var showCloseConfirm = false
    /// GH #140 — a tapped task-id link in the payload/response/rejection text pushes here.
    @State var linkedTaskId: String?

    var request: RequestDto? {
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
    func detailSections(_ req: RequestDto) -> some View {
        let isRequester = req.requesterId == model.humanId
        let isTarget = req.targetId == model.humanId || req.targetId == nil

        RequestFlowHeader(request: req, isRequester: isRequester, isTarget: isTarget, agents: model.snapshot?.agents ?? [])

        if req.parentRequestId != nil {
            OrchaCard {
                Text("↳ part of a request chain (depth \(req.chainDepth))")
                    .font(.system(size: 13))
                    .foregroundStyle(p.muted)
            }
        }

        if let tid = req.taskLink?.taskId {
            NavigationLink(value: WorkspaceRoute.task(tid)) {
                OrchaCard {
                    Text("SPAWNED TASK →")
                        .font(.system(size: 11, weight: .bold)).tracking(0.8)
                        .foregroundStyle(p.violet)
                    Text(req.taskLink?.title ?? tid)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(p.text)
                        .multilineTextAlignment(.leading)
                }
            }
            .buttonStyle(.plain)
        }

        SectionH(title: "Payload")
        OrchaCard {
            LinkedMessageText(text: req.payload, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                .font(.system(size: 15))
                .foregroundStyle(p.text)
        }

        if let response = req.response {
            SectionH(title: "Response")
            OrchaCard(borderColor: p.okLine) {
                LinkedMessageText(text: response, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                    .font(.system(size: 15)).foregroundStyle(p.text2)
            }
        }

        if let rejection = req.rejectionReason {
            SectionH(title: "Rejection")
            OrchaCard(borderColor: p.dangerLine) {
                LinkedMessageText(text: rejection, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                    .font(.system(size: 15)).foregroundStyle(p.text2)
            }
        }

        SectionH(title: "Timeline")
        timeline(req)

        actionBar(req, isRequester: isRequester, isTarget: isTarget)
    }

}
