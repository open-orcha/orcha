import SwiftUI
import Testing
import UIKit
@testable import Orcha

/// GH #378: Show more / Show less rules, and the measured-overflow check against real SwiftUI layout
/// for the five comment shapes the issue names (short, long, formatted, extremely large, unbroken).
enum CommentFixtures {
    static let short = "Pushed the fix. Tests are green on both platforms."
    static let long = Array(repeating: "I traced the stall to the notifier scan loop and moved the inventory to a background pass.",
                            count: 8).joined(separator: " ")
    static let formatted = """
    **Root cause:** the scan waits on `git worktree list`. See [PR 412](https://github.com/open-orcha/orcha/pull/412).
    - move the inventory to a background pass
    - or cap it at 50 worktrees
    """ + "\n" + Array(repeating: "`notifier_policy.py:118` holds the timeout.", count: 8).joined(separator: "\n")
    static let huge = String(repeating: "word ", count: 800) // the 4,000-character comment cap
    static let unbroken = "https://example.com/" + String(repeating: "a1b2c3d4e5", count: 60)
}

@Suite struct CommentExpansionRuleTests {
    @Test func controlOnlyWhenOverflowedOrExpanded() {
        #expect(!CommentExpansion.showsControl(overflowed: false, expanded: false))
        #expect(CommentExpansion.showsControl(overflowed: true, expanded: false))
        #expect(CommentExpansion.showsControl(overflowed: false, expanded: true))
    }

    @Test func toggleIsPerCommentId() {
        var open: Set<String> = []
        open = CommentExpansion.toggled(open, "a")
        open = CommentExpansion.toggled(open, "b")
        open = CommentExpansion.toggled(open, "a")
        #expect(open == ["b"])
    }

    @Test func showLessScrollsBackOnlyWhenTheTopIsOutOfSight() {
        #expect(CommentExpansion.revealsOnCollapse(expanded: true, topY: -120))
        #expect(!CommentExpansion.revealsOnCollapse(expanded: true, topY: 40))
        #expect(!CommentExpansion.revealsOnCollapse(expanded: false, topY: -120)) // Show more never scrolls
        #expect(CommentExpansion.rowAnchor("m1") != CommentExpansion.rowAnchor("m2"))
    }

    @Test func showLessOnAnyScreenTargetsTheTextsTopJustUnderTheEdge() {
        // Read on 1000 points past a text that starts at 150: come back to just above its top.
        #expect(CommentExpansion.revealOffset(textTop: 150, contentOffsetY: 1150, insetTop: 0) == 142)
        // Under a navigation bar the visible top is the inset, not zero.
        #expect(CommentExpansion.revealOffset(textTop: 150, contentOffsetY: 1000, insetTop: 100) == 42)
        // Never above the scroll view's own start.
        #expect(CommentExpansion.revealOffset(textTop: 4, contentOffsetY: 300, insetTop: 100) == -100)
        // Top already in sight: stay put.
        #expect(CommentExpansion.revealOffset(textTop: 150, contentOffsetY: 100, insetTop: 0) == nil)
        #expect(CommentExpansion.revealOffset(textTop: 150, contentOffsetY: 100, insetTop: 50) == nil)
    }

    @Test func labelsAndAnnouncedState() {
        #expect(CommentExpansion.controlLabel(expanded: false) == "Show more")
        #expect(CommentExpansion.controlLabel(expanded: true) == "Show less")
        #expect(CommentExpansion.stateDescription(expanded: false) == "Collapsed")
        #expect(CommentExpansion.stateDescription(expanded: true) == "Expanded")
        #expect(CommentExpansion.collapsedLines == 6)
    }

    @Test func overflowNeedsARealHeightDifference() {
        #expect(!CommentExpansion.overflowed(fullHeight: 100, cappedHeight: 100))
        #expect(!CommentExpansion.overflowed(fullHeight: 100.3, cappedHeight: 100))
        #expect(CommentExpansion.overflowed(fullHeight: 140, cappedHeight: 100))
    }
}

@MainActor
@Suite struct CommentOverflowLayoutTests {
    /// Height of the comment text at `width`, capped at the collapse limit or not, at a text size.
    private func height(_ text: String, width: CGFloat, capped: Bool, size: DynamicTypeSize = .large) -> CGFloat {
        let view = Text(ChatMarkdown.inline(text))
            .font(.body)
            .lineLimit(capped ? CommentExpansion.collapsedLines : nil)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: width, alignment: .leading)
            .environment(\.dynamicTypeSize, size)
        let host = UIHostingController(rootView: view)
        return host.sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
    }

    private func overflows(_ text: String, width: CGFloat = 320, size: DynamicTypeSize = .large) -> Bool {
        CommentExpansion.overflowed(fullHeight: height(text, width: width, capped: false, size: size),
                                    cappedHeight: height(text, width: width, capped: true, size: size))
    }

    @Test func shortCommentNeverOverflows() {
        #expect(!overflows(CommentFixtures.short))
        #expect(!overflows(CommentFixtures.short, width: 393))
    }

    @Test func longCommentOverflows() { #expect(overflows(CommentFixtures.long)) }

    @Test func formattedCommentOverflowsAndKeepsLinks() {
        #expect(overflows(CommentFixtures.formatted))
        #expect(ChatMarkdown.inline(CommentFixtures.formatted).runs.contains { $0.link != nil })
    }

    @Test func extremelyLargeCommentOverflowsAndExpandsToFullHeight() {
        #expect(overflows(CommentFixtures.huge))
        #expect(height(CommentFixtures.huge, width: 320, capped: false) > height(CommentFixtures.huge, width: 320, capped: true) * 10)
    }

    @Test func unbrokenStringWrapsInsteadOfWidening() {
        #expect(overflows(CommentFixtures.unbroken))
        let host = UIHostingController(rootView: Text(CommentFixtures.unbroken).fixedSize(horizontal: false, vertical: true).frame(width: 320))
        #expect(host.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)).width <= 320.5)
    }

    @Test func largerTextOverflowsSooner() {
        let medium = Array(repeating: "Short sentence here.", count: 9).joined(separator: " ")
        #expect(overflows(medium, size: .accessibility5))
    }
}
