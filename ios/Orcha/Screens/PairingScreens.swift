import SwiftUI
import VisionKit

/// Flow 03 — QR scanner (frame I1) with the camera-permission-denied state (I2).
/// DataScannerViewController reads the QR; payloads run through the same
/// normalize+probe path as manual entry.
struct ScannerScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let onManualEntry: () -> Void
    @State private var scanned = false

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if scannerAvailable {
                QRScannerRepresentable { payload in
                    guard !scanned else { return }
                    scanned = true
                    Task {
                        if await model.connect(payload) {
                            dismiss()
                        } else {
                            dismiss()
                            onManualEntry()
                        }
                    }
                }
                .ignoresSafeArea()
                VStack {
                    Spacer()
                    VStack(spacing: 10) {
                        Text("Scan the QR from your Orcha portal")
                            .font(p.uiFont(15, .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                        Button("Can't scan? Enter manually") {
                            dismiss()
                            onManualEntry()
                        }
                        .font(p.uiFont(14, .bold))
                        .foregroundStyle(p.accent)
                    }
                    .padding(.bottom, 48)
                    .frame(maxWidth: .infinity)
                }
            } else {
                // I2 — camera unavailable / permission denied
                StateLayout(
                    title: "Camera access needed",
                    sub: "Orcha uses the camera only to read the pairing QR from your portal. Grant access in Settings, or type the address instead.",
                    danger: true
                ) {
                    Image(systemName: "camera.slash")
                        .font(p.uiFont(30))
                        .foregroundStyle(p.danger)
                } actions: {
                    VStack(spacing: 10) {
                        KitButton(title: "Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .frame(maxWidth: 240)
                        KitButton(title: "Enter code manually", role: .neutral) {
                            dismiss()
                            onManualEntry()
                        }
                        .frame(maxWidth: 240)
                    }
                }
                .background(p.bg)
            }
            Button("Close", systemImage: "xmark") { dismiss() }
                .labelStyle(.iconOnly)
                .font(p.uiFont(17, .semibold))
                .foregroundStyle(scannerAvailable ? .white : p.text)
                .padding(16)
        }
        .background(.black)
    }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in added {
                if case let .barcode(code) = item, let value = code.payloadStringValue {
                    onScan(value)
                    return
                }
            }
        }
    }
}

/// Flow 03 — manual entry fallback (frame A4) + the unreachable checklist state (A3).
struct ManualConnectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var failed = false
    @State private var showRemoteHelp = false

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                Group {
                    if failed {
                        unreachable
                    } else {
                        form
                    }
                }
            }
            .navigationTitle("Add your Orcha")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var form: some View {
        ScrollView {
            VStack(spacing: 12) {
                Banner(
                    kind: .info,
                    text: "The portal's Pair-phone QR endpoint is still in review — until it ships, paste an orcha-pair payload or enter the laptop's Wi-Fi address."
                )
                TextField("Address or QR payload", text: $address, prompt: Text("192.168.1.24:8001"), axis: .vertical)
                    .lineLimit(1...5)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .padding(12)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                KitButton(
                    title: model.connecting ? "Connecting…" : "Connect",
                    enabled: !model.connecting && !address.trimmingCharacters(in: .whitespaces).isEmpty
                ) {
                    Task {
                        if await model.connect(address) {
                            dismiss()
                        } else {
                            failed = true
                        }
                    }
                }
                if let error = model.error, !failed {
                    Banner(kind: .danger, text: error)
                }
                remoteHelp
            }
            .padding(16)
        }
    }

    /// The pair-phone workflow's optional remote-access explainer: how to set up
    /// Tailscale, and how the app hands off between the local and remote address
    /// when you leave home Wi-Fi. Collapsed by default — local-only pairing
    /// stays a one-field flow.
    private var remoteHelp: some View {
        OrchaCard {
            Button {
                withAnimation(.spring(duration: 0.3)) { showRemoteHelp.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "network")
                        .font(.system(size: 14))
                        .foregroundStyle(p.accent)
                    Text("Want to check in from anywhere?")
                        .font(p.uiFont(14, .semibold))
                        .foregroundStyle(p.text)
                    Spacer()
                    Image(systemName: showRemoteHelp ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(p.faint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showRemoteHelp {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Out of the box, Orcha is local-only: the phone talks directly to your computer on your Wi-Fi, and nothing goes through any cloud. To supervise your agents from anywhere, add Tailscale — a free (for personal use) encrypted tunnel between your own devices. Nothing gets exposed to the internet.")
                    step(1, "Install Tailscale on this iPhone (App Store) and on your computer (tailscale.com), and sign both into the same account.")
                    step(2, "Find the computer's Tailscale address: run “tailscale ip -4” on it, or use its name from the Tailscale menu, e.g. my-mac.tailnet.ts.net.")
                    step(3, "Pair here on Wi-Fi as usual, then open Settings → Containers → “Add remote…” and enter that address with the portal port, e.g. 100.x.y.z:8001.")
                    Text("From then on the switch is automatic: the app uses whichever address answers. Leave home Wi-Fi and the local address goes quiet, so the next refresh fails over to the Tailscale address — and back again the same way. You'll see a “Connected via …” note when it hands off. The only requirement while you're out: the computer must be awake.")
                }
                .font(p.uiFont(13))
                .foregroundStyle(p.text2)
            }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text("\(n)")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(p.accent)
                .frame(width: 18, height: 18)
                .background(p.accentSoft, in: RoundedRectangle(cornerRadius: p.radiusTag + 4))
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var unreachable: some View {
        StateLayout(
            title: "Can't reach your laptop",
            sub: "\(address.isEmpty ? "That address" : address) didn't answer. Your work is safe — the phone just can't see it right now.",
            danger: true
        ) {
            Image(systemName: "wifi.slash")
                .font(p.uiFont(30))
                .foregroundStyle(p.danger)
        } actions: {
            VStack(spacing: 12) {
                OrchaCard {
                    Text("1  Is the phone on the same Wi-Fi as the laptop?")
                    Text("2  Is the laptop awake and Orcha running?")
                    Text("3  Firewall or VPN blocking the port?")
                }
                .font(p.uiFont(13))
                .foregroundStyle(p.text2)
                KitButton(title: "Try again", role: .neutral, enabled: !model.connecting) {
                    Task {
                        if await model.connect(address) {
                            dismiss()
                        }
                    }
                }
                .frame(maxWidth: 220)
                Button("Back") { failed = false }
                    .font(p.uiFont(14, .bold))
                    .foregroundStyle(p.accent)
            }
        }
    }
}
