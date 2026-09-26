// Owns the shared status schema, disk loading, and WidgetKit timeline entries.
import Foundation
import WidgetKit
import os

private let appGroupId = "N2597TV587.orcha"
private let logger = Logger(subsystem: "ai.quantal.orcha.widget", category: "provider")

struct OrchaStatus: Codable {
  struct AgentRow: Codable {
    let alias: String
    let kind: String
    let status: String
    // v3 fields — optional so decode never fails on older/newer files.
    let model: String?
    let task: String?
  }

  struct TaskCounts: Codable {
    let inProgress: Int
    let needsVerification: Int
    // v3 field — optional so decode never fails on older/newer files.
    let ready: Int?
  }

  struct AttentionRow: Codable {
    let projectShort: String
    let kind: String
    let title: String
  }

  struct StackRow: Codable {
    let projectShort: String
    let running: Bool
    let attention: Int
    // v2 fields — optional so decode never fails on older/newer files.
    let working: Int?
    let agents: [AgentRow]?
    let tasks: TaskCounts?
  }

  let v: Int
  let updatedAt: String
  let totalAttention: Int
  let stacks: [StackRow]
  // v2 field — optional so decode never fails on older/newer files.
  let attention: [AttentionRow]?
}

private func loadStatus() -> (OrchaStatus, Date)? {
  guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
  else {
    logger.error("loadStatus: nil container for app group \(appGroupId, privacy: .public)")
    return nil
  }
  logger.info("loadStatus: container \(dir.path, privacy: .public)")
  let url = dir.appendingPathComponent("status.json")
  let data: Data
  do {
    data = try Data(contentsOf: url)
    logger.info("loadStatus: read ok, \(data.count, privacy: .public) bytes")
  } catch {
    logger.error("loadStatus: read failed: \(String(describing: error), privacy: .public)")
    return nil
  }
  let status: OrchaStatus
  do {
    status = try JSONDecoder().decode(OrchaStatus.self, from: data)
    logger.info(
      "loadStatus: decode ok, v\(status.v, privacy: .public), \(status.stacks.count, privacy: .public) stacks")
  } catch {
    logger.error("loadStatus: decode failed: \(String(describing: error), privacy: .public)")
    return nil
  }
  let fmt = ISO8601DateFormatter()
  fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let updated = fmt.date(from: status.updatedAt) ?? .distantPast
  let age = Date().timeIntervalSince(updated)
  logger.info(
    "loadStatus: updatedAt \(status.updatedAt, privacy: .public), age \(Int(age), privacy: .public)s, stale \(age > 120, privacy: .public)")
  return (status, updated)
}

extension OrchaStatus {
  /// Representative data for the widget gallery; never shown for an added widget
  /// unless real data is unavailable in a preview context.
  static func sample() -> OrchaStatus {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return OrchaStatus(
      v: 3,
      updatedAt: fmt.string(from: .now),
      totalAttention: 2,
      stacks: [
        .init(
          projectShort: "quantal-ehr", running: true, attention: 2, working: 1,
          agents: [
            .init(
              alias: "Plum", kind: "ai", status: "working", model: "opus-4-8",
              task: "Foundation layer: migration runner + schema + audit"),
            .init(alias: "Atlas", kind: "ai", status: "awaiting_request", model: "opus-4-8", task: nil),
            .init(alias: "Crimson", kind: "ai", status: "idle", model: "sonnet-5", task: nil),
          ],
          tasks: .init(inProgress: 1, needsVerification: 1, ready: 2)
        ),
        .init(
          projectShort: "quantallabs-web", running: true, attention: 0, working: 0,
          agents: [], tasks: .init(inProgress: 0, needsVerification: 0, ready: 1)
        ),
      ],
      attention: [
        .init(
          projectShort: "quantal-ehr", kind: "request_answer",
          title: "[Atlas → operator] Which auth provider for the portal?"),
        .init(
          projectShort: "quantal-ehr", kind: "task_verify",
          title: "Verify: patient search API pagination"),
      ]
    )
  }
}

struct Entry: TimelineEntry {
  let date: Date
  let status: OrchaStatus?
  let stale: Bool
}

struct Provider: TimelineProvider {
  func placeholder(in _: Context) -> Entry { .init(date: .now, status: .sample(), stale: false) }

  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    let entry = makeEntry()
    if context.isPreview, entry.status == nil {
      completion(.init(date: .now, status: .sample(), stale: false))
    } else {
      completion(entry)
    }
  }

  func getTimeline(in _: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [makeEntry()], policy: .after(Date().addingTimeInterval(300))))
  }

  private func makeEntry() -> Entry {
    if let (status, updated) = loadStatus() {
      return .init(date: .now, status: status, stale: Date().timeIntervalSince(updated) > 120)
    }
    return .init(date: .now, status: nil, stale: true)
  }
}
