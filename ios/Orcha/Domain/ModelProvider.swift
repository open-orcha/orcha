import Foundation

/// The vendor behind a model id or runtime name — drives the provider mark shown next to
/// models/runtimes (same mapping as the desktop app's brand marks and the Android app).
enum ModelProvider: String, CaseIterable, Sendable {
    case claude, openai

    /// Display name, also the mark's accessibility label.
    var label: String {
        switch self {
        case .claude: "Claude"
        case .openai: "OpenAI"
        }
    }

    /// Asset-catalog image name (vector SVG imagesets).
    var assetName: String {
        switch self {
        case .claude: "BrandClaude"
        case .openai: "BrandOpenAI"
        }
    }

    /// Maps a model id ("claude-opus-4", "gpt-5-codex", "o3") or runtime ("claude", "codex")
    /// to its provider; nil when unknown, blank or nil.
    /// Claude: claude / anthropic / opus / sonnet / haiku / fable.
    /// OpenAI: gpt / codex / openai, or a standalone o1 / o3 / o4 token ("o3", "o4-mini").
    static func `for`(_ model: String?) -> ModelProvider? {
        guard let raw = model?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !raw.isEmpty else { return nil }
        if ["claude", "anthropic", "opus", "sonnet", "haiku", "fable"].contains(where: raw.contains) {
            return .claude
        }
        if ["gpt", "codex", "openai"].contains(where: raw.contains) { return .openai }
        let tokens = raw.split { !$0.isLetter && !$0.isNumber }
        if tokens.contains(where: { ["o1", "o3", "o4"].contains($0) }) { return .openai }
        return nil
    }
}
