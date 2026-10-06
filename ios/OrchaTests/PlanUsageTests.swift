import Foundation
import Testing
@testable import Orcha

/// Plan usage (desktop-published Claude / Codex limits): contract decoding, merge-newest
/// across servers, reset / remaining copy, bar thresholds and token / cost formatting.
@Suite struct PlanUsageTests {

    static let contractJSON = """
    {"snapshots":[{"host":"Husseins-MacBook-Pro.local","captured_at":"2026-10-02T13:20:00Z",
     "updated_at":"2026-10-02T13:20:01.123456+00:00",
     "providers":[
      {"provider":"claude","plan":"Max","headline":"5h resets in 3h 26m",
       "windows":[{"key":"5h","label":"5h","used_pct":8,"resets_at":"2026-10-02T16:49:00-04:00"},
                  {"key":"wk","label":"wk","used_pct":6,"resets_at":"2026-10-08T12:00:00-04:00"},
                  {"key":"model:fable","label":"Fable","used_pct":2,"resets_at":null}],
       "today":{"tokens":601000000,"cost_usd":237.61}},
      {"provider":"codex","plan":"Plus","headline":"wk resets in 1d 1h",
       "windows":[{"key":"5h","label":"5h","used_pct":0},
                  {"key":"wk","label":"wk","used_pct":34,"resets_at":"2026-10-03T15:20:00-04:00"}],
       "today":null}
     ]}]}
    """

    private func decode(_ json: String = contractJSON) throws -> PlanUsageListDto {
        try JSONDecoder().decode(PlanUsageListDto.self, from: Data(json.utf8))
    }

    private let ny = TimeZone(identifier: "America/New_York")!
    private let us = Locale(identifier: "en_US")
    /// 2026-10-02 13:23 EDT — 3h 26m before the Claude 5h reset.
    private var now: Date { PlanUsageUx.parseDate("2026-10-02T13:23:00-04:00")! }

    /// ICU puts a narrow no-break space before AM/PM; compare on plain spaces.
    private func plain(_ s: String) -> String { s.replacingOccurrences(of: "\u{202F}", with: " ") }

    @Test func decodesContractExample() throws {
        let list = try decode()
        let snap = try #require(list.snapshots.first)
        #expect(snap.host == "Husseins-MacBook-Pro.local")
        #expect(snap.providers.count == 2)
        let claude = snap.providers[0]
        #expect(claude.plan == "Max")
        #expect(claude.windows.map(\.label) == ["5h", "wk", "Fable"])
        #expect(claude.windows[0].usedPct == 8)
        #expect(claude.today == PlanUsageTodayDto(tokens: 601_000_000, costUsd: 237.61))
        #expect(snap.providers[1].today == nil)
        #expect(snap.providers[1].windows[0].resetsAt == nil)
    }

    @Test func decodesEmptyAndMissingSnapshots() throws {
        #expect(try decode(#"{"snapshots":[]}"#).snapshots.isEmpty)
        #expect(try decode("{}").snapshots.isEmpty)
    }

    @Test func parsesOffsetsAndMicroseconds() throws {
        let a = try #require(PlanUsageUx.parseDate("2026-10-02T16:49:00-04:00"))
        let b = try #require(PlanUsageUx.parseDate("2026-10-02T20:49:00Z"))
        #expect(a == b)
        let micro = try #require(PlanUsageUx.parseDate("2026-10-02T13:20:01.123456+00:00"))
        #expect(abs(micro.timeIntervalSince(PlanUsageUx.parseDate("2026-10-02T13:20:01Z")!) - 0.123) < 0.001)
        #expect(PlanUsageUx.parseDate("2026-10-02T13:20:00") == PlanUsageUx.parseDate("2026-10-02T13:20:00Z"))
        #expect(PlanUsageUx.parseDate(nil) == nil)
        #expect(PlanUsageUx.parseDate("garbage") == nil)
    }

    @Test func resetInFormatting() {
        let base = Date(timeIntervalSince1970: 1_000_000)
        #expect(PlanUsageUx.resetIn(base.addingTimeInterval(3 * 3600 + 26 * 60), now: base) == "in 3h 26m")
        #expect(PlanUsageUx.resetIn(base.addingTimeInterval(25 * 3600 + 30), now: base) == "in 1d 1h")
        #expect(PlanUsageUx.resetIn(base.addingTimeInterval(2 * 86_400), now: base) == "in 2d")
        #expect(PlanUsageUx.resetIn(base.addingTimeInterval(3600), now: base) == "in 1h")
        #expect(PlanUsageUx.resetIn(base.addingTimeInterval(12 * 60), now: base) == "in 12m")
        #expect(PlanUsageUx.resetIn(base.addingTimeInterval(-5), now: base) == "now")
        #expect(PlanUsageUx.resetIn(nil, now: base) == nil)
        #expect(PlanUsageUx.resetsInText(base.addingTimeInterval(12 * 60), now: base) == "resets in 12m")
    }

    @Test func remainTextMatchesDesktopPanel() throws {
        let providers = PlanUsageUx.merge(try decode().snapshots)
        let claude5h = providers[0].windows[0]
        #expect(plain(PlanUsageUx.remainText(claude5h, now: now, locale: us, timeZone: ny))
                == "92% left · resets today 4:49 PM · in 3h 26m")
        let codexWk = providers[1].windows[1]
        let codexNow = PlanUsageUx.parseDate("2026-10-02T14:20:00-04:00")!
        #expect(plain(PlanUsageUx.remainText(codexWk, now: codexNow, locale: us, timeZone: ny))
                == "66% left · resets Sat 3:20 PM · in 1d 1h")
        #expect(PlanUsageUx.remainText(providers[1].windows[0], now: now) == "100% left")
    }

    @Test func farResetShowsDate() throws {
        let at = try #require(PlanUsageUx.parseDate("2026-10-12T15:00:00-04:00"))
        #expect(plain(PlanUsageUx.resetAt(at, now: now, locale: us, timeZone: ny)) == "Oct 12, 3:00 PM")
    }

    @Test(arguments: [
        (0.0, PlanUsageUx.Tone.neutral), (75, .neutral), (75.1, .warn),
        (90, .warn), (90.1, .danger), (100, .danger), (140, .danger), (-3, .neutral)
    ])
    func barTone(pct: Double, tone: PlanUsageUx.Tone) {
        #expect(PlanUsageUx.tone(pct) == tone)
    }

    @Test func mergeKeepsNewestPerProviderAcrossServers() throws {
        let older = PlanUsageSnapshotDto(host: "old-mac", capturedAt: "2026-10-02T10:00:00Z", updatedAt: nil, providers: [
            PlanUsageProviderDto(provider: "claude", plan: "Pro", headline: nil,
                                 windows: [PlanUsageWindowDto(key: "5h", label: "5h", usedPct: 80, resetsAt: nil)], today: nil),
            PlanUsageProviderDto(provider: "codex", plan: "Pro", headline: nil, windows: [], today: nil)
        ])
        let newer = PlanUsageSnapshotDto(host: "new-mac.local", capturedAt: "2026-10-02T13:00:00Z", updatedAt: nil, providers: [
            PlanUsageProviderDto(provider: "claude", plan: "Max", headline: nil,
                                 windows: [PlanUsageWindowDto(key: "5h", label: "5h", usedPct: 8, resetsAt: nil)], today: nil)
        ])
        for input in [[older, newer], [newer, older]] {
            let merged = PlanUsageUx.merge(input)
            #expect(merged.map(\.id) == ["claude", "codex"])
            #expect(merged[0].plan == "Max")
            #expect(merged[0].host == "new-mac.local")
            #expect(merged[1].host == "old-mac")
        }
        #expect(PlanUsageUx.sources(PlanUsageUx.merge([older, newer])).map(\.host) == ["new-mac.local", "old-mac"])
    }

    @Test func overallAndConstrained() throws {
        let providers = PlanUsageUx.merge(try decode().snapshots)
        #expect(PlanUsageUx.overallPercent(providers) == 34)
        #expect(providers[0].constrained?.label == "5h")
        #expect(providers[1].constrained?.label == "wk")
        #expect(providers[0].name == "Claude")
        #expect(providers[1].name == "Codex")
        #expect(providers[0].mark == .claude)
        #expect(providers[1].mark == .openai)
        #expect(PlanUsageUx.overallPercent([]) == nil)
    }

    @Test func tokensCostAndToday() {
        #expect(PlanUsageUx.tokens(950) == "950")
        #expect(PlanUsageUx.tokens(12_400) == "12.4K")
        #expect(PlanUsageUx.tokens(3_200_000) == "3.20M")
        #expect(PlanUsageUx.tokens(601_000_000) == "601M")
        #expect(PlanUsageUx.tokens(1_050_000_000) == "1.05B")
        #expect(PlanUsageUx.usd(237.61) == "$237.61")
        #expect(PlanUsageUx.usd(1234.4) == "$1,234")
        #expect(PlanUsageUx.todayText(PlanUsageTodayDto(tokens: 601_000_000, costUsd: 237.61))
                == "Today 601M tokens · Est. $237.61")
        #expect(PlanUsageUx.todayText(PlanUsageTodayDto(tokens: 1200, costUsd: nil)) == "Today 1.20K tokens")
        #expect(PlanUsageUx.todayText(nil) == nil)
    }

    @Test func freshnessLine() {
        let base = Date(timeIntervalSince1970: 1_000_000)
        #expect(PlanUsageUx.updatedText(host: "Husseins-MacBook-Pro.local", capturedAt: base.addingTimeInterval(-120), now: base)
                == "Updated 2m ago from Husseins-MacBook-Pro")
        #expect(PlanUsageUx.updatedText(host: "mac", capturedAt: base, now: base) == "Updated just now from mac")
        #expect(!PlanUsageUx.isStale(base.addingTimeInterval(-29 * 60), now: base))
        #expect(PlanUsageUx.isStale(base.addingTimeInterval(-31 * 60), now: base))
        #expect(PlanUsageUx.isStale(nil, now: base))
    }
}
