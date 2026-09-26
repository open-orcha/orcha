import SwiftUI

/// ChatGPT-style dictation: tap the mic and your words stream straight into
/// the bound text field (volatile hypothesis included, so the field updates
/// live as the recognizer refines). Tap again to stop; the field keeps the
/// finalized transcript for editing before send. iOS 26+ only (the on-device
/// SpeechAnalyzer stack) — earlier OSes simply don't show the mic.
struct DictationMicButton: View {
    @Binding var text: String

    var body: some View {
        if #available(iOS 26, *) {
            DictationMicCore(text: $text)
        }
    }
}

@available(iOS 26, *)
private struct DictationMicCore: View {
    @Environment(\.palette) private var p
    @Binding var text: String
    @State private var engine = DictationEngine()
    /// The field's content when dictation started — live results replace
    /// everything after it, and cancel restores it.
    @State private var base = ""
    @State private var showError = false

    var body: some View {
        Button {
            switch engine.state {
            case .recording, .preparing:
                Task {
                    let transcript = await engine.stop()
                    text = joined(base, transcript)
                }
            default:
                base = text
                Task { await engine.start() }
            }
        } label: {
            ZStack {
                if engine.state == .recording {
                    Circle()
                        .fill(p.danger.opacity(0.18 + 0.5 * Double(engine.level)))
                        .frame(width: 34, height: 34)
                        .animation(.linear(duration: 0.08), value: engine.level)
                }
                Image(systemName: micGlyph)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(micColor)
                    .frame(width: 34, height: 34)
                    .contentShape(Circle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(engine.state == .recording ? "Stop dictation" : "Dictate a message")
        .onChange(of: engine.liveText) { _, live in
            // Words appear in the field as you speak.
            if engine.isActive { text = joined(base, live) }
        }
        .onChange(of: engine.state.failureMessage) { _, message in
            showError = message != nil
        }
        .onDisappear {
            if engine.isActive {
                engine.cancel()
                text = base
            }
        }
        .alert("Dictation", isPresented: $showError) {
            Button("OK") { engine.cancel() }
        } message: {
            Text(engine.state.failureMessage ?? "")
        }
    }

    private var micGlyph: String {
        switch engine.state {
        case .recording: "stop.circle.fill"
        case .preparing, .finishing: "ellipsis"
        default: "mic.fill"
        }
    }

    private var micColor: Color {
        switch engine.state {
        case .recording: p.danger
        case .preparing, .finishing: p.muted
        default: p.accent
        }
    }

    private func joined(_ head: String, _ tail: String) -> String {
        guard !tail.isEmpty else { return head }
        guard !head.isEmpty else { return tail }
        return head.hasSuffix(" ") || head.hasSuffix("\n") ? head + tail : head + " " + tail
    }
}
