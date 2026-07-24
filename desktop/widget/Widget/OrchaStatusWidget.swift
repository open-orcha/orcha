// Owns the primary status widget configuration and the widget bundle entry point.
import SwiftUI
import WidgetKit

struct OrchaStatusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "OrchaStatusWidget", provider: Provider()) { entry in
      OrchaWidgetView(entry: entry)
        .widgetURL(deepLink(status: entry.status))
    }
    .configurationDisplayName("Orcha")
    .description("Stacks and what needs your attention.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct OrchaWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: Entry

  var body: some View {
    switch family {
    case .systemMedium: MediumView(entry: entry)
    default: SmallView(entry: entry)
    }
  }
}

@main
struct OrchaWidgetBundle: WidgetBundle {
  var body: some Widget {
    OrchaStatusWidget()
    OrchaAgentsWidget()
    OrchaPipelineWidget()
    OrchaAttentionWidget()
  }
}
