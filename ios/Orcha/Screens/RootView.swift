import SwiftUI

/// App root: Containers home until a workspace is open, then the tabbed workspace.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        OrchaThemed(mode: model.themeMode) {
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
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(p.ok)
                    Text(toast)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(p.text)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 10)
                .background(p.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(p.border2, lineWidth: 1))
                .shadow(color: .black.opacity(0.25), radius: 14, y: 6)
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
