import Foundation
import Testing
@testable import Orcha

/// Plan usage display setting: contract decoding, the cross-portal merge rule
/// (newest `updated_at` wins, null loses), default off, pending-edit resolution and
/// the Home card's provider filter.
@Suite struct PlanUsageDisplayTests {

    private func decode(_ json: String) throws -> PlanUsageDisplayDto {
        try JSONDecoder().decode(PlanUsageDisplayDto.self, from: Data(json.utf8))
    }

    private func dto(_ show: Bool, _ providers: String, _ at: String?) -> PlanUsageDisplayDto {
        PlanUsageDisplayDto(show: show, providers: providers, updatedAt: at)
    }

    // MARK: decode

    @Test func decodesDefaultContractResponse() throws {
        let d = try decode(#"{"show": false, "providers": "both", "updated_at": null}"#)
        #expect(d == dto(false, "both", nil))
    }

    @Test func decodesStoredValue() throws {
        let d = try decode(#"{"show": true, "providers": "codex", "updated_at": "2026-10-03T12:00:00.123456+00:00"}"#)
        #expect(d.show)
        #expect(d.providers == "codex")
        let display = PlanUsageUx.Display(d)
        #expect(display.providers == .codex)
        #expect(display.updatedAt == PlanUsageUx.parseDate("2026-10-03T12:00:00.123Z"))
    }

    @Test func decodesMissingFieldsAsDefault() throws {
        #expect(try decode("{}") == dto(false, "both", nil))
    }

    @Test(arguments: [("both", PlanUsageUx.ProviderChoice.both), ("claude", .claude), ("CODEX", .codex), ("gemini", .both)])
    func providerChoiceFromWire(raw: String, expected: PlanUsageUx.ProviderChoice) {
        #expect(PlanUsageUx.ProviderChoice(wire: raw) == expected)
    }

    // MARK: default + merge

    @Test func defaultIsOffWithBothProviders() {
        #expect(PlanUsageUx.Display.default.show == false)
        #expect(PlanUsageUx.Display.default.providers == .both)
        #expect(PlanUsageUx.Display.default.updatedAt == nil)
    }

    @Test func modelStartsHidden() async {
        let model = await PlanUsageModel()
        #expect(await model.display == .default)
    }

    @Test func mergeOfNothingOrAllNullIsDefault() {
        #expect(PlanUsageUx.mergeDisplay([]) == .default)
        #expect(PlanUsageUx.mergeDisplay([dto(true, "claude", nil), dto(true, "codex", nil)]) == .default)
    }

    @Test func newestUpdatedAtWins() {
        let merged = PlanUsageUx.mergeDisplay([
            dto(true, "claude", "2026-10-03T10:00:00Z"),
            dto(false, "codex", "2026-10-03T12:00:00+00:00"),
            dto(true, "both", "2026-10-03T07:30:00-04:00"),  // 11:30Z
        ])
        #expect(merged.show == false)
        #expect(merged.providers == .codex)
    }

    @Test func setValueBeatsNeverSet() {
        let merged = PlanUsageUx.mergeDisplay([
            dto(false, "both", nil),
            dto(true, "claude", "2020-01-01T00:00:00Z"),
            dto(false, "both", nil),
        ])
        #expect(merged.show)
        #expect(merged.providers == .claude)
    }

    // MARK: optimistic edit

    @Test func pendingEditSurvivesStaleRemote() {
        let pending = PlanUsageUx.Display(show: true, providers: .codex, updatedAt: PlanUsageUx.parseDate("2026-10-03T12:00:00Z"))
        let stale = PlanUsageUx.Display(show: false, providers: .both, updatedAt: PlanUsageUx.parseDate("2026-10-03T11:00:00Z"))
        #expect(PlanUsageUx.resolveDisplay(remote: stale, pending: pending) == pending)
        #expect(PlanUsageUx.resolveDisplay(remote: .default, pending: pending) == pending)
    }

    @Test func remoteEchoOrNewerReplacesPendingEdit() {
        let pending = PlanUsageUx.Display(show: true, providers: .codex, updatedAt: PlanUsageUx.parseDate("2026-10-03T12:00:00Z"))
        let echo = PlanUsageUx.Display(show: true, providers: .codex, updatedAt: PlanUsageUx.parseDate("2026-10-03T11:59:58Z"))
        #expect(PlanUsageUx.resolveDisplay(remote: echo, pending: pending) == echo)
        let newer = PlanUsageUx.Display(show: false, providers: .both, updatedAt: PlanUsageUx.parseDate("2026-10-03T12:05:00Z"))
        #expect(PlanUsageUx.resolveDisplay(remote: newer, pending: pending) == newer)
        #expect(PlanUsageUx.resolveDisplay(remote: newer, pending: nil) == newer)
    }

    // MARK: provider filter

    private var providers: [PlanUsageUx.Provider] {
        PlanUsageUx.merge([
            PlanUsageSnapshotDto(host: "mac", capturedAt: "2026-10-03T12:00:00Z", updatedAt: nil, providers: [
                PlanUsageProviderDto(provider: "claude", plan: "Max", headline: nil,
                                     windows: [PlanUsageWindowDto(key: "5h", label: "5h", usedPct: 34, resetsAt: nil)], today: nil),
                PlanUsageProviderDto(provider: "codex", plan: "Plus", headline: nil,
                                     windows: [PlanUsageWindowDto(key: "wk", label: "wk", usedPct: 75, resetsAt: nil)], today: nil),
            ]),
        ])
    }

    @Test func filterBothKeepsEveryProvider() {
        #expect(PlanUsageUx.filter(providers, by: .both).map(\.id) == ["claude", "codex"])
    }

    @Test func filterSingleProvider() {
        #expect(PlanUsageUx.filter(providers, by: .claude).map(\.id) == ["claude"])
        #expect(PlanUsageUx.filter(providers, by: .codex).map(\.id) == ["codex"])
    }

    @Test func filterChosenProviderWithNoDataIsEmpty() {
        let onlyClaude = providers.filter { $0.id == "claude" }
        #expect(PlanUsageUx.filter(onlyClaude, by: .codex).isEmpty)
    }
}
