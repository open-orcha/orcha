import SwiftUI

// Responsibility: Compact worker-run summary card used from task and agent screens.

struct RunRowCard: View {
    @Environment(\.palette) private var p
    let run: RunDto

    var body: some View {
        OrchaCard {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(p.accent)
                Text(run.runId.prefix(6))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(p.text)
                if let alias = run.agentAlias {
                    AgentAvatar(alias: alias, size: 26)
                }
                StatusPill(status: run.status, domain: .run)
                Spacer()
                Text(MobileUx.agoLabel(run.startedAt) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.faint)
            }
            Text(run.taskTitle ?? run.wakeEvent ?? "worker run")
                .font(.system(size: 13))
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
    }
}

/* ---------- flow 05 T8 — the task thread (chat surface + composer) ---------- */

/// Flow 05 T8 — chat surface: scrolling bubbles (auto-pin to bottom) + a composer
/// pinned above the keyboard. A failed send keeps its text as a retryable bubble.
