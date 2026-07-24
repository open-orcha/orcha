// Owns shared widget styling, navigation, and reusable status views.
import SwiftUI
import WidgetKit

let cream = Color(red: 239 / 255, green: 233 / 255, blue: 223 / 255)
let amber = Color(red: 240 / 255, green: 185 / 255, blue: 75 / 255)
let green = Color(red: 66 / 255, green: 217 / 255, blue: 138 / 255)
let teal = Color(red: 31 / 255, green: 199 / 255, blue: 205 / 255)
let tile = Color(red: 29 / 255, green: 27 / 255, blue: 24 / 255)

/// Builds an `orcha://open` deep link into the desktop app (handled by the Electron
/// protocol parser). `projectShort` in the schema carries the short name WITHOUT the
/// `orcha-` compose prefix; the full project is `orcha-` + projectShort.
/// With no running stack we fall back to a plain `orcha://open` (app just comes forward).
func deepLink(status: OrchaStatus?, path: String? = nil) -> URL {
  var components = URLComponents()
  components.scheme = "orcha"
  components.host = "open"
  if let short = status?.stacks.first(where: { $0.running })?.projectShort {
    var items = [URLQueryItem(name: "project", value: "orcha-\(short)")]
    if let path {
      items.append(URLQueryItem(name: "path", value: path))
    }
    components.queryItems = items
  }
  return components.url ?? URL(string: "orcha://open")!
}

struct RingView: View {
  let entry: Entry

  var body: some View {
    let count = entry.status?.totalAttention ?? 0
    let clear = count == 0
    ZStack {
      Circle().stroke(entry.stale ? Color.gray.opacity(0.4) : (clear ? green : amber), lineWidth: 5)
      VStack(spacing: 2) {
        if entry.stale || entry.status == nil {
          Text("OFFLINE").font(.system(size: 9, weight: .semibold)).foregroundStyle(.gray)
        } else if clear {
          Text("ALL CLEAR").font(.system(size: 9, weight: .semibold)).foregroundStyle(green)
        } else {
          Text("\(count)").font(.system(size: 26, weight: .bold)).foregroundStyle(cream)
          Text("PENDING").font(.system(size: 8, weight: .semibold)).foregroundStyle(amber)
        }
      }
    }
  }
}

struct SmallView: View {
  let entry: Entry

  var body: some View {
    RingView(entry: entry)
      .padding(6)
      .containerBackground(tile, for: .widget)
  }
}

struct MediumView: View {
  let entry: Entry

  var body: some View {
    HStack(spacing: 14) {
      RingView(entry: entry).frame(width: 84, height: 84)
      VStack(alignment: .leading, spacing: 5) {
        ForEach((entry.status?.stacks ?? []).prefix(4), id: \.projectShort) { s in
          HStack(spacing: 6) {
            Circle().fill(s.running ? green : Color.gray.opacity(0.5)).frame(width: 6, height: 6)
            Text(s.projectShort).font(.system(size: 12, weight: .semibold)).foregroundStyle(cream)
              .lineLimit(1)
            Spacer(minLength: 4)
            if s.attention > 0 {
              Text("\(s.attention)").font(.system(size: 11, weight: .bold)).foregroundStyle(amber)
            }
          }
        }
        if entry.status?.stacks.isEmpty != false {
          Text(entry.stale ? "Orcha app not running" : "No stacks yet")
            .font(.system(size: 11)).foregroundStyle(.gray)
        }
      }
    }
    .padding(4)
    .containerBackground(tile, for: .widget)
  }
}

struct OfflineView: View {
  let stale: Bool

  var body: some View {
    Text(stale ? "Orcha app not running" : "No stacks yet")
      .font(.system(size: 11)).foregroundStyle(.gray)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
