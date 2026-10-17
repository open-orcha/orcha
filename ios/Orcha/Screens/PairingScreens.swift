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
                            PairingHaptics.success()
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
                ScannerFrameOverlay(scanned: scanned) {
                    dismiss()
                    onManualEntry()
                }
            } else {
                // I2 — camera unavailable / permission denied
                StateLayout(
                    title: "Camera access needed",
                    sub: "Embodent uses the camera only to read the pairing QR from your portal. Grant access in Settings, or type the address instead.",
                    danger: true
                ) {
                    Image(systemName: "camera.slash")
                        .font(.system(size: 28, weight: .regular))
                        .foregroundStyle(p.danger)
                } actions: {
                    VStack(spacing: LSpace.s) {
                        LButton("Open Settings", icon: "gear", kind: .primary) {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        LButton("Enter the address instead", icon: "keyboard", kind: .ghost) {
                            dismiss()
                            onManualEntry()
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background { PairingBackdrop() }
            }
            Button("Close", systemImage: "xmark") { dismiss() }
                .labelStyle(.iconOnly)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(scannerAvailable ? .white : p.text)
                .frame(width: 36, height: 36)
                .background(.ultraThinMaterial, in: Circle())
                .frame(width: 44, height: 44)
                .padding(LSpace.m)
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
              let url = URL(string: base) else { return "This Embodent" }
        return url.host ?? "This Embodent"
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
                    VStack(spacing: LSpace.xl) {
                        PairingHero(subtitle: "\(host) is protected. Sign in with GitHub and this phone gets its own device token — nothing to paste.")
                        PairingStepper(current: busy ? .connect : .signIn)
                        VStack(spacing: LSpace.m) {
                            LButton(signInTitle, icon: "arrow.up.forward.app", kind: .primary) {
                                Task {
                                    if await model.signInWithGitHub() {
                                        PairingHaptics.success()
                                        dismiss()
                                    }
                                }
                            }
                            .disabled(busy)
                            .frame(maxWidth: .infinity)
                            if case let .failed(message) = phase {
                                Banner(kind: .danger, text: message)
                            }
                            tokenFallback
                        }
                    }
                    .padding(LSpace.l)
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
                }
                .background { PairingBackdrop() }
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
        LCard {
          VStack(alignment: .leading, spacing: LSpace.m) {
            PairingDisclosure(title: "Use an access token instead", icon: "key.horizontal", expanded: $showTokenEntry)
            if showTokenEntry {
                SecureField("Access token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($tokenFocused)
                    .pairingField(p)
                Text("Advanced: paste the team access token your admin shared. Sign-in above does this for you.")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
                LButton(model.connecting ? "Connecting…" : "Connect with token", kind: .secondary) {
                    Task {
                        guard let draft = model.connectDraft else { return }
                        if await model.connect(draft, accessToken: token) {
                            PairingHaptics.success()
                            dismiss()
                        }
                    }
                }
                .disabled(busy || token.trimmingCharacters(in: .whitespaces).isEmpty)
                if let error = model.error, !isFailed {
                    Banner(kind: .danger, text: error)
                }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Field { case address, token }

    private var stepTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .move(edge: .trailing).combined(with: .opacity),
            removal: .move(edge: .leading).combined(with: .opacity)
        )
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ZStack {
                    if failed {
                        unreachable
                            .transition(stepTransition)
                    } else {
                        form
                            .transition(stepTransition)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background { PairingBackdrop() }
                .animation(reduceMotion ? nil : .lSpring, value: failed)
            }
            .navigationTitle("Pair this phone")
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
                PairingHaptics.success()
                dismiss()
            } else if !model.connectNeedsToken {
                failed = true
            }
            // needs-token: stay on the form — the danger banner + focus do the asking
        }
    }

    private var form: some View {
        ScrollView {
            VStack(spacing: LSpace.xl) {
                PairingHero(subtitle: "Your agents, approvals and reviews — in your pocket.")
                PairingStepper(current: model.connectNeedsToken ? .signIn : .address)
                VStack(alignment: .leading, spacing: LSpace.m) {
                    PairingStepCard(number: 1, title: "Scan the QR", detail: "Open your portal → Settings → Devices and pairing → Pair phone. Scanning fills this in for you.")
                    PairingStepCard(number: 2, title: "Or enter the address", detail: "For a cloud deployment that's the portal domain, like embodent.yourteam.com.")
                    VStack(spacing: LSpace.s) {
                        TextField("Address or QR payload", text: $address, prompt: Text("embodent.yourteam.com"), axis: .vertical)
                            .lineLimit(1...5)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .focused($focus, equals: .address)
                            .pairingField(p, focused: focus == .address)
                            .accessibilityLabel("Address")
                        SecureField("Access token (if required)", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .token)
                            .pairingField(p, focused: focus == .token)
                    }
                    Text("Cloud deployments sit behind a sign-in — connect and you'll get a Sign in with GitHub option, or paste the team access token your admin shared. Leave the token empty for an unprotected local server.")
                        .ltype(.micro)
                        .foregroundStyle(p.faint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    LButton(model.connecting ? "Connecting…" : "Connect", icon: "arrow.right", kind: .primary) {
                        tryConnect()
                    }
                    .disabled(model.connecting || address.trimmingCharacters(in: .whitespaces).isEmpty)
                    .frame(maxWidth: .infinity)
                    if let error = model.error, !failed {
                        Banner(kind: .danger, text: error)
                    }
                    if model.connectNeedsToken {
                        // The perimeter bounced this address: GitHub sign-in is the
                        // primary way through — it mints this phone's device token
                        // and retries the connect by itself.
                        LButton("Sign in with GitHub instead", icon: "arrow.up.forward.app", kind: .secondary) {
                            Task {
                                if await model.signInWithGitHub() {
                                    PairingHaptics.success()
                                    dismiss()
                                }
                            }
                        }
                        .disabled(model.connecting)
                        .frame(maxWidth: .infinity)
                    }
                    selfHostHelp
                }
            }
            .padding(LSpace.l)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// Collapsed explainer for the self-host path: local Wi-Fi entry and the
    /// optional Tailscale remote address. The cloud path never needs any of it.
    private var selfHostHelp: some View {
        LCard {
          VStack(alignment: .leading, spacing: LSpace.m) {
            PairingDisclosure(title: "Running Embodent on your own computer?", icon: "desktopcomputer", expanded: $showSelfHostHelp)
            if showSelfHostHelp {
                VStack(alignment: .leading, spacing: 10) {
                    Text("A cloud portal works from anywhere and none of this applies. Self-hosting on your own machine instead? Then the phone talks straight to that computer:")
                    step(1, "On the same Wi-Fi, enter the computer's address with the portal port, e.g. 192.168.1.24:8001. No access token needed unless you put one in front of it.")
                    step(2, "To check in from outside that Wi-Fi, install Tailscale (free for personal use) on this iPhone and on the computer, signed into the same account — an encrypted tunnel between your own devices.")
                    step(3, "Add the computer's Tailscale address under Settings → Containers → “Add remote…”, e.g. my-mac.tailnet.ts.net:8001. The app then uses whichever address answers, switching automatically as you come and go.")
                    Text("The only requirement while you're out: the computer must be awake.")
                }
                .ltype(.meta)
                .foregroundStyle(p.text2)
            }
          }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text("\(n)")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(p.text2)
                .frame(width: 18, height: 18)
                .background(p.surface2, in: Circle())
                .overlay(Circle().strokeBorder(p.border2, lineWidth: 1))
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var unreachable: some View {
        StateLayout(
            title: "Can't reach this Embodent",
            sub: "\(address.isEmpty ? "That address" : address) didn't answer. Your work is safe — the phone just can't see it right now.",
            danger: true
        ) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(p.danger)
        } actions: {
            VStack(spacing: LSpace.m) {
                LCard {
                    VStack(alignment: .leading, spacing: LSpace.s) {
                        step(1, "Is the address right? A cloud portal needs no port.")
                        step(2, "Is the deployment up — or, self-hosting, is the computer awake with Embodent running?")
                        step(3, "On a local address: same Wi-Fi, and no firewall or VPN in the way?")
                    }
                    .ltype(.meta)
                    .foregroundStyle(p.text2)
                }
                LButton("Try again", icon: "arrow.clockwise", kind: .primary) {
                    Task {
                        if await model.connect(address, accessToken: token) {
                            PairingHaptics.success()
                            dismiss()
                        }
                    }
                }
                .disabled(model.connecting)
                LButton("Back", icon: "chevron.left", kind: .ghost) { failed = false }
            }
            .padding(.horizontal, LSpace.l)
        }
    }
}

// MARK: - Linear onboarding pieces (pairing only)

/// Success haptic for a completed pairing — fired just before the sheet closes.
@MainActor
enum PairingHaptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

/// The one place a soft glow is allowed: a slow, low-opacity accent orb drifting
/// behind the onboarding content. Static under Reduce Motion.
private struct PairingBackdrop: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        GeometryReader { geo in
            let side = max(geo.size.width, 320) * 0.95
            ZStack {
                p.bg
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [p.accent.opacity(p.isDark ? 0.30 : 0.18), .clear],
                            center: .center, startRadius: 0, endRadius: side / 2
                        )
                    )
                    .frame(width: side, height: side)
                    .offset(x: drift ? geo.size.width * 0.22 : -geo.size.width * 0.18,
                            y: drift ? -geo.size.height * 0.10 : -geo.size.height * 0.28)
                    .blur(radius: 40)
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [p.violet.opacity(p.isDark ? 0.16 : 0.10), .clear],
                            center: .center, startRadius: 0, endRadius: side / 2.4
                        )
                    )
                    .frame(width: side * 0.8, height: side * 0.8)
                    .offset(x: drift ? -geo.size.width * 0.25 : geo.size.width * 0.2,
                            y: drift ? geo.size.height * 0.05 : -geo.size.height * 0.12)
                    .blur(radius: 50)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 14).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

/// Embodent mark + "Embodent" + a one-line value proposition.
private struct PairingHero: View {
    @Environment(\.palette) private var p
    let subtitle: String

    var body: some View {
        VStack(spacing: LSpace.m) {
            BrandMark(size: 60)
                .shadow(color: p.accent.opacity(0.25), radius: 18, y: 6)
                .accessibilityHidden(true)
            Text("Embodent")
                .ltype(.display)
                .foregroundStyle(p.text)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle)
                .ltype(.body)
                .foregroundStyle(p.text2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, LSpace.l)
        .frame(maxWidth: .infinity)
    }
}

/// Three-step progress (Address → Sign in → Connected) whose highlight pill
/// springs between steps with a matched-geometry move.
private struct PairingStepper: View {
    enum Step: Int, CaseIterable {
        case address, signIn, connect
        var title: String {
            switch self {
            case .address: "Address"
            case .signIn: "Sign in"
            case .connect: "Connected"
            }
        }
    }

    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var pill
    let current: Step

    var body: some View {
        HStack(spacing: LSpace.xs) {
            ForEach(Step.allCases, id: \.self) { step in
                HStack(spacing: 6) {
                    ZStack {
                        Circle()
                            .strokeBorder(step.rawValue <= current.rawValue ? p.accent : p.border2, lineWidth: 1.5)
                        if step.rawValue < current.rawValue {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(p.accent)
                        } else if step == current {
                            Circle().fill(p.accent).padding(4)
                        }
                    }
                    .frame(width: 16, height: 16)
                    Text(step.title)
                        .ltype(.micro)
                        .fontWeight(step == current ? .semibold : .regular)
                        .foregroundStyle(step == current ? p.text : p.muted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background {
                    if step == current {
                        Capsule()
                            .fill(p.surface)
                            .overlay(Capsule().strokeBorder(p.border2, lineWidth: 1))
                            .matchedGeometryEffect(id: "pill", in: pill)
                    }
                }
                if step != Step.allCases.last {
                    Rectangle()
                        .fill(step.rawValue < current.rawValue ? p.accent.opacity(0.6) : p.border)
                        .frame(width: 14, height: 1)
                }
            }
        }
        .animation(reduceMotion ? nil : .lSpring, value: current)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(current.rawValue + 1) of \(Step.allCases.count): \(current.title)")
    }
}

/// A big, numbered onboarding step.
private struct PairingStepCard: View {
    @Environment(\.palette) private var p
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: LSpace.m) {
            Text("\(number)")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .foregroundStyle(p.accent)
                .frame(width: 28, height: 28)
                .background(p.accentSoft, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .ltype(.headline)
                    .foregroundStyle(p.text)
                Text(detail)
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number): \(title). \(detail)")
    }
}

/// Collapsible header row used by the advanced/self-host cards.
private struct PairingDisclosure: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let title: String
    let icon: String
    @Binding var expanded: Bool

    var body: some View {
        Button {
            withAnimation(reduceMotion ? nil : .lSpring) { expanded.toggle() }
        } label: {
            HStack(spacing: LSpace.s) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(p.text2)
                    .accessibilityHidden(true)
                Text(title)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(p.faint)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }
}

/// Linear-styled QR frame over the live camera: dimmed surround, corner
/// brackets, a caption chip and the manual-entry escape hatch.
private struct ScannerFrameOverlay: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let scanned: Bool
    let onManualEntry: () -> Void
    @State private var pulse = false

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width * 0.68, 280)
            ZStack {
                Color.black.opacity(0.45)
                    .mask {
                        Rectangle()
                            .overlay {
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .frame(width: side, height: side)
                                    .blendMode(.destinationOut)
                            }
                            .compositingGroup()
                    }
                ScannerCorners()
                    .stroke(scanned ? p.ok : .white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: side, height: side)
                    .scaleEffect(pulse ? 1.02 : 1)
                VStack(spacing: LSpace.m) {
                    Spacer()
                    VStack(spacing: 4) {
                        Text(scanned ? "Pairing…" : "Scan the pairing QR")
                            .ltype(.headline)
                            .foregroundStyle(.white)
                        Text("Portal → Settings → Devices and pairing")
                            .ltype(.meta)
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .environment(\.colorScheme, .dark)
                    Button("Can't scan? Enter the address", action: onManualEntry)
                        .ltype(.bodyEmph)
                        .foregroundStyle(.white)
                        .frame(minHeight: 44)
                }
                .padding(.bottom, 40)
            }
        }
        .ignoresSafeArea()
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}

private struct ScannerCorners: Shape {
    func path(in rect: CGRect) -> Path {
        let len = rect.width * 0.16
        let r: CGFloat = 18
        var path = Path()
        // top-left
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + len))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + len, y: rect.minY))
        // top-right
        path.move(to: CGPoint(x: rect.maxX - len, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + len))
        // bottom-right
        path.move(to: CGPoint(x: rect.maxX, y: rect.maxY - len))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - len, y: rect.maxY))
        // bottom-left
        path.move(to: CGPoint(x: rect.minX + len, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r), control: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - len))
        return path
    }
}

private extension View {
    /// Linear form field: panel surface, hairline border, accent ring when focused.
    func pairingField(_ p: Palette, focused: Bool = false) -> some View {
        self
            .ltype(.body)
            .padding(.horizontal, LSpace.m)
            .padding(.vertical, 11)
            .background(p.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(focused ? p.accent : p.border2, lineWidth: focused ? 1.5 : 1)
            )
    }
}
