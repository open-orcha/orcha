import SwiftUI

/// Flow 04 — Containers home ("My Orchas"): large title, container cards with
/// reachability + glance counts, swipe actions, toolbar "+" → scanner (flow 03).
struct ContainersHomeScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @State private var showScanner = false
    @State private var showManualEntry = false
    @State private var showTokenPrompt = false
    @State private var showSettings = false
    @State private var renaming: StoredContainer?
    @State private var newName = ""
    @State private var disconnecting: StoredContainer?

    var body: some View {
        NavigationStack {
            Group {
                if model.containers.isEmpty {
                    emptyState
                } else {
                    containerList
                }
            }
            .navigationTitle("Orcha")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add", systemImage: "plus") { showScanner = true }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.clear)
        }
        .task { model.probeContainers() }
        .refreshable { model.probeContainers() }
        .fullScreenCover(isPresented: $showScanner) {
            ScannerScreen(
                onManualEntry: {
                    showScanner = false
                    showManualEntry = true
                },
                onTokenRequired: {
                    // Scan hit the auth perimeter: the address is captured, only
                    // a credential is missing — offer GitHub sign-in (primary)
                    // with pasted-token entry as the advanced fallback.
                    showScanner = false
                    showTokenPrompt = true
                }
            )
        }
        .sheet(isPresented: $showManualEntry) {
            ManualConnectSheet()
        }
        .sheet(isPresented: $showTokenPrompt) {
            AuthOptionsSheet()
        }
        .sheet(isPresented: $showSettings) {
            SettingsScreen()
        }
        .alert("Rename on this phone", isPresented: .init(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Display name", text: $newName)
            Button("Rename") {
                if let target = renaming {
                    model.renameContainer(target.id, to: newName)
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog(
            "Disconnect \(disconnecting?.displayName ?? "")?",
            isPresented: .init(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                if let target = disconnecting {
                    model.forgetContainer(target.id)
                }
                disconnecting = nil
            }
            Button("Cancel", role: .cancel) { disconnecting = nil }
        } message: {
            Text("This removes the pairing — and every project sharing its address — from this phone only. The Orcha keeps running, and you can pair again anytime from the portal.")
        }
    }

    private var emptyState: some View {
        StateLayout(
            title: "Add your Orcha",
            sub: "Open your Orcha portal and choose Pair phone, then scan the QR here — or type the portal address, like orcha.yourteam.com. One pairing brings in every project on that Orcha."
        ) {
            BrandMark(size: 44)
        } actions: {
            VStack(spacing: 10) {
                KitButton(title: "Add your Orcha", systemImage: "qrcode.viewfinder") { showScanner = true }
                    .frame(maxWidth: 260)
                Button("Enter address manually") { showManualEntry = true }
                    .font(p.uiFont(14, .bold))
                    .foregroundStyle(p.accent)
            }
        }
    }

    private var containerList: some View {
        ScrollView {
            VStack(spacing: 10) {
                SectionH(title: "My Orchas", count: "\(model.containers.count)")
                ForEach(model.containers) { container in
                    Button {
                        model.openContainer(container.id)
                    } label: {
                        ContainerCard(container: container, health: model.containerHealth[container.id])
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Rename") {
                            newName = container.displayName
                            renaming = container
                        }
                        Button("Disconnect", role: .destructive) { disconnecting = container }
                    }
                }
                Text("Every project on a paired Orcha appears here automatically — tap one to switch into it. Long-press a card to rename or disconnect.")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.faint)
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
            }
            .padding(16)
        }
    }
}

private struct ContainerCard: View {
    @Environment(\.palette) private var p
    let container: StoredContainer
    let health: ContainerHealth?

    var body: some View {
        OrchaCard {
            HStack(spacing: 12) {
                BrandMark()
                VStack(alignment: .leading, spacing: 2) {
                    Text(container.displayName)
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                        .lineLimit(1)
                    Text(container.baseUrl)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                }
                Spacer()
                ConnChip(state: health?.state ?? "probing")
                Image(systemName: "chevron.right")
                    .font(p.uiFont(12, .semibold))
                    .foregroundStyle(p.faint)
            }
            switch health?.state {
            case nil, "probing":
                Text("Checking…")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.faint)
            case "unreachable":
                Text("Last seen a while ago — is this Orcha up?")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            default:
                HStack(spacing: 8) {
                    Text("\(health?.agents ?? 0) agents · \(health?.tasks ?? 0) open")
                        .font(p.uiFont(13))
                        .foregroundStyle(p.muted)
                    Spacer()
                    if let needs = health?.needsYou, needs > 0 {
                        StatusPill(status: "\(needs) need you", domain: .agent)
                    }
                }
                // Bound GitHub repo (glance-only — connect/change lives in the
                // workspace, on the Home tab's repo chip).
                if let repo = health?.githubRepo {
                    HStack(spacing: 5) {
                        GitHubMark()
                            .frame(width: 11, height: 11)
                            .foregroundStyle(p.faint)
                        Text(repo)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(p.muted)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("GitHub repository: \(repo)")
                }
            }
        }
    }
}
