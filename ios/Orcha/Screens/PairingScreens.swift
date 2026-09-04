import SwiftUI
import VisionKit

/// Flow 03 — QR scanner (frame I1) with the camera-permission-denied state (I2).
/// DataScannerViewController reads the QR; payloads run through the same
/// normalize+probe path as manual entry. Cloud: when the probe hits the auth
/// perimeter, the scanner hands off to the auth options — scan → sign in with
/// GitHub (only when required) → connected.
struct ScannerScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let onManualEntry: () -> Void
    let onTokenRequired: () -> Void
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
                            if model.connectNeedsToken {
                                onTokenRequired()
                            } else {
                                onManualEntry()
                            }
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
                        Button("Can't scan? Enter the address") {
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
                        KitButton(title: "Enter the address instead", role: .neutral) {
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

/// The step between "scanned the QR" and "connected" on a protected
/// deployment, now an options sheet: the primary way in is "Sign in with
/// GitHub" — the browser round-trip mints a per-device token and pairing
/// resumes by itself. Pasting a team access token stays available, collapsed,
/// as the advanced fallback. Headline path: scan → sign in → connected.
struct AuthOptionsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @State private var showTokenEntry = false
    @State private var token = ""
    @FocusState private var tokenFocused: Bool

    /// Just the host, for the copy — the draft may be a raw QR payload.
    private var host: String {
        guard let draft = model.connectDraft,
              let base = try? OrchaServerAddress.parse(draft).baseUrl,
              let url = URL(string: base) else { return "This Orcha" }
        return url.host ?? "This Orcha"
    }

    private var phase: DeviceAuthFlow.Phase { model.deviceAuth.phase }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    private var busy: Bool {
        phase == .signingIn || phase == .connecting || model.connecting
    }

    private var signInTitle: String {
        switch phase {
        case .signingIn: "Waiting for GitHub…"
        case .connecting: "Connecting…"
        default: "Sign in with GitHub"
        }
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(spacing: 12) {
                        Banner(kind: .info, text: "\(host) is protected. Sign in with GitHub and this phone gets its own device token — nothing to paste.")
                        KitButton(title: signInTitle, enabled: !busy, systemImage: "arrow.up.forward.app") {
                            Task {
                                if await model.signInWithGitHub() { dismiss() }
                            }
                        }
                        if case let .failed(message) = phase {
                            Banner(kind: .danger, text: message)
                        }
                        tokenFallback
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear { model.resetDeviceAuth() }
        .interactiveDismissDisabled(phase == .connecting)
    }

    /// The advanced path, collapsed by default: the pasted team access token —
    /// the same secure field the flow always had.
    private var tokenFallback: some View {
        OrchaCard {
            Button {
                withAnimation(.spring(duration: 0.3)) { showTokenEntry.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "key.horizontal")
                        .font(.system(size: 14))
                        .foregroundStyle(p.accent)
                    Text("Use an access token instead")
                        .font(p.uiFont(14, .semibold))
                        .foregroundStyle(p.text)
                    Spacer()
                    Image(systemName: showTokenEntry ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(p.faint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showTokenEntry {
                SecureField("Access token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($tokenFocused)
                    .padding(12)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                Text("Advanced: paste the team access token your admin shared. Sign-in above does this for you.")
                    .font(p.uiFont(12))
                    .foregroundStyle(p.faint)
                KitButton(
                    title: model.connecting ? "Connecting…" : "Connect with token",
                    role: .neutral,
                    enabled: !busy && !token.trimmingCharacters(in: .whitespaces).isEmpty
                ) {
                    Task {
                        guard let draft = model.connectDraft else { return }
                        if await model.connect(draft, accessToken: token) {
                            dismiss()
                        }
                    }
                }
                if let error = model.error, !isFailed {
                    Banner(kind: .danger, text: error)
                }
            }
        }
        .onChange(of: showTokenEntry) { _, shown in
            if shown { tokenFocused = true }
        }
    }
}

/// Flow 03 — manual entry (frame A4) + the unreachable checklist state (A3).
/// Cloud-first: the primary path is the deployed portal's address (https, no
/// port needed) plus the team access token when the deployment is protected.
/// Local self-host addresses (http, host:port) keep working unchanged.
struct ManualConnectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var token = ""
    @State private var failed = false
    @State private var showSelfHostHelp = false
    @FocusState private var focus: Field?

    private enum Field { case address, token }

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
        .onAppear {
            // A scan that bounced off the auth perimeter lands here with the
            // address already captured — only the token is missing.
            if let draft = model.connectDraft, address.isEmpty {
                address = draft
                focus = model.connectNeedsToken ? .token : .address
            }
        }
    }

    private func tryConnect() {
        Task {
            if await model.connect(address, accessToken: token) {
                dismiss()
            } else if !model.connectNeedsToken {
                failed = true
            }
            // needs-token: stay on the form — the danger banner + focus do the asking
        }
    }

    private var form: some View {
        ScrollView {
            VStack(spacing: 12) {
                Banner(
                    kind: .info,
                    text: "Enter your Orcha's address — for a cloud deployment that's the portal domain, like orcha.yourteam.com. Scanning the portal's Pair-phone QR fills this in for you."
                )
                TextField("Address or QR payload", text: $address, prompt: Text("orcha.yourteam.com"), axis: .vertical)
                    .lineLimit(1...5)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .focused($focus, equals: .address)
                    .padding(12)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                SecureField("Access token (if required)", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .token)
                    .padding(12)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                Text("Cloud deployments sit behind a sign-in — connect and you'll get a Sign in with GitHub option, or paste the team access token your admin shared. Leave the token empty for an unprotected local server.")
                    .font(p.uiFont(12))
                    .foregroundStyle(p.faint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                KitButton(
                    title: model.connecting ? "Connecting…" : "Connect",
                    enabled: !model.connecting && !address.trimmingCharacters(in: .whitespaces).isEmpty
                ) {
                    tryConnect()
                }
                if let error = model.error, !failed {
                    Banner(kind: .danger, text: error)
                }
                if model.connectNeedsToken {
                    // The perimeter bounced this address: GitHub sign-in is the
                    // primary way through — it mints this phone's device token
                    // and retries the connect by itself.
                    KitButton(title: "Sign in with GitHub instead", role: .tonal, enabled: !model.connecting) {
                        Task {
                            if await model.signInWithGitHub() { dismiss() }
                        }
                    }
                }
                selfHostHelp
            }
            .padding(16)
        }
    }

    /// Collapsed explainer for the self-host path: local Wi-Fi entry and the
    /// optional Tailscale remote address. The cloud path never needs any of it.
    private var selfHostHelp: some View {
        OrchaCard {
            Button {
                withAnimation(.spring(duration: 0.3)) { showSelfHostHelp.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 14))
                        .foregroundStyle(p.accent)
                    Text("Running Orcha on your own computer?")
                        .font(p.uiFont(14, .semibold))
                        .foregroundStyle(p.text)
                    Spacer()
                    Image(systemName: showSelfHostHelp ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(p.faint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showSelfHostHelp {
                VStack(alignment: .leading, spacing: 10) {
                    Text("A cloud portal works from anywhere and none of this applies. Self-hosting on your own machine instead? Then the phone talks straight to that computer:")
                    step(1, "On the same Wi-Fi, enter the computer's address with the portal port, e.g. 192.168.1.24:8001. No access token needed unless you put one in front of it.")
                    step(2, "To check in from outside that Wi-Fi, install Tailscale (free for personal use) on this iPhone and on the computer, signed into the same account — an encrypted tunnel between your own devices.")
                    step(3, "Add the computer's Tailscale address under Settings → Containers → “Add remote…”, e.g. my-mac.tailnet.ts.net:8001. The app then uses whichever address answers, switching automatically as you come and go.")
                    Text("The only requirement while you're out: the computer must be awake.")
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
            title: "Can't reach this Orcha",
            sub: "\(address.isEmpty ? "That address" : address) didn't answer. Your work is safe — the phone just can't see it right now.",
            danger: true
        ) {
            Image(systemName: "wifi.slash")
                .font(p.uiFont(30))
                .foregroundStyle(p.danger)
        } actions: {
            VStack(spacing: 12) {
                OrchaCard {
                    Text("1  Is the address right? A cloud portal needs no port.")
                    Text("2  Is the deployment up — or, self-hosting, is the computer awake with Orcha running?")
                    Text("3  On a local address: same Wi-Fi, and no firewall or VPN in the way?")
                }
                .font(p.uiFont(13))
                .foregroundStyle(p.text2)
                KitButton(title: "Try again", role: .neutral, enabled: !model.connecting) {
                    Task {
                        if await model.connect(address, accessToken: token) {
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
