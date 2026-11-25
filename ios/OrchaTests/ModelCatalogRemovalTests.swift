import Foundation
import Testing
@testable import Orcha

/// GH #432 — Fable 5.1 leaves the offered catalog (`/api/models`), but agents, runs and
/// config history that already used it must still read as a Claude model with a readable
/// name. The picker offers exactly the server catalog; nothing re-inserts a saved model.
@MainActor
@Suite("Model catalog removal (GH #432)")
struct ModelCatalogRemovalTests {
    /// `/api/models` as the server returns it after the removal (the live shape, extra
    /// `reasoning_efforts` key included, with `claude-fable-5-1` gone).
    private static let catalogJson = #"""
    {"models":[
     {"id":"claude-fable-5-2","name":"Fable 5.2","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
     {"id":"claude-opus-5-5","name":"Opus 5.5","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
     {"id":"claude-sonnet-5-5","name":"Sonnet 5.5","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
     {"id":"claude-fable-5","name":"Fable 5","runtime":"claude","reasoning_efforts":["low","medium","high","xhigh","max"]},
     {"id":"claude-haiku-4-5-20251001","name":"Haiku 4.5","runtime":"claude","reasoning_efforts":["low","medium","high"]},
     {"id":"gpt-5.5","name":"GPT-5.5","runtime":"codex","reasoning_efforts":["low","medium","high"]}
    ]}
    """#

    private func catalog() throws -> [ModelDto] {
        try JSONDecoder().decode(ModelsResponse.self, from: Data(Self.catalogJson.utf8)).models
    }

    @Test func catalogDecodesWithoutFable51() throws {
        let ids = try catalog().map(\.id)
        #expect(ids.contains("claude-fable-5-2"))
        #expect(!ids.contains("claude-fable-5-1"))
    }

    @Test func pickerOffersExactlyTheServerCatalog() throws {
        let models = try catalog()
        let groups = ModelPickerSheet.groups(models)
        let offered = groups.flatMap { $0.1.map(\.id) }
        #expect(Set(offered) == Set(models.map(\.id)))
        #expect(offered.count == models.count)
        #expect(!offered.contains("claude-fable-5-1"))
        #expect(groups.map(\.0) == ["Claude", "OpenAI"])
        let claude = groups.first { $0.0 == "Claude" }?.1.map(\.id) ?? []
        #expect(claude.first == "claude-fable-5-2") // server order kept within a group
    }

    @Test func emptyCatalogOffersNothing() {
        // No private fallback list: an empty/failed catalog shows no rows.
        #expect(ModelPickerSheet.groups([]).isEmpty)
    }

    @Test func historicalFable51KeepsProviderAndName() throws {
        let models = try catalog()
        #expect(ModelProvider.for("claude-fable-5-1") == .claude)
        // Not in the catalog → readable id; must not borrow the "Fable 5" catalog name.
        #expect(UsageUx.modelName("claude-fable-5-1", catalog: models) == "Claude Fable 5.1")
        #expect(UsageUx.modelName("claude-fable-5-2", catalog: models) == "Fable 5.2")
        #expect(UsageUx.modelName("claude-fable-5", catalog: models) == "Fable 5")
        #expect(AgentConfigHistoryUx.value("model", .string("claude-fable-5-1")) == "claude-fable-5-1")
    }
}
