import SwiftUI
import UIKit

// Responsibility: Full task-thread transcript, paging, and human message composer.

struct TaskThreadScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String

    @State private var draft = ""
    @State private var pendingSend: String?
    /// GH #140 — a tapped task-id link pushes here, in addition to the tab's own
    /// `WorkspaceRoute.task` destination; both target the same `TaskDetailScreen`.
    @State private var linkedTaskId: String?

    private var task: TaskDto? { model.snapshot?.tasks.first { $0.id == taskId } }
    private var assignee: String? { task?.assignees.first ?? task?.ownerAlias }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    // Issue 4: "Load earlier" reveals the previous keyset page at the TOP; it
                    // prepends older messages and must NOT scroll the view to the bottom.
                    if model.threadHasMore {
                        Button {
                            Task { await model.loadEarlierThreadMessages(taskId) }
                        } label: {
                            if model.threadLoadingEarlier {
                                ProgressView().frame(maxWidth: .infinity)
                            } else {
                                Text("Load earlier messages")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(p.accent)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                        .disabled(model.threadLoadingEarlier)
                    }
                    if model.taskMessages.isEmpty, pendingSend == nil {
                        OrchaCard {
                            Text("No messages yet — say hi to \(assignee ?? "the assignee").")
                                .foregroundStyle(p.muted)
                        }
                    }
                    ForEach(Array(model.taskMessages.enumerated()), id: \.offset) { _, msg in
                        threadBubble(msg)
                    }
                    if let unsent = pendingSend {
                        VStack(alignment: .trailing, spacing: 2) {
                            Bubble(.mine, unsent)
                            if !model.actionInFlight {
                                Button("Not sent · Tap to retry") { send(unsent) }
                                    .buttonStyle(.plain)
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(p.danger)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    } else if let error = model.error {
                        Banner(kind: .danger, text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            // Scroll to bottom only when the NEWEST message changes (a new/sent message) or a
            // pending bubble appears — never on a "Load earlier" prepend (which changes the top).
            .onChange(of: model.taskMessages.last?.messageId) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: pendingSend) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("Thread")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(p.text)
                    if let title = task?.title {
                        Text(title)
                            .font(.system(size: 11))
                            .foregroundStyle(p.muted)
                            .lineLimit(1)
                    }
                }
            }
        }
        .task { await model.loadTaskDetail(taskId) }
        .refreshable { await model.loadTaskDetail(taskId) }
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
    }

    @ViewBuilder
    private func threadBubble(_ msg: TaskMessageDto) -> some View {
        let tasks = model.snapshot?.tasks ?? []
        if msg.authorId == nil, !msg.isHuman {
            Bubble(.system, msg.body, tasks: tasks, onTapTask: { linkedTaskId = $0 })
        } else if msg.authorId != nil, msg.authorId == model.humanId {
            Bubble(.mine, msg.body, time: MobileUx.agoLabel(msg.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 })
        } else {
            Bubble(
                .theirs, msg.body,
                author: msg.authorAlias ?? (msg.isHuman ? "human" : "agent"),
                time: MobileUx.agoLabel(msg.createdAt),
                tasks: tasks, onTapTask: { linkedTaskId = $0 }
            )
        }
    }

    /// `.composer` — rounded field + circular send button.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(assignee ?? "the thread")…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .font(.system(size: 14.5))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(p.border2, lineWidth: 1))
            Button(action: sendDraft) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? p.accent : p.faint)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(p.bg)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.actionInFlight
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        send(text)
    }

    /// A send that errors keeps its text as an unsent bubble with a retry chip.
    private func send(_ text: String) {
        pendingSend = text
        Task {
            if await model.sendTaskMessage(taskId, body: text) {
                pendingSend = nil
            }
        }
    }
}

/* ---------- flow 06 R2 — run detail: mono log, pin-to-bottom, stop-run ---------- */

/// Flow 06 R2 — run detail: header + stop-run, terminal banner, and the streaming
/// mono log filling the remaining space with pragmatic pin-to-bottom tracking.
