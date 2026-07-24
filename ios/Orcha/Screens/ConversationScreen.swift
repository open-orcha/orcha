import SwiftUI
import UIKit

// Responsibility: Live agent conversation transcript, day grouping, and message composer.

struct ConversationScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let agentId: String

    @State private var draft = ""
    @State private var confirmEnd = false
    @State private var pulse = false
    /// Issue 4 — client-side reveal window over the already-fetched turns (web parity:
    /// start at the last 10, +20 per "Load earlier" tap). No refetch; the fetch window is 80.
    @State private var revealed = 10
    private static let revealStep = 20
    /// GH #140 — a tapped task-id link pushes onto the tab's NavigationStack.
    @State private var linkedTaskId: String?

    private var agent: AgentDto? {
        model.snapshot?.agents.first { $0.id == agentId }
    }
    private var working: Bool { agent?.status == "working" }
    private let hints = ["What are you working on?", "Any blockers?", "Status update, please"]

    var body: some View {
        // Issue 2: composer pinned via `.safeAreaInset(edge: .bottom)` (like TaskThreadScreen)
        // so SwiftUI lifts it directly above the keyboard and shrinks the scroll area — no gap,
        // no obscured transcript. The "working" banner is a top inset so it never scrolls away.
        transcript
            .safeAreaInset(edge: .top, spacing: 0) { workingBanner }
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle(agent?.alias ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("End conversation", role: .destructive) { confirmEnd = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("End this conversation?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End conversation", role: .destructive) { Task { await model.endConversation(agentId) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(agent?.alias ?? "The agent") goes back to their own work. The transcript stays here.")
        }
        .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        .task { await model.loadConversation(agentId) }
    }

    // MARK: working banner (top inset)

    @ViewBuilder
    private var workingBanner: some View {
        if working, agent?.currentTask != nil {
            Banner(
                kind: .info,
                text: "\(agent?.alias ?? "The agent") is working on a task — your message queues."
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(p.bg)
        }
    }

    // MARK: transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    // Issue 4: "Load earlier" widens the reveal window over the already-fetched
                    // turns (no refetch); it changes only the TOP, so it must not scroll to bottom.
                    if model.turns.count > revealed {
                        Button { revealed += Self.revealStep } label: {
                            Text("Load earlier messages")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(p.accent)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                    }
                    if model.turns.isEmpty {
                        OrchaCard {
                            Text("No conversation yet. Send a message to wake \(agent?.alias ?? "the agent").")
                                .foregroundStyle(p.muted)
                        }
                        HStack(spacing: 8) {
                            ForEach(hints, id: \.self) { hint in
                                PillChip(label: hint, selected: false) { draft = hint }
                            }
                        }
                    }
                    turnRows
                    if working {
                        Text("\(agent?.alias ?? "The agent") is working…")
                            .font(.system(size: 13))
                            .foregroundStyle(p.muted)
                            .opacity(!reduceMotion && pulse ? 0.4 : 1)
                            .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulse)
                            .onAppear { if !reduceMotion { pulse = true } }
                    }
                    if let error = model.error {
                        Banner(kind: .danger, text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            // Scroll to bottom on a NEW/sent turn (newest seq changes) or when the keyboard
            // opens — never on a "Load earlier" reveal (which only widens the top).
            .onChange(of: model.turns.last?.seq) {
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .refreshable { await model.refreshConversationDelta(agentId) }
        }
    }

    /// Turns as bubbles, with a `.system` day-divider bubble inserted at each new day.
    @ViewBuilder
    private var turnRows: some View {
        let humanId = model.humanId
        let alias = agent?.alias ?? "agent"
        let rows = withDayDividers(Array(model.turns.suffix(revealed)))
        ForEach(rows) { row in
            switch row {
            case let .day(label):
                Bubble(.system, label)
            case let .turn(turn):
                turnBubble(turn, humanId: humanId, alias: alias)
            }
        }
    }

    @ViewBuilder
    private func turnBubble(_ turn: TurnDto, humanId: String?, alias: String) -> some View {
        let mine = turn.authorAgentId == humanId || turn.role == "human"
        let tasks = model.snapshot?.tasks ?? []
        if turn.role == "system" {
            Bubble(.system, turn.content, tasks: tasks, onTapTask: { linkedTaskId = $0 })
        } else if mine {
            Bubble(.mine, turn.content, time: MobileUx.agoLabel(turn.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 })
        } else {
            Bubble(.theirs, turn.content, author: alias, time: MobileUx.agoLabel(turn.createdAt), tasks: tasks, onTapTask: { linkedTaskId = $0 }) {
                if let rid = turn.runId {
                    NavigationLink(value: WorkspaceRoute.run(RunDto(runId: rid, agentId: agentId, agentAlias: alias, status: "exited"))) {
                        Text("Open work log →")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(p.accent)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
            }
        }
    }

    // MARK: composer

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Chat with \(agent?.alias ?? "the agent")…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
            Button {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                draft = ""
                Task { await model.sendTurn(agentId, content: text) }
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(p.accentInk)
                    .frame(width: 40, height: 40)
                    .background(p.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .opacity(canSend ? 1 : 0.45)
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(p.bg)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.actionInFlight
    }

    // MARK: day dividers

    private enum ChatRow: Identifiable {
        case day(String)
        case turn(TurnDto)

        var id: String {
            switch self {
            case let .day(label): "day-\(label)"
            case let .turn(t): t.id ?? "seq-\(t.seq)"
            }
        }
    }

    /// Insert a `.day` row (a `.system` divider bubble) whenever the calendar day changes.
    private func withDayDividers(_ turns: [TurnDto]) -> [ChatRow] {
        var rows: [ChatRow] = []
        var lastDay: String?
        for turn in turns {
            if let day = MobileUx.dayKey(turn.createdAt), day != lastDay {
                lastDay = day
                rows.append(.day(MobileUx.dayLabel(turn.createdAt) ?? day))
            }
            rows.append(.turn(turn))
        }
        return rows
    }
}
