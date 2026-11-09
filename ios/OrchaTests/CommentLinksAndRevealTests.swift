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
