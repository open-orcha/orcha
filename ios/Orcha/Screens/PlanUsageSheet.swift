import SwiftUI

/// Detail sheet opened from the Projects "Usage" card — mirrors the desktop Usage panel.
struct PlanUsageSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var p

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                PlanUsageScreen()
            }
            .toolbarBackground(p.bg, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// The plan usage detail: "Usage · all agents" overall %, then per provider its
/// headline, every window (label · bar · % / "92% left · resets today 4:49 PM ·
/// in 3h 26m") and "Today 601M tokens · Est. $237.61". Also Settings › Plan usage.
struct PlanUsageScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    private var usage: PlanUsageModel { model.planUsage }
    private var bases: [String] { model.containers.map(\.baseUrl) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: LSpace.l) {
                    PlanUsageDisplayCard(usage: usage, bases: bases)
                    content(now: context.date)
                }
                .padding(.horizontal, LSpace.l)
                .padding(.vertical, LSpace.l)
            }
        }
        .background(p.bg)
        .navigationTitle("Plan usage")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await usage.refresh(bases: bases) }
        .task {
            while !Task.isCancelled {
                await usage.refresh(bases: bases)
                try? await Task.sleep(for: PlanUsageUx.pollInterval)
            }
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if !usage.loaded {
            SkeletonBlock(height: 60)
            SkeletonBlock(height: 160)
        } else if usage.providers.isEmpty {
            LEmptyState(icon: "gauge.with.dots.needle.33percent", title: "No plan usage yet", message: PlanUsageUx.emptyText)
        } else {
            overallCard
            ForEach(usage.providers) { provider in
                PlanUsageProviderCard(provider: provider, now: now)
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(PlanUsageUx.sources(usage.providers), id: \.host) { source in
                    PlanUsageFreshness(host: source.host, capturedAt: source.capturedAt, now: now)
                }
            }
            .padding(.horizontal, LSpace.xs)
        }
    }

    private var overallCard: some View {
        LCard {
            HStack(alignment: .firstTextBaseline) {
                Text("Usage · all agents")
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                Spacer(minLength: LSpace.s)
                if let overall = PlanUsageUx.overallPercent(usage.providers) {
                    Text("\(overall)%")
                        .ltype(.title)
                        .monospacedDigit()
                        .foregroundStyle(p.text)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// "Show plan usage" switch, the Providers picker (enabled only when on) and the
/// caption. Edits apply optimistically and PUT to every paired server.
private struct PlanUsageDisplayCard: View {
    @Environment(\.palette) private var p
    let usage: PlanUsageModel
    let bases: [String]

    private var showBinding: Binding<Bool> {
        Binding(
            get: { usage.display.show },
            set: { usage.setDisplay(show: $0, providers: usage.display.providers, bases: bases) }
        )
    }

    private var providersBinding: Binding<PlanUsageUx.ProviderChoice> {
        Binding(
            get: { usage.display.providers },
            set: { usage.setDisplay(show: usage.display.show, providers: $0, bases: bases) }
        )
    }

    var body: some View {
        LCard {
            VStack(alignment: .leading, spacing: LSpace.m) {
                Toggle(isOn: showBinding) {
                    Text("Show plan usage")
                        .ltype(.bodyEmph)
                        .foregroundStyle(p.text)
                }
                .tint(p.accent)
                LDivider()
                VStack(alignment: .leading, spacing: LSpace.s) {
                    Text("Providers")
                        .ltype(.meta)
                        .fontWeight(.medium)
                        .foregroundStyle(p.text2)
                    LSegmented(
                        PlanUsageUx.ProviderChoice.allCases.map { ($0, $0.label) },
                        selection: providersBinding
                    )
                    .accessibilityLabel("Providers")
                }
                .disabled(!usage.display.show)
                .opacity(usage.display.show ? 1 : 0.5)
                Text(PlanUsageUx.displayCaption)
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One provider: logo · name · plan, the headline, its windows, then today's totals.
private struct PlanUsageProviderCard: View {
    @Environment(\.palette) private var p
    let provider: PlanUsageUx.Provider
    let now: Date

    var body: some View {
        LCard {
            VStack(alignment: .leading, spacing: LSpace.m) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: LSpace.s) {
                        if let mark = provider.mark {
                            ProviderMarkImage(provider: mark, size: 18)
                        }
                        Text(provider.name)
                            .ltype(.headline)
                            .foregroundStyle(p.text)
                        if let plan = provider.plan {
                            Text(plan).ltype(.meta).foregroundStyle(p.muted)
                        }
                    }
                    if let headline = provider.headline {
                        Text(headline)
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)

                ForEach(provider.windows) { window in
                    PlanUsageWindowRow(window: window, now: now)
                }

                if let today = PlanUsageUx.todayText(provider.today) {
                    LDivider()
                    Text(today)
                        .ltype(.meta)
                        .monospacedDigit()
                        .foregroundStyle(p.text2)
                }
            }
        }
    }
}

/// `5h ▓░░ 8%` with "92% left · resets today 4:49 PM · in 3h 26m" below.
private struct PlanUsageWindowRow: View {
    @Environment(\.palette) private var p
    let window: PlanUsageUx.Window
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: LSpace.s) {
                Text(window.label)
                    .ltype(.meta)
                    .foregroundStyle(p.text)
                    .frame(minWidth: 40, alignment: .leading)
                PlanUsageBar(percent: window.usedPct)
                PlanUsagePercent(percent: window.usedPct)
                    .frame(minWidth: 36, alignment: .trailing)
            }
            Text(PlanUsageUx.remainText(window, now: now))
                .ltype(.micro)
                .monospacedDigit()
                .foregroundStyle(p.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PlanUsageUx.windowAccessibility(window, now: now))
    }
}
