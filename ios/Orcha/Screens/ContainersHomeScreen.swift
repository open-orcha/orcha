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
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add project", systemImage: "plus") { showScanner = true }
                }
            }
            .background(p.bg)
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
            Text("This removes the pairing — and every project sharing its address — from this phone only. The Embodent keeps running, and you can pair again anytime from the portal.")
        }
    }

    private var emptyState: some View {
        StateLayout(
            title: "Add your Embodent",
            sub: "Open your Embodent portal and choose Pair phone, then scan the QR here — or type the portal address, like embodent.yourteam.com. One pairing brings in every project on that Embodent."
        ) {
            BrandMark(size: 44)
        } actions: {
            VStack(spacing: LSpace.s) {
                LButton("Add your Embodent", icon: "qrcode.viewfinder", kind: .primary) { showScanner = true }
                LButton("Enter address manually", kind: .ghost) { showManualEntry = true }
            }
        }
    }

    private var containerList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: LSpace.m) {
                LSection("All projects", count: model.containers.count) {
                    LCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(model.containers.enumerated()), id: \.element.id) { index, container in
                                if index > 0 { LDivider() }
                                Button {
                                    model.openContainer(container.id)
                                } label: {
                                    ProjectRow(container: container, health: model.containerHealth[container.id])
                                }
                                .buttonStyle(.lRow)
                                .contextMenu {
                                    Button("Rename", systemImage: "pencil") {
                                        newName = container.displayName
                                        renaming = container
                                    }
                                    Button("Disconnect", systemImage: "xmark.circle", role: .destructive) {
                                        disconnecting = container
                                    }
                                }
                                .shellRowEntrance(index)
                            }
                        }
                    }
                }
                Text("Every project on a paired Embodent appears here automatically. Long-press a project to rename or disconnect it.")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .padding(.horizontal, LSpace.xs)
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
    }
}

/// One project in the list: round glyph tile, name, one muted meta line, and a
/// trailing needs-you badge + reachability dot (web "All projects" parity).
private struct ProjectRow: View {
    @Environment(\.palette) private var p
    let container: StoredContainer
    let health: ContainerHealth?

    private var meta: String {
        switch health?.state {
        case nil, "probing": "Checking…"
        case "unreachable": "Unreachable — is this project up?"
        default:
            "\(health?.agents ?? 0) \((health?.agents ?? 0) == 1 ? "agent" : "agents") · \(health?.tasks ?? 0) open \((health?.tasks ?? 0) == 1 ? "task" : "tasks")"
                + (health?.githubRepo.map { " · \($0)" } ?? "")
        }
    }

    private var dot: (Color, String) {
        switch health?.state {
        case "live", "polling", "active": (p.ok, "Running")
        case "paused": (p.warn, "Paused")
        case "unreachable": (p.danger, "Unreachable")
        default: (p.idle, "Checking")
        }
    }

    var body: some View {
        LRow(title: container.displayName, subtitle: meta) {
            ProjectIconView(icon: health?.icon, size: 32)
                .accessibilityHidden(true)
        } trailing: {
            HStack(spacing: LSpace.s) {
                if let needs = health?.needsYou, needs > 0 {
                    LBadgeCount(needs)
                }
                Circle()
                    .fill(dot.0)
                    .frame(width: 7, height: 7)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(container.displayName)
        .accessibilityValue([dot.1, meta, (health?.needsYou ?? 0) > 0 ? "\(health?.needsYou ?? 0) need you" : nil]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}

