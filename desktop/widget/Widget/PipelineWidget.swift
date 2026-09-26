// Owns pipeline task summaries, proportional bars, and widget configuration.
import SwiftUI
import WidgetKit

struct PipelineBarView: View {
  let ready: Int
  let inProgress: Int
  let needsVerification: Int

  private struct Segment: Identifiable {
    let id: Int
    let count: Int
    let color: Color
  }

  var body: some View {
    let segments = [
      Segment(id: 0, count: ready, color: Color.gray.opacity(0.5)),
      Segment(id: 1, count: inProgress, color: teal),
      Segment(id: 2, count: needsVerification, color: amber),
    ].filter { $0.count > 0 }
    GeometryReader { geo in
      let spacing: CGFloat = 2
      let minSegmentWidth: CGFloat = 10
      let total = CGFloat(segments.reduce(0) { $0 + $1.count })
      let available = geo.size.width - spacing * CGFloat(max(segments.count - 1, 0))
      // Every non-zero segment gets at least minSegmentWidth; the remainder is
      // distributed proportionally to counts, so widths always sum to the bar width.
      let flexible = max(available - minSegmentWidth * CGFloat(segments.count), 0)
      HStack(spacing: spacing) {
        ForEach(segments) { segment in
          RoundedRectangle(cornerRadius: 2)
            .fill(segment.color)
            .frame(width: minSegmentWidth + flexible * CGFloat(segment.count) / max(total, 1))
        }
      }
    }
    .frame(height: 6)
  }
}

struct PipelineStackRow: View {
  let stack: OrchaStatus.StackRow

  var body: some View {
    let ready = stack.tasks?.ready ?? 0
    let inProgress = stack.tasks?.inProgress ?? 0
    let verify = stack.tasks?.needsVerification ?? 0
    let total = ready + inProgress + verify
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Text(stack.projectShort).font(.system(size: 11, weight: .semibold)).foregroundStyle(cream)
          .lineLimit(1)
        Spacer(minLength: 4)
        if total > 0 {
          Text("\(ready) ready · \(inProgress) working · \(verify) verify")
            .font(.system(size: 9)).foregroundStyle(.gray)
            .lineLimit(1)
        }
      }
      if total > 0 {
        PipelineBarView(ready: ready, inProgress: inProgress, needsVerification: verify)
      } else {
        Text("no tasks").font(.system(size: 9)).foregroundStyle(.gray)
      }
    }
  }
}

struct PipelineView: View {
  let entry: Entry

  var body: some View {
    Group {
      if let status = entry.status, !entry.stale,
         status.stacks.contains(where: { $0.running }) {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(status.stacks.filter(\.running).prefix(3), id: \.projectShort) { stack in
            PipelineStackRow(stack: stack)
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

struct OrchaPipelineWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaPipelineWidget", provider: Provider()) { entry in
      PipelineView(entry: entry)
        .widgetURL(deepLink(status: entry.status))
    }
    .configurationDisplayName("Orcha Pipeline")
    .description("Task flow across your stacks.")
    .supportedFamilies([.systemMedium])
  }
}
