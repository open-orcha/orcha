import SwiftUI
import Testing
import UIKit
@testable import Orcha

/// GH #378 review fixes: task links in collapsible comments, and the verification Result scrolling back on Show less.
@MainActor @Suite(.serialized) struct CommentLinksAndRevealTests {
    private let linked = TaskDto(id: "1a2b3c4d-0000-4000-8000-000000000001", title: "Linked task")

    @Test func taskReferenceBecomesAnInAppTaskLink() {
        let attr = ChatMarkdownView.styledInline("Blocked on 1a2b3c4d first. " + CommentFixtures.long, tasks: [linked],
                                                 portalLinks: false, portalBase: nil, accent: .blue)
        #expect(attr.runs.compactMap(\.link).compactMap(MobileUx.taskIdFromLinkURL) == [linked.id])
    }

    @Test func tappingATaskLinkOpensTheTask() throws {
        var opened: [String] = []
        let routing = ChatMarkdownView.linkRouting(onTapTask: { opened.append($0) }, onTapPortal: nil)
        routing(try #require(MobileUx.taskLinkURL(linked.id)))
        #expect(opened == [linked.id])
    }

    @Test func collapsingTheResultScrollsBackToIt() async throws {
        let state = ResultState()
        let host = UIHostingController(rootView: ResultRevealHost(state: state))
        // A window on the test host's scene, so SwiftUI runs real update passes (scrollTo needs them).
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 600)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        let scroll = try #require(scrollView(in: host.view))
        let reveal = try #require(state.reveal)
        // Read on past the Result's top (scrolled through SwiftUI, so its scroll state follows).
        reveal(ResultRevealHost.farAnchor)
        try await Task.sleep(for: .milliseconds(300))
        host.view.layoutIfNeeded()
        #expect(scroll.contentOffset.y > 150)
        // What Show less does when the Result's top is out of sight (VerificationCard's onCollapsedOffscreen).
        state.expanded = false
        reveal(CommentExpansion.resultAnchor)
        try await Task.sleep(for: .milliseconds(400))
        host.view.layoutIfNeeded()
        #expect(scroll.contentOffset.y <= 150, "the Result starts at 150 and must be back in view")
    }

    /// GH #378 review round 3: Show less on a screen with no scroll-back wiring of its own (any
    /// `ExpandableText`) still brings the text's top back into view.
    @Test func showLessOnAnyScreenScrollsBackToTheText() async throws {
        let box = RevealMarker.Box()
        let host = UIHostingController(rootView: PlainScrollHost(box: box))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 600)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        let scroll = try #require(scrollView(in: host.view))
        // The reader scrolls on, well past the text's top (at 150).
        scroll.setContentOffset(CGPoint(x: 0, y: 1200), animated: false)
        host.view.layoutIfNeeded()
        let visibleTop = { scroll.contentOffset.y + scroll.adjustedContentInset.top }
        #expect(visibleTop() > 150)
        box.revealTop(animated: false)
        try await Task.sleep(for: .milliseconds(300))
        host.view.layoutIfNeeded()
        #expect(visibleTop() <= 150, "the text's top must be back in view")
        #expect(visibleTop() >= 130, "and just above it, not back at the start of the page")
        // Already in view: a second Show less does not move the page.
        let settled = scroll.contentOffset.y
        box.revealTop(animated: false)
        #expect(scroll.contentOffset.y == settled)
    }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
    }
}

@MainActor private final class ResultState: ObservableObject {
    @Published var expanded = true
    var reveal: RevealCommentAction?
}

/// The task page's scroll plumbing around a long Result with content below it.
private struct ResultRevealHost: View {
    static let farAnchor = "far-below-the-result"
    @ObservedObject var state: ResultState
    var body: some View {
        ScrollView {
            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    Color.clear.frame(height: 150)
                    VStack(alignment: .leading) {
                        Text("Result")
                        ExpandableComment(expanded: state.expanded, onToggle: { state.expanded.toggle() }) {
                            Text(String(repeating: "A long task result with enough words to read and scroll. ", count: 65))
                        }
                    }
                    .id(CommentExpansion.resultAnchor)
                    Color.clear.frame(height: 1000)
                    Color.clear.frame(height: 1).id(Self.farAnchor)
                    Color.clear.frame(height: 2000)
                }
                .onAppear { state.reveal = RevealCommentAction { proxy.scrollTo($0, anchor: .top) } }
            }
        }
        .coordinateSpace(.named(CommentExpansion.scrollSpace))
    }
}

/// An ordinary screen: a plain ScrollView with long text and more content below it, no ScrollViewReader.
private struct PlainScrollHost: View {
    let box: RevealMarker.Box
    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 150)
                Text(String(repeating: "A long description with enough words to read and scroll. ", count: 65))
                    .fixedSize(horizontal: false, vertical: true)
                    .background { RevealMarker(box: box) }
                Color.clear.frame(height: 3000)
            }
        }
    }
}
