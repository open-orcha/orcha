import Foundation

// Responsibility: Run-feed JSON visibility, summarization, parsing, and truncation helpers.

extension RunFeed {
    // MARK: value helpers (mirror Android RunFeed.kt)

    /// Web selfAction: a tool call whose INPUT hits an orcha skill or a self-serve API path.
    static func selfAction(_ input: Any?) -> Bool {
        let s = jsonDetail(input).lowercased()
        return orchaSkillRe.matches(s) || orchaApiRe.matches(s)
    }

    static func jsonDetail(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        return elementToString(v)
    }

    /// Web visibleText: dig the human-readable text out of the common content shapes.
    static func visibleText(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return numberString(n) }
        if let arr = v as? [Any] { return joinLines(arr.map { visibleText($0) }) }
        if let o = v as? [String: Any] {
            if let s = o["text"] as? String { return s }
            if let s = o["output_text"] as? String { return s }
            if let s = o["summary_text"] as? String { return s }
            if let s = o["message"] as? String { return s }
            if let s = o["content"] as? String { return s }
            if let s = o["output"] as? String { return s }
            if let arr = o["content"] as? [Any] { return visibleText(arr) }
            if let arr = o["output"] as? [Any] { return visibleText(arr) }
        }
        return ""
    }

    /// Web summaryText: reasoning-summary extraction (strings only, unlike visibleText).
    static func summaryText(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        if v is NSNumber { return "" }
        if let arr = v as? [Any] { return joinLines(arr.map { summaryText($0) }) }
        if let o = v as? [String: Any] {
            if let s = o["text"] as? String { return s }
            if let s = o["summary_text"] as? String { return s }
            if let s = o["content"] as? String, summaryWordRe.matches((o["type"] as? String ?? "").lowercased()) { return s }
            if let arr = o["content"] as? [Any] { return summaryText(arr) }
        }
        return ""
    }

    /// Kotlin `.joinToString("\n").lines().filter { it.isNotEmpty() }.joinToString("\n")` —
    /// join everything, then drop empty LINES (not empty elements). Web filters elements, but
    /// this is a 1:1 Android port so the line-filter behavior is the anchor.
    static func joinLines(_ parts: [String]) -> String {
        parts.joined(separator: "\n").components(separatedBy: "\n").filter { !$0.isEmpty }.joined(separator: "\n")
    }

    /// Kotlin `(x as? JsonPrimitive)?.contentOrNull` for primitives — the scalar's string form,
    /// nil for JSON null / objects / arrays.
    static func primitiveString(_ v: Any?) -> String? {
        guard let v, !(v is NSNull) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return numberString(n) }
        return nil
    }

    static func numberString(_ n: NSNumber) -> String {
        CFGetTypeID(n) == CFBooleanGetTypeID() ? (n.boolValue ? "true" : "false") : n.stringValue
    }

    /// JSON-serialize a value to its `.toString()`/`JSON.stringify` form: strings come back
    /// quoted, `NSNull` → "null". `.fragmentsAllowed` permits bare scalars; `.withoutEscapingSlashes`
    /// matches JS not escaping `/`.
    static func elementToString(_ v: Any) -> String {
        if v is NSNull { return "null" }
        if let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .withoutEscapingSlashes]),
           let s = String(data: d, encoding: .utf8) {
            return s
        }
        if let s = v as? String { return s }
        return String(describing: v)
    }

    /// Parse one line into a JSON object. No `.fragmentsAllowed`: a bare scalar or a JSON array
    /// line fails the `[String: Any]` cast → nil → the narrate/log fallback (Kotlin `as? JsonObject`).
    static func parseObject(_ line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    /// Kotlin `JsonObject.str` — the value only when it is a JSON string.
    static func str(_ o: [String: Any], _ key: String) -> String? {
        o[key] as? String
    }

    static func trunc(_ s: String, _ n: Int) -> String {
        s.count <= n ? s : String(s.prefix(n - 1)) + "…"
    }
}
