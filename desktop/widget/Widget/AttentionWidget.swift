// Owns attention labels, rows, layouts, and widget configuration.
import SwiftUI
import WidgetKit

private func attentionKindLabel(_ kind: String) -> String {
  switch kind {
  case "request_answer": return "escalation"
  case "request_close": return "close"
  case "task_verify": return "verify"
  case "health": return "health"
  default: return kind
  }
}

struct AttentionRowView: View {
  let item: OrchaStatus.AttentionRow

  var body: some View {
    HStack(spacing: 6) {
      Text(attentionKindLabel(item.kind).uppercased())
        .font(.system(size: 7, weight: .semibold)).foregroundStyle(amber)
        .padding(.horizontal, 4).padding(.vertical, 1)
        .background(amber.opacity(0.12), in: Capsule())
      Text(item.title).font(.system(size: 11)).foregroundStyle(cream)
        .lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 4)
      Text(item.projectShort).font(.system(size: 9)).foregroundStyle(.gray)
        .lineLimit(1)
    }
  }
}

struct AttentionView: View {
  let entry: Entry

  var body: some View {
    Group {
      if let status = entry.status, !entry.stale {
        let items = status.attention ?? []
        VStack(alignment: .leading, spacing: 6) {
          if status.totalAttention > 0 {
            Text("NEEDS ATTENTION · \(status.totalAttention)")
              .font(.system(size: 9, weight: .semibold)).foregroundStyle(amber)
          } else {
            Text("ALL CLEAR")
              .font(.system(size: 9, weight: .semibold)).foregroundStyle(green)
          }
          ForEach(Array(items.prefix(8).enumerated()), id: \.offset) { _, item in
            AttentionRowView(item: item)
          }
          if items.isEmpty {
            Text("Nothing waiting on you.")
              .font(.system(size: 11)).foregroundStyle(.gray)
          }
          Spacer(minLength: 0)
        }
      } else {
        OfflineView(stale: entry.stale)
      }
    }
    .padding(4)
    .containerBackground(tile, for: .widget)
  }
}

struct OrchaAttentionWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaAttentionWidget", provider: Provider()) { entry in
      AttentionView(entry: entry)
        .widgetURL(deepLink(status: entry.status, path: "/requests"))
    }
    .configurationDisplayName("Orcha Attention")
    .description("What's waiting on you.")
    .supportedFamilies([.systemLarge])
  }
}
