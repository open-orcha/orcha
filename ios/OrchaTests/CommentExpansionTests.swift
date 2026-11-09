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

    /// QA round 1: Home's summary is the server's first 140 characters, so Show more must fetch the rest.
    @Test func homeSummaryAtTheServerCutIsTreatedAsCut() {
        #expect(!CommentExpansion.summaryMayBeCut(CommentFixtures.short))
        #expect(CommentExpansion.summaryMayBeCut(String(CommentFixtures.long.prefix(140))))
        #expect(!CommentExpansion.summaryMayBeCut(String(CommentFixtures.long.prefix(139))))
        // The server counts characters (Unicode scalars): 70 two-scalar flags are 140 of them.
        #expect(CommentExpansion.summaryMayBeCut(String(repeating: "🇮🇳", count: 70)))
    }

    private static let at = "2026-11-09T12:00:00.673000+00:00"

    private func comment(_ body: String, by author: String = "Original author", at time: String = at,
                         human: Bool = false) -> TaskMessageDto {
        TaskMessageDto(body: body, messageId: "m", authorAlias: author, isHuman: human, createdAt: time)
    }

    @Test func completeBodyIsTheNewestMessageOnlyWhenItContinuesTheSummary() {
        let full = CommentFixtures.long
        let summary = comment(String(full.prefix(140)))
        #expect(CommentExpansion.completeBody(summary: summary, newest: comment(full)) == full)
        #expect(CommentExpansion.completeBody(summary: summary, newest: comment("A newer comment")) == nil)
        #expect(CommentExpansion.completeBody(summary: summary, newest: nil) == nil)
        // A cut through a flag (one character on screen, two scalars) still matches its full comment.
        let flags = String(repeating: "🇮🇳", count: 80)
        let cutFlags = String(String.UnicodeScalarView(flags.unicodeScalars.prefix(141)))
        #expect(CommentExpansion.completeBody(summary: comment(cutFlags), newest: comment(flags)) == flags)
    }

    /// Review round 6: a newer comment that opens with the same 140 characters must not expand under the
    /// old author and time.
    @Test func newerCommentWithTheSamePrefixIsNotTheSummarysComment() {
        let summary = comment(String(CommentFixtures.long.prefix(140)))
        let newer = summary.body + " NEWER COMMENT END"
        #expect(CommentExpansion.completeBody(summary: summary, newest: comment(newer, at: "2026-11-09T12:01:00Z")) == nil)
        #expect(CommentExpansion.completeBody(summary: summary, newest: comment(newer, by: "Someone else")) == nil)
        #expect(CommentExpansion.completeBody(summary: summary, newest: comment(newer, human: true)) == nil)
        #expect(CommentExpansion.completeBody(summary: comment(summary.body, at: ""), newest: comment(newer, at: "")) == nil)
    }

    /// The same time written two ways (Postgres trims the fraction's zeros, the thread keeps six digits).
    @Test func sameCommentMatchesTheSameInstantInEitherFormat() {
        let summary = comment(String(CommentFixtures.long.prefix(140)), at: "2026-11-09T12:00:00.673+00:00")
        let full = comment(CommentFixtures.long, at: "2026-11-09T12:00:00.673000+00:00")
        #expect(CommentExpansion.completeBody(summary: summary, newest: full) == CommentFixtures.long)
        #expect(CommentExpansion.isSameComment(comment("x", at: "2026-11-09T12:00:00Z"),
                                               comment("x", at: "2026-11-09T12:00:00.000000+00:00")))
    }

    /// Review round 6: the Home row expands after its fetch, outside the button's transaction, so it must
    /// ask for no animation under Reduce Motion itself.
    @Test func toggleAnimationIsOffUnderReduceMotion() {
        #expect(CommentExpansion.toggleAnimation(reduceMotion: true) == nil)
        #expect(CommentExpansion.toggleAnimation(reduceMotion: false) != nil)
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
