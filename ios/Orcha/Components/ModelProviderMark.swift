import SwiftUI

/// The provider's brand mark (Claude / OpenAI) for a model id or runtime name — renders
/// nothing when the provider is unknown. Artwork: simple-icons (CC0), vendored verbatim
/// from the desktop app's `brandMarks.tsx` as vector SVG imagesets. Claude keeps its brand
/// colour (#D97757); OpenAI is a template image tinted with the palette's text colour.
struct ModelProviderMark: View {
    let model: String?
    var size: CGFloat = 14

    init(model: String?, size: CGFloat = 14) {
        self.model = model
        self.size = size
    }

    var body: some View {
        if let provider = ModelProvider.for(model) {
            ProviderMarkImage(provider: provider, size: size)
        }
    }
}

/// The mark for a known provider (used directly by group headers).
struct ProviderMarkImage: View {
    @Environment(\.palette) private var p
    @ScaledMetric private var scale: CGFloat = 1
    let provider: ModelProvider
    var size: CGFloat = 14

    var body: some View {
        Image(provider.assetName)
            .resizable()
            .renderingMode(provider == .openai ? .template : .original)
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size * scale, height: size * scale)
            .foregroundStyle(p.text)
            .accessibilityLabel(provider.label)
    }
}
