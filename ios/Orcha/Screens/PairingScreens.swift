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
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                        Button("Can't scan? Enter manually") {
                            dismiss()
                            onManualEntry()
                        }
                        .font(.system(size: 14, weight: .bold))
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
                        .font(.system(size: 30))
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
                .font(.system(size: 17, weight: .semibold))
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

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
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
            }
            .padding(16)
        }
    }

    private var unreachable: some View {
        StateLayout(
            title: "Can't reach your laptop",
            sub: "\(address.isEmpty ? "That address" : address) didn't answer. Your work is safe — the phone just can't see it right now.",
            danger: true
        ) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 30))
                .foregroundStyle(p.danger)
        } actions: {
            VStack(spacing: 12) {
                OrchaCard {
                    Text("1  Is the phone on the same Wi-Fi as the laptop?")
                    Text("2  Is the laptop awake and Orcha running?")
                    Text("3  Firewall or VPN blocking the port?")
                }
                .font(.system(size: 13))
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
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(p.accent)
            }
        }
    }
}
