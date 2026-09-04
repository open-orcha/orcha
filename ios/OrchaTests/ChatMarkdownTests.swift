import Foundation
import Testing
@testable import Orcha

/// The chat-markdown block parser (web `mdText` parity: headings, bold/italic,
/// inline code, fenced blocks, lists, links, rules) and the task-ref pass.

@Suite struct ChatMarkdownBlockTests {

    @Test func plainProseIsOneParagraph() {
        #expect(ChatMarkdown.blocks("hello world") == [.paragraph("hello world")])
    }

    @Test func blankLinesSplitParagraphs() {
        let blocks = ChatMarkdown.blocks("first line\nsame paragraph\n\nsecond paragraph")
        #expect(blocks == [
            .paragraph("first line\nsame paragraph"),
            .paragraph("second paragraph"),
        ])
    }

    @Test func headingsParseAndClampToChatScale() {
        #expect(ChatMarkdown.blocks("# Title") == [.heading(level: 1, text: "Title")])
        #expect(ChatMarkdown.blocks("### Sub") == [.heading(level: 3, text: "Sub")])
        // h5/h6 clamp to chat-scale h4, matching the portal.
        #expect(ChatMarkdown.blocks("###### tiny") == [.heading(level: 4, text: "tiny")])
    }

    @Test func headingNeedsASpaceAfterHashes() {
        // "#hashtag" is prose, not a heading (same rule as the portal's regex).
        #expect(ChatMarkdown.blocks("#hashtag") == [.paragraph("#hashtag")])
    }

    @Test func fencedCodeIsVerbatimAndNeverFormatted() {
        let src = "before\n```swift\nlet **x** = 1\n# not a heading\n```\nafter"
        #expect(ChatMarkdown.blocks(src) == [
            .paragraph("before"),
            .code("let **x** = 1\n# not a heading"),
            .paragraph("after"),
        ])
    }

    @Test func unclosedFenceRunsToTheEnd() {
        let blocks = ChatMarkdown.blocks("```\nstill code\nmore code")
        #expect(blocks == [.code("still code\nmore code")])
    }

    @Test func horizontalRules() {
        #expect(ChatMarkdown.blocks("---") == [.rule])
        #expect(ChatMarkdown.blocks("a\n\n***\n\nb") == [.paragraph("a"), .rule, .paragraph("b")])
    }

    @Test func unorderedAndOrderedListItems() {
        let blocks = ChatMarkdown.blocks("- one\n- two\n3. three")
        #expect(blocks == [
            .listItem(depth: 0, marker: "•", text: "one"),
            .listItem(depth: 0, marker: "•", text: "two"),
            .listItem(depth: 0, marker: "3.", text: "three"),
        ])
    }

    @Test func nestedListDepthFromTwoSpaceIndent() {
        let blocks = ChatMarkdown.blocks("- top\n  - nested\n    - deeper")
        #expect(blocks == [
            .listItem(depth: 0, marker: "•", text: "top"),
            .listItem(depth: 1, marker: "•", text: "nested"),
            .listItem(depth: 2, marker: "•", text: "deeper"),
        ])
    }

    @Test func windowsNewlinesAreNormalized() {
        #expect(ChatMarkdown.blocks("a\r\n\r\nb") == [.paragraph("a"), .paragraph("b")])
    }

    @Test func emptySourceYieldsNoBlocks() {
        #expect(ChatMarkdown.blocks("") == [])
        #expect(ChatMarkdown.blocks("\n\n") == [])
    }
}

@Suite struct ChatMarkdownInlineTests {

    @Test func boldItalicAndCodeCarryPresentationIntents() throws {
        let attr = ChatMarkdown.inline("a **bold** and *soft* and `mono` word")
        var intents: [InlinePresentationIntent] = []
        for run in attr.runs {
            if let intent = run.inlinePresentationIntent { intents.append(intent) }
        }
        #expect(intents.contains { $0.contains(.stronglyEmphasized) })
        #expect(intents.contains { $0.contains(.emphasized) })
        #expect(intents.contains { $0.contains(.code) })
    }

    @Test func linksCarryTheirURL() {
        let attr = ChatMarkdown.inline("see [docs](https://example.com/x)")
        let links = attr.runs.compactMap(\.link)
        #expect(links == [URL(string: "https://example.com/x")!])
        #expect(String(attr.characters).contains("docs"))
    }

    @Test func malformedMarkdownDegradesToPlainText() {
        let attr = ChatMarkdown.inline("broken **bold")
        #expect(!String(attr.characters).isEmpty)
    }

    @Test func inlineOnlyNeverSwallowsWhitespace() {
        let attr = ChatMarkdown.inline("line one\nline two")
        #expect(String(attr.characters) == "line one\nline two")
    }
}

@Suite struct ChatMarkdownTaskRefTests {

    private let tasks = [
        TaskDto(id: "e4b77f3f-0000-0000-0000-000000000000", title: "Fix the gate"),
        TaskDto(id: "aabbccdd-1111-1111-1111-111111111111", title: "Other"),
    ]

    @Test func shortPrefixBecomesATaskLink() {
        let attr = ChatMarkdown.inline("see e4b77f3f for context", tasks: tasks)
        let links = attr.runs.compactMap(\.link)
        #expect(links == [MobileUx.taskLinkURL("e4b77f3f-0000-0000-0000-000000000000")!])
    }

    @Test func unresolvedIdStaysPlain() {
        let attr = ChatMarkdown.inline("see 12345678 for context", tasks: tasks)
        #expect(attr.runs.compactMap(\.link).isEmpty)
    }

    @Test func idInsideInlineCodeIsLeftAlone() {
        let attr = ChatMarkdown.inline("run `orcha show e4b77f3f` locally", tasks: tasks)
        #expect(attr.runs.compactMap(\.link).isEmpty)
    }

    @Test func idInsideAnExistingLinkIsLeftAlone() {
        let attr = ChatMarkdown.inline("[e4b77f3f](https://example.com)", tasks: tasks)
        let links = attr.runs.compactMap(\.link)
        #expect(links == [URL(string: "https://example.com")!])
    }

    @Test func midTokenHexIsNotALink() {
        // A longer hex blob whose PREFIX happens to match must not linkify.
        let attr = ChatMarkdown.inline("sha deadbeefcafe0123 here", tasks: [
            TaskDto(id: "deadbeef-2222-2222-2222-222222222222", title: "T"),
        ])
        #expect(attr.runs.compactMap(\.link).isEmpty)
    }
}
