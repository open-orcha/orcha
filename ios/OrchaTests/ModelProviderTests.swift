import Testing
@testable import Orcha

@Suite("ModelProvider mapping")
struct ModelProviderTests {
    @Test("Claude model ids and runtime map to Claude", arguments: [
        "claude", "claude-opus-4-1", "opus", "Sonnet 4.5", "claude-haiku-4-5", "fable", "anthropic", " CLAUDE ",
    ])
    func claude(_ input: String) {
        #expect(ModelProvider.for(input) == .claude)
    }

    @Test("OpenAI model ids and runtime map to OpenAI", arguments: [
        "codex", "gpt-5", "gpt-5-codex", "GPT-4o", "o1", "o3", "o4-mini", "openai/o3-pro", "openai",
    ])
    func openai(_ input: String) {
        #expect(ModelProvider.for(input) == .openai)
    }

    @Test("Unknown, blank or nil map to nil", arguments: [
        nil, "", "   ", "default", "gemini-2.5-pro", "llama3", "foo3", "aider", "mistral-o1x",
    ] as [String?])
    func none(_ input: String?) {
        #expect(ModelProvider.for(input) == nil)
    }

    @Test func labelsAndAssets() {
        #expect(ModelProvider.claude.label == "Claude")
        #expect(ModelProvider.openai.label == "OpenAI")
        #expect(ModelProvider.claude.assetName == "BrandClaude")
        #expect(ModelProvider.openai.assetName == "BrandOpenAI")
    }
}
