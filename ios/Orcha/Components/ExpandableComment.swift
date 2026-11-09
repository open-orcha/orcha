import SwiftUI

/// GH #378: a comment collapsed to `CommentExpansion.collapsedLines` with an inline Show more / Show less.
///
/// `content` is the formatted text (it must honour `.lineLimit`). Overflow is measured, never counted:
/// the capped text's height is compared with a hidden, unconstrained copy at the same width, so short
/// comments never get a control and Dynamic Type or a narrow screen re-measures on its own. The caller
/// owns `expanded` per comment id, so recycled rows never inherit it. `onCollapsedOffscreen` runs when
/// Show less is tapped after the comment's top has scrolled out of sight, so the caller can scroll back.
/// `header` (author and time) reads with the text as one VoiceOver element; the control stays its own button.
struct ExpandableComment<Header: View, Content: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let expanded: Bool
    let onToggle: () -> Void
    var collapsedLines: Int = CommentExpansion.collapsedLines
    var onCollapsedOffscreen: (() -> Void)? = nil
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content

    @State private var cappedHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0
    @State private var overflowed = false
    /// Where the comment's top sits in the task page's scroll view. A plain reference, so scrolling
    /// never re-renders the comment.
    @State private var top = TopEdge()

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
            if CommentExpansion.showsControl(overflowed: overflowed, expanded: expanded) {
                Button {
                    let reveal = CommentExpansion.revealsOnCollapse(expanded: expanded, topY: top.minY)
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                        onToggle()
                        if reveal { onCollapsedOffscreen?() }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(CommentExpansion.controlLabel(expanded: expanded))
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .ltype(.meta)
                    .foregroundStyle(p.accent)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(CommentToggleStyle())
                .accessibilityLabel(CommentExpansion.controlLabel(expanded: expanded))
                .accessibilityValue(CommentExpansion.stateDescription(expanded: expanded))
                .accessibilityIdentifier("comment-toggle")
            }
        }
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
