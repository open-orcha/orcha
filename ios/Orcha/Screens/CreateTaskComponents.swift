import SwiftUI

// Responsibility: Create-task text fields, assignee chips, and blank-string validation.

struct OrchaTextField: View {
    @Environment(\.palette) private var p
    @Binding var text: String
    let prompt: String
    let lines: ClosedRange<Int>

    var body: some View {
        TextField("", text: $text, prompt: Text(prompt), axis: .vertical)
            .lineLimit(lines)
            .padding(12)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
    }
}

/// Assignee chip — tinted when selected. "working" agents get a hint line.
struct AssigneeChip: View {
    @Environment(\.palette) private var p
    let alias: String
    var status: String?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            OrchaCard(
                borderColor: selected ? p.accentLine : p.border,
                container: selected ? p.accentSoft : p.surface
            ) {
                HStack(spacing: 8) {
                    AgentAvatar(alias: alias, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(alias)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(p.text)
                        if let status {
                            StatusPill(status: status, domain: .agent)
                        }
                    }
                    if status == "working" {
                        Text("working — will pick this up next")
                            .font(.system(size: 11))
                            .foregroundStyle(p.muted)
                    }
                }
            }
            .frame(minWidth: 140)
        }
        .buttonStyle(.plain)
    }
}

extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
