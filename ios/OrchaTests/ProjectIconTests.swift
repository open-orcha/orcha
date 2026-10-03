import Foundation
import Testing
@testable import Orcha

@Suite("Project icons (D14)")
struct ProjectIconTests {
    private func decodeContainer(_ iconJSON: String) throws -> ContainerDto {
        let json = #"{"id":"c1","name":"Demo","status":"active","icon":"# + iconJSON + "}"
        return try JSONDecoder().decode(ContainerDto.self, from: Data(json.utf8))
    }

    @Test func decodesEmoji() throws {
        #expect(try decodeContainer(#"{"kind":"emoji","value":"🚀"}"#).icon == .emoji("🚀"))
    }

    @Test func decodesGlyphWithAndWithoutColour() throws {
        #expect(try decodeContainer(#"{"kind":"glyph","value":"rocket","color":3}"#).icon == .glyph("rocket", color: 3))
        #expect(try decodeContainer(#"{"kind":"glyph","value":"code","color":null}"#).icon == .glyph("code", color: nil))
        #expect(try decodeContainer(#"{"kind":"glyph","value":"code"}"#).icon == .glyph("code", color: nil))
    }

    @Test func nullAndMissingAreNil() throws {
        #expect(try decodeContainer("null").icon == nil)
        let json = #"{"id":"c1","name":"Demo","status":"active"}"#
        #expect(try JSONDecoder().decode(ContainerDto.self, from: Data(json.utf8)).icon == nil)
    }

    @Test("Unknown kinds and malformed values never fail the container", arguments: [
        #"{"kind":"image","value":"x.png"}"#, #"{"kind":"glyph"}"#, #""rocket""#, "42", "[]",
    ])
    func tolerant(_ iconJSON: String) throws {
        let dto = try decodeContainer(iconJSON)
        #expect(dto.name == "Demo")
        #expect(dto.icon == .unknown)
    }

    @Test func putResponseDecodes() throws {
        let json = #"{"container_id":"c1","icon":{"kind":"glyph","value":"zap","color":0}}"#
        let r = try JSONDecoder().decode(ContainerIconResponse.self, from: Data(json.utf8))
        #expect(r.icon == .glyph("zap", color: 0))
        let cleared = try JSONDecoder().decode(ContainerIconResponse.self, from: Data(#"{"container_id":"c1","icon":null}"#.utf8))
        #expect(cleared.icon == nil)
    }

    @Test func jsonBodyShapes() throws {
        let glyph = try JSONSerialization.data(withJSONObject: ProjectIcon.glyph("box", color: nil).jsonValue, options: .sortedKeys)
        #expect(String(decoding: glyph, as: UTF8.self) == #"{"color":null,"kind":"glyph","value":"box"}"#)
        let emoji = ProjectIcon.emoji("🚀").jsonValue as? [String: String]
        #expect(emoji == ["kind": "emoji", "value": "🚀"])
    }

    @Test("Backend is_emoji accepts", arguments: ["🚀", "❤️", "🇰🇪", "1️⃣", "👩‍💻", "⚡️", "★"])
    func emojiAccepted(_ value: String) {
        #expect(ProjectIconUx.isEmoji(value))
    }

    @Test("Backend is_emoji rejects", arguments: ["", "a", "rocket", "🚀a", "<🚀>", "123", "©", String(repeating: "🚀", count: 9)])
    func emojiRejected(_ value: String) {
        #expect(!ProjectIconUx.isEmoji(value))
    }

    @Test func everyBackendGlyphMaps() {
        #expect(ProjectIconUx.glyphs.count == 28)
        #expect(Set(ProjectIconUx.glyphs).count == 28)
        for g in ProjectIconUx.glyphs {
            #expect(ProjectIconUx.sfSymbols[g] != nil, "missing SF Symbol for \(g)")
        }
        #expect(Set(ProjectIconUx.sfSymbols.keys) == Set(ProjectIconUx.glyphs))
        #expect(Set(ProjectIconUx.glyphWords.keys).isSubset(of: Set(ProjectIconUx.glyphs)))
    }

    @Test func defaultIsCubeNeverInitials() {
        #expect(ProjectIconUx.sfSymbol(for: nil as ProjectIcon?) == "shippingbox")
        #expect(ProjectIconUx.sfSymbol(for: ProjectIcon.unknown) == "shippingbox")
        #expect(ProjectIconUx.sfSymbol(for: ProjectIcon.glyph("nope", color: nil)) == "shippingbox")
    }

    @Test func searchUsesNamesAndWords() {
        #expect(ProjectIconUx.search("").count == 28)
        #expect(ProjectIconUx.search("robot") == ["bot"])
        #expect(ProjectIconUx.search("sql") == ["database"])
        #expect(ProjectIconUx.search("ROCK") == ["rocket"])
        #expect(ProjectIconUx.search("zzz").isEmpty)
    }

    @Test func coloursFollowTheAvatarHues() throws {
        #expect(ProjectIconUx.hues == [4, 30, 50, 95, 145, 178, 208, 238, 272, 318])
        #expect(ProjectIconUx.glyphHSB(slot: nil, dark: true) == nil)
        let c = try #require(ProjectIconUx.glyphHSB(slot: 6, dark: true))
        #expect(abs(c.h - 208.0 / 360) < 0.0001)
        // hsl(_, 70%, 70%) → hsb brightness 0.91
        #expect(abs(c.b - 0.91) < 0.001)
        #expect(ProjectIconUx.glyphHSB(slot: 12, dark: false)?.h == ProjectIconUx.glyphHSB(slot: 2, dark: false)?.h)
    }

    @Test func serverDetailText() {
        #expect(ProjectIconUx.serverDetail(#"{"detail":"icon value must be one emoji"}"#) == "Icon value must be one emoji")
        #expect(ProjectIconUx.serverDetail("oops") == nil)
    }
}
