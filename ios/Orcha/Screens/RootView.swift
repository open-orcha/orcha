import SwiftUI

/// App root: Containers home until a workspace is open, then the tabbed workspace.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
            Group {
                if model.selectedContainer == nil {
                    ContainersHomeScreen()
                } else {
                    WorkspaceScreen()
                }
            }
            .toastOverlay()
        }
    }
}

/// Snackbar-ish transient feedback for AppModel.toast (iOS top-banner idiom).
private struct ToastOverlay: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let toast = model.toast {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(p.uiFont(13, .bold))
                        .foregroundStyle(p.ok)
                    Text(toast)
                        .font(p.uiFont(13, .semibold))
                        .foregroundStyle(p.text)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 10)
                .modifier(ToastSurface(raised: p.raised, border: p.border2))
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task {
                    try? await Task.sleep(for: .seconds(2.4))
                    model.toast = nil
                }
            }
        }
        .animation(.spring(duration: 0.35), value: model.toast != nil)
    }
}

extension View {
    func toastOverlay() -> some View {
        modifier(ToastOverlay())
    }
}

/// Toast chrome: Liquid Glass capsule on iOS 26, raised-surface capsule earlier.
private struct ToastSurface: ViewModifier {
    let raised: Color
    let border: Color

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(.regular, in: .capsule)
        } else {
            content
                .background(raised, in: Capsule())
                .overlay(Capsule().strokeBorder(border, lineWidth: 1))
                .shadow(color: .black.opacity(0.25), radius: 14, y: 6)
        }
    }
}
