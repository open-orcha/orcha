import Foundation

/// Chat-scale markdown for agent-authored turn content (web `mdText` parity, the
/// subset the portal renders: headings, bold/italic, inline code, fenced blocks,
/// lists, links, horizontal rules, paragraphs).
///
/// Approach — the most maintainable native split:
///   * BLOCK segmentation is a small custom pass (fenced code, headings, rules,
///     list items, paragraphs) because Foundation's full-markdown init flattens
///     blocks into PresentationIntents that SwiftUI `Text` ignores.
///   * INLINE formatting inside each block goes through
///     `AttributedString(markdown:)` with `.inlineOnlyPreservingWhitespace` —
///     bold, italic, `code`, and [links](…) parse natively, and fenced-block
///     content never reaches it (verbatim by construction).
/// There is no HTML sink (SwiftUI `Text`), so escape-safety is structural; link
/// FOLLOWING is still restricted by the rendering view (http(s) + the in-app
/// task scheme only).
enum ChatMarkdown {

    /// One rendered block. `listItem.marker` is presentation-ready ("•" / "3.").
    enum Block: Equatable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case code(String)
        case listItem(depth: Int, marker: String, text: String)
        case rule
    }

    // MARK: block segmentation

    private static let headingRe = /^ {0,3}(#{1,6})\s+(.+)$/
    private static let ruleRe = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
    private static let listRe = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(\S.*)$/

    static func blocks(_ src: String) -> [Block] {
        let lines = src.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        var out: [Block] = []
        var para: [String] = []

        func flushParagraph() {
            guard !para.isEmpty else { return }
            out.append(.paragraph(para.joined(separator: "\n")))
            para.removeAll()
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code ```lang … ``` — contents verbatim, never inline-formatted.
            if trimmed.hasPrefix("```") {
                flushParagraph()
                var body: [String] = []
                var j = i + 1
                while j < lines.count, !lines[j].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    body.append(lines[j])
                    j += 1
                }
                out.append(.code(body.joined(separator: "\n")))
                i = j + 1               // skip the closing fence (or run off the end)
                continue
            }
            if trimmed.isEmpty {         // blank line = paragraph break
                flushParagraph()
                i += 1
                continue
            }
            if let m = line.wholeMatch(of: headingRe) {
                flushParagraph()
                // h5/h6 clamp to chat-scale h4, matching the portal.
                let level = min(m.1.count, 4)
                out.append(.heading(level: level, text: String(m.2).trimmingCharacters(in: .whitespaces)))
                i += 1
                continue
            }
            if line.wholeMatch(of: ruleRe) != nil {
                flushParagraph()
                out.append(.rule)
                i += 1
                continue
            }
            if let m = line.wholeMatch(of: listRe) {
                flushParagraph()
                let indent = m.1.replacingOccurrences(of: "\t", with: "  ").count
                let marker = m.3.map { "\($0)." } ?? "•"
                out.append(.listItem(depth: indent / 2, marker: marker, text: String(m.4)))
                i += 1
                continue
            }
            para.append(line)
            i += 1
        }
        flushParagraph()
        return out
    }

    // MARK: inline formatting

    /// Inline markdown (bold / italic / `code` / links) via Foundation's parser;
    /// a malformed span degrades to the plain text, never an error.
    static func inline(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    /// Inline formatting + bare task-id references made tappable (GH #140 parity
    /// with `LinkedMessageText`): tokens resolving to a real task get the in-app
    /// `orcha-task:` link. Existing links and inline-code runs are left alone.
    static func inline(_ text: String, tasks: [TaskDto]) -> AttributedString {
        linkifyTaskRefs(inline(text), tasks: tasks)
    }

    private static let taskRefRe = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?/

    static func linkifyTaskRefs(_ attr: AttributedString, tasks: [TaskDto]) -> AttributedString {
        guard !tasks.isEmpty else { return attr }
        // Collect (character offset, length, url) first — indices are only safe on
        // the instance they came from, so mutations re-resolve offsets below.
        var links: [(offset: Int, length: Int, url: URL)] = []
        for run in attr.runs {
            guard run.link == nil else { continue }
            if let intent = run.inlinePresentationIntent, intent.contains(.code) { continue }
            let runOffset = attr.characters.distance(from: attr.startIndex, to: run.range.lowerBound)
            let text = String(attr.characters[run.range])
            for m in text.matches(of: taskRefRe) {
                // Word-boundary guard (the regex itself can't anchor mid-run cheaply).
                if m.range.lowerBound > text.startIndex,
                   isWordChar(text[text.index(before: m.range.lowerBound)]) { continue }
                if m.range.upperBound < text.endIndex, isWordChar(text[m.range.upperBound]) { continue }
                guard let task = MobileUx.resolveTaskRef(String(m.0), in: tasks),
                      let url = MobileUx.taskLinkURL(task.id) else { continue }
                links.append((
                    offset: runOffset + text.distance(from: text.startIndex, to: m.range.lowerBound),
                    length: text.distance(from: m.range.lowerBound, to: m.range.upperBound),
                    url: url
                ))
            }
        }
        guard !links.isEmpty else { return attr }
        var result = attr
        for link in links {
            let start = result.characters.index(result.startIndex, offsetBy: link.offset)
            let end = result.characters.index(start, offsetBy: link.length)
            result[start..<end].link = link.url
        }
        return result
    }

    private static func isWordChar(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_" || c == "-"
    }
}
