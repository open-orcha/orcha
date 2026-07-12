import SwiftUI

/// Flow 04 S1 — Settings: Appearance (instant three-way theme), containers, about.
/// A 1:1 port of the Android `SettingsScreen`, presented as a sheet.
struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        appearanceSection
                        containersSection
                        aboutSection
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: appearance

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Appearance")
            OrchaCard {
                Picker("Appearance", selection: themeBinding) {
                    ForEach(ThemeMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                Text("Auto follows the system setting. Changes apply instantly.")
                    .font(.system(size: 13))
                    .foregroundStyle(p.muted)
            }
        }
    }

    private var themeBinding: Binding<ThemeMode> {
        Binding(
            get: { model.themeMode },
            set: { model.setThemeMode($0) }
        )
    }

    // MARK: containers

    private var containersSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Containers", count: "\(model.containers.count)")
            ForEach(model.containers) { container in
                OrchaCard {
                    HStack(spacing: 10) {
                        AgentAvatar(alias: container.displayName)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(container.displayName)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(p.text)
                            Text(container.baseUrl)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(p.muted)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Disconnect") { model.forgetContainer(container.id) }
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(p.danger)
                    }
                }
            }
        }
    }

    // MARK: about

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "About")
            OrchaCard {
                KVRow(key: "Version", value: "0.1.0")
                KVRow(key: "Project", value: "github.com/open-orcha/orcha", mono: true)
                MetaTag(text: "GH #30 · mobile companion")
            }
        }
    }
}
