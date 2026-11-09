import SwiftUI

/// GH #378: a comment collapsed to `CommentExpansion.collapsedLines` with an inline Show more / Show less.
///
/// `content` is the formatted text (it must honour `.lineLimit`). Overflow is measured, never counted:
/// the capped text's height is compared with a hidden, unconstrained copy at the same width, so short
/// comments never get a control and Dynamic Type or a narrow screen re-measures on its own. The caller
/// owns `expanded` per comment id, so recycled rows never inherit it. `onCollapsedOffscreen` runs when
/// Show less is tapped after the comment's top has scrolled out of sight, so the caller can scroll back;
/// without it, Show less scrolls the nearest enclosing scroll view back to the comment's top itself.
/// `header` (author and time) reads with the text as one VoiceOver element; the control stays its own button.
struct ExpandableComment<Header: View, Content: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let expanded: Bool
    let onToggle: () -> Void
    var collapsedLines: Int = CommentExpansion.collapsedLines
    var onCollapsedOffscreen: (() -> Void)? = nil
    /// The text shown is a known shortened copy (Home's 140-character summary), so Show more appears even
    /// when it fits; the caller fetches the complete comment in `onToggle` before expanding.
    var knownCut: Bool = false
    /// Show more is fetching the complete comment: the control reads "Loading…" and ignores taps.
    var loading: Bool = false
    /// Lines the control up under indented text (Home's update rows indent past the avatar).
    var controlLeading: CGFloat = 0
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content

    @State private var cappedHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0
    @State private var overflowed = false
    /// Where the comment's top sits in the task page's scroll view. A plain reference, so scrolling
    /// never re-renders the comment.
    @State private var top = TopEdge()
    /// The comment's own UIKit view, for scrolling back on screens without `onCollapsedOffscreen`.
    @State private var marker = RevealMarker.Box()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                header()
                content()
                    .lineLimit(expanded ? nil : collapsedLines)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(alignment: .topLeading) { measuring }
                    .onPreferenceChange(CommentHeightsKey.self) { heights in
                        cappedHeight = heights.capped
                        fullHeight = heights.full
                        if !expanded {
                            overflowed = CommentExpansion.overflowed(fullHeight: heights.full, cappedHeight: heights.capped)
                        }
                    }
            }
            .accessibilityElement(children: .combine)
            if CommentExpansion.showsControl(overflowed: overflowed || knownCut, expanded: expanded) {
                Button {
                    if expanded, onCollapsedOffscreen == nil {
                        // Scroll first, then collapse below the reader's eye: the comment's top does not
                        // move while it shrinks, so the target stays right.
                        marker.revealTop(animated: !reduceMotion)
                    }
                    let reveal = CommentExpansion.revealsOnCollapse(expanded: expanded, topY: top.minY)
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                        onToggle()
                        if reveal { onCollapsedOffscreen?() }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(loading ? CommentExpansion.loadingLabel : CommentExpansion.controlLabel(expanded: expanded))
                        if loading {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .accessibilityHidden(true)
                        }
                    }
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .padding(.leading, controlLeading)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(CommentToggleStyle())
                .disabled(loading)
                .accessibilityLabel(loading ? CommentExpansion.loadingLabel : CommentExpansion.controlLabel(expanded: expanded))
                .accessibilityValue(CommentExpansion.stateDescription(expanded: expanded))
                .accessibilityIdentifier("comment-toggle")
            }
        }
        .background { RevealMarker(box: marker) }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .named(CommentExpansion.scrollSpace)).minY
        } action: { minY in
            top.minY = minY
        }
    }

    /// The capped text's own height plus a hidden unconstrained copy at the same width.
    private var measuring: some View {
        GeometryReader { capped in
            content()
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: capped.size.width, alignment: .leading)
                .hidden()
                .accessibilityHidden(true)
                .background(GeometryReader { full in
                    Color.clear.preference(key: CommentHeightsKey.self,
                                           value: .init(capped: capped.size.height, full: full.size.height))
                })
        }
    }
}

extension ExpandableComment where Header == EmptyView {
    /// A comment with no header of its own (the verification card's Result).
    init(expanded: Bool, onToggle: @escaping () -> Void, collapsedLines: Int = CommentExpansion.collapsedLines,
         onCollapsedOffscreen: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.init(expanded: expanded, onToggle: onToggle, collapsedLines: collapsedLines,
                  onCollapsedOffscreen: onCollapsedOffscreen, header: { EmptyView() }, content: content)
    }
}

/// Any capped display text people need to read in full (GH #378: "everywhere", not only comments).
/// The same measured Show more / Show less as `ExpandableComment`, owning its own open/closed state.
/// Text that fits never gets a control, so a screen looks the same until something is cut off.
/// `header` (optional) reads with the text as one VoiceOver element, as in `ExpandableComment`.
struct ExpandableText<Header: View, Content: View>: View {
    var collapsedLines: Int = CommentExpansion.collapsedLines
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content
    @State private var expanded = false

    var body: some View {
        ExpandableComment(expanded: expanded, onToggle: { expanded.toggle() },
                          collapsedLines: collapsedLines, header: header, content: content)
    }
}

extension ExpandableText where Header == EmptyView {
    init(collapsedLines: Int = CommentExpansion.collapsedLines, @ViewBuilder content: @escaping () -> Content) {
        self.init(collapsedLines: collapsedLines, header: { EmptyView() }, content: content)
    }
}

private final class TopEdge {
    var minY: CGFloat = 0
}

/// An invisible UIKit view the size of the comment. SwiftUI's ScrollView and List are both UIKit scroll
/// views underneath, so from here Show less can find whichever one holds the comment on any screen and
/// scroll its top back into sight, with no wiring in the screen itself (GH #378 review round 3).
struct RevealMarker: UIViewRepresentable {
    final class Box {
        weak var view: UIView?

        /// Scrolls every enclosing scroll view that has the comment's top above its visible area.
        @MainActor func revealTop(animated: Bool) {
            guard let view else { return }
            var ancestor = view.superview
            while let current = ancestor {
                if let scroll = current as? UIScrollView {
                    let frame = view.convert(view.bounds, to: scroll)
                    if let y = CommentExpansion.revealOffset(textTop: frame.minY,
                                                             contentOffsetY: scroll.contentOffset.y,
                                                             insetTop: scroll.adjustedContentInset.top) {
                        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: animated)
                    }
                }
                ancestor = current.superview
            }
        }
    }

    let box: Box

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        view.backgroundColor = .clear
        box.view = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) { box.view = view }
}

/// Scrolls an Activity row back to the top of the task page (set by the page that owns the scroll view).
struct RevealCommentAction {
    let reveal: (String) -> Void
    func callAsFunction(_ anchor: String) { reveal(anchor) }
}

private struct RevealCommentKey: EnvironmentKey {
    static let defaultValue: RevealCommentAction? = nil
}

extension EnvironmentValues {
    var revealComment: RevealCommentAction? {
        get { self[RevealCommentKey.self] }
        set { self[RevealCommentKey.self] = newValue }
    }
}

/// Dimmed while pressed; the system focus ring shows for keyboard / Switch Control focus.
private struct CommentToggleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.45 : 1)
    }
}

private struct CommentHeightsKey: PreferenceKey {
    struct Heights: Equatable { var capped: CGFloat = 0; var full: CGFloat = 0 }
    static var defaultValue = Heights()
    static func reduce(value: inout Heights, nextValue: () -> Heights) {
        let next = nextValue()
        if next.full > 0 || next.capped > 0 { value = next }
    }
}
