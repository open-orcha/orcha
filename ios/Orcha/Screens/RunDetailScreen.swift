import SwiftUI

// Responsibility: Worker-run detail, live log feed, terminal state, and stop control.

struct RunDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let run: RunDto

    @State private var confirmStop = false
    @State private var pinned = true

    var body: some View {
        VStack(spacing: 10) {
            header
            if run.status != "running" {
                terminalBanner
            }
            if let note = model.runStreamNote {
                Banner(kind: .info, text: note)
            }
            logCard
            if let error = model.error {
                Banner(kind: .danger, text: error, action: "Retry") {
                    model.startRunLog(run)
                }
            }
        }
        .padding(16)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(run.runId.prefix(6))
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .foregroundStyle(p.text)
            }
        }
        // Issue 3: a running run streams live over SSE; a finished run keeps the one-shot fetch.
        // The collector is cancelled when the screen goes away.
        .task { model.startRunLog(run) }
        .onDisappear { model.stopRunLogStream() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            StatusPill(status: run.status, domain: .run)
            if let wakeKind = run.wakeKind { MetaTag(text: wakeKind) }
            if let alias = run.agentAlias { MetaTag(text: alias) }
            Spacer()
            if run.status == "running" {
                KitButton(title: "Stop run", role: .dangerTonal, small: true, enabled: !model.actionInFlight) {
                    confirmStop = true
                }
                .fixedSize()
                .confirmationDialog("Stop this run?", isPresented: $confirmStop, titleVisibility: .visible) {
                    Button("Stop run", role: .destructive, action: stopRun)
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The worker is interrupted mid-turn. The log so far is kept and the run is marked stopped.")
                }
            }
        }
    }

    private var terminalBanner: some View {
        let kind: BannerKind = ["killed", "failed", "error"].contains(run.status) ? .danger : .info
        let ago = MobileUx.agoLabel(run.endedAt).map { " · \($0)" } ?? ""
        return Banner(kind: kind, text: "Run \(MobileUx.statusCopy(run.status))\(ago)")
    }

    private var logCard: some View {
        OrchaCard {
            if model.runFeed.isEmpty {
                ScrollView {
                    Text(emptyLogText)
                        .font(.system(size: 13))
                        .foregroundStyle(p.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { model.startRunLog(run) }
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .bottom) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(model.runFeed.enumerated()), id: \.offset) { _, row in
                                    FeedRow(row: row)
                                }
                                Color.clear.frame(height: 1).id("log-bottom")
                            }
                        }
                        .refreshable { model.startRunLog(run) }
                        // pragmatic pin tracking (flow 06 §auto-scroll): a downward
                        // drag (scrolling back through history) pauses auto-scroll.
                        .simultaneousGesture(
                            DragGesture().onChanged { value in
                                if value.translation.height > 12 { pinned = false }
                            }
                        )
                        if !pinned {
                            Button {
                                pinned = true
                                withAnimation { proxy.scrollTo("log-bottom", anchor: .bottom) }
                            } label: {
                                Text("Auto-scroll paused · Jump to latest")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(p.accent)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(p.surface3, in: Capsule())
                                    .overlay(Capsule().strokeBorder(p.border2, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .padding(.bottom, 6)
                        }
                    }
                    .onChange(of: model.runFeed.count) {
                        if pinned {
                            proxy.scrollTo("log-bottom", anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private var emptyLogText: String {
        if model.runLogStreaming { return "Waiting for the worker to emit output…" }
        if model.loading { return "Loading stream…" }
        return "No log lines yet."
    }

    private func stopRun() {
        Task { await model.stopRun(run) }
    }
}
