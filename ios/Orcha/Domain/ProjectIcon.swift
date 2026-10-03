import Foundation

/// D14 project icon — the shape the portal, desktop app and backend share
/// (`portal_backend/project_icons.py`):
///   `{"kind":"emoji","value":"🚀"}` or `{"kind":"glyph","value":<glyph>,"color":0-9|null}`.
/// `null` (no icon) is modelled as `ProjectIcon?` = nil, rendered as the neutral cube glyph
/// (never initials — web rule). Decoding never throws: an unknown kind or malformed value
/// becomes `.unknown`, which also renders as the default glyph.
enum ProjectIcon: Equatable, Sendable {
    case emoji(String)
    case glyph(String, color: Int?)
    case unknown
}

extension ProjectIcon: Codable {
    private enum Keys: String, CodingKey { case kind, value, color }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: Keys.self),
              let kind = try? c.decode(String.self, forKey: .kind),
              let value = try? c.decode(String.self, forKey: .value) else {
            self = .unknown
            return
        }
        switch kind {
        case "emoji": self = .emoji(value)
        case "glyph": self = .glyph(value, color: (try? c.decodeIfPresent(Int.self, forKey: .color)) ?? nil)
        default: self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        if case .unknown = self {
            var single = encoder.singleValueContainer()
            try single.encodeNil()
            return
        }
        var c = encoder.container(keyedBy: Keys.self)
        if case let .emoji(value) = self {
            try c.encode("emoji", forKey: .kind)
            try c.encode(value, forKey: .value)
        } else if case let .glyph(value, color) = self {
            try c.encode("glyph", forKey: .kind)
            try c.encode(value, forKey: .value)
            try c.encode(color, forKey: .color)
        }
    }

    /// The JSON body value for `PUT /api/containers/{cid}/icon` (`NSNull` = clear).
    var jsonValue: Any {
        switch self {
        case let .emoji(value): ["kind": "emoji", "value": value]
        case let .glyph(value, color): ["kind": "glyph", "value": value, "color": color.map { $0 as Any } ?? NSNull()]
        case .unknown: NSNull()
        }
    }
}

/// Pure helpers for rendering and editing project icons.
enum ProjectIconUx {
    /// Backend `PROJECT_ICON_GLYPHS`, in the web picker's order.
    static let glyphs: [String] = [
        "box", "folder", "code", "terminal", "rocket", "globe", "smartphone", "server",
        "database", "cloud", "cpu", "bot", "zap", "flask", "shield", "book", "briefcase",
        "cart", "gamepad", "music", "camera", "palette", "heart", "star", "leaf", "wrench",
        "chart", "mail",
    ]

    /// The default (no icon / unknown) glyph.
    static let defaultGlyph = "box"

    /// Extra search words per glyph (web `GLYPH_WORDS`); the name always matches too.
    static let glyphWords: [String: String] = [
        "box": "cube package default", "code": "dev brackets", "terminal": "cli shell",
        "globe": "web world site", "smartphone": "mobile phone app ios android",
        "server": "backend api", "database": "db data sql", "cpu": "chip hardware",
        "bot": "ai robot agent", "zap": "fast lightning", "flask": "lab science experiment",
        "shield": "security", "book": "docs documentation", "briefcase": "work business",
        "cart": "shop store commerce", "gamepad": "game", "chart": "analytics metrics", "mail": "email",
    ]

    /// Closest SF Symbol for each Lucide glyph the web/desktop draw.
    static let sfSymbols: [String: String] = [
        "box": "shippingbox", "folder": "folder", "code": "chevron.left.forwardslash.chevron.right",
        "terminal": "apple.terminal", "rocket": "airplane.departure", "globe": "globe",
        "smartphone": "iphone", "server": "server.rack", "database": "cylinder.split.1x2",
        "cloud": "cloud", "cpu": "cpu", "bot": "brain.head.profile", "zap": "bolt",
        "flask": "flask", "shield": "shield", "book": "book", "briefcase": "briefcase",
        "cart": "cart", "gamepad": "gamecontroller", "music": "music.note", "camera": "camera",
        "palette": "paintpalette", "heart": "heart", "star": "star", "leaf": "leaf",
        "wrench": "wrench.adjustable", "chart": "chart.bar", "mail": "envelope",
    ]

    /// Shared avatar palette hues (web/desktop `AVATAR_HUES`, D13) — a glyph colour slot 0-9.
    static let hues: [Double] = [4, 30, 50, 95, 145, 178, 208, 238, 272, 318]

    /// Quick-pick emoji row for the editor.
    static let quickEmoji = ["🚀", "📦", "💻", "🧪", "🛠️", "📱", "🌐", "🤖", "⚡️", "📊", "🎮", "❤️"]

    static func sfSymbol(for glyph: String) -> String {
        sfSymbols[glyph] ?? sfSymbols[defaultGlyph]!
    }

    /// The SF Symbol to show for an icon (default cube for nil / unknown / emoji fallback).
    static func sfSymbol(for icon: ProjectIcon?) -> String {
        if case let .glyph(name, _) = icon { return sfSymbol(for: name) }
        return sfSymbol(for: defaultGlyph)
    }

    /// Glyphs matching a search query (name or `glyphWords`, case-insensitive).
    static func search(_ query: String) -> [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return glyphs }
        return glyphs.filter { g in
            g.contains(q) || (glyphWords[g] ?? "").split(separator: " ").contains { $0.hasPrefix(q) }
        }
    }

    /// HSB components for a colour slot — web `hsl(hue, s, l)` per theme (v2-tokens.css:
    /// dark 70%/70%, light 55%/42%), converted to HSB for SwiftUI. nil slot = neutral.
    static func glyphHSB(slot: Int?, dark: Bool) -> (h: Double, s: Double, b: Double)? {
        guard let slot else { return nil }
        let n = hues.count
        let hue = hues[((slot % n) + n) % n] / 360
        let (s, l) = dark ? (0.70, 0.70) : (0.55, 0.42)
        let v = l + s * min(l, 1 - l)
        let sv = v == 0 ? 0 : 2 * (1 - l / v)
        return (hue, sv, v)
    }

    /// Backend `is_emoji`: short text with at least one pictographic code point — never a
    /// word, never markup.
    static func isEmoji(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf16.count <= 16 else { return false }
        if value.unicodeScalars.contains(where: { $0.isASCII && $0.properties.isAlphabetic }) { return false }
        if value.contains(where: { "<>&\"'".contains($0) }) { return false }
        if value.unicodeScalars.contains(where: { $0.value == 0xFE0F }) { return true }
        return value.unicodeScalars.contains { s in
            (0x1F1E6...0x1F1FF).contains(s.value) || s.value == 0x20E3
                || (s.properties.generalCategory == .otherSymbol && s.value >= 0x2000)
        }
    }

    /// Accessibility description ("Rocket icon", "Emoji 🚀", "Default icon").
    static func accessibilityLabel(_ icon: ProjectIcon?) -> String {
        switch icon {
        case let .emoji(value): "Emoji \(value)"
        case let .glyph(name, _): "\(name.capitalized) icon"
        default: "Default icon"
        }
    }

    /// The server's 422 `detail` text (FastAPI `{"detail": "..."}`), when present.
    static func serverDetail(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let detail = obj["detail"] as? String, !detail.isEmpty else { return nil }
        return detail.prefix(1).uppercased() + detail.dropFirst()
    }
}
