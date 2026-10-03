import SwiftUI

/// D14 — Settings › General › Project › Icon (web `EmojiPicker` / desktop project-icon
/// parity): Emoji | Icon. Emoji = one emoji (validated like the backend) + quick picks;
/// Icon = searchable glyph grid + 10 avatar-palette colours + "No colour". "Remove icon"
/// clears it. Read-only (preview + reason) without owner / manage_autonomy.
struct ProjectIconSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    enum Mode: Hashable { case emoji, glyph }

    @State private var mode: Mode = .glyph
    @State private var emoji = ""
    @State private var glyph = ProjectIconUx.defaultGlyph
    @State private var color: Int?
    @State private var query = ""
    @State private var error: String?

    private var current: ProjectIcon? { model.projectIcon(for: model.selectedContainer?.id) }
    private var canEdit: Bool { model.canEditProjectIcon }

    private var trimmedEmoji: String { emoji.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The icon the Save button would write.
    private var draft: ProjectIcon? {
        switch mode {
        case .emoji: ProjectIconUx.isEmoji(trimmedEmoji) ? .emoji(trimmedEmoji) : nil
        case .glyph: .glyph(glyph, color: color)
        }
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        preview
                        if canEdit {
                            LSegmented([(Mode.emoji, "Emoji"), (Mode.glyph, "Icon")], selection: $mode)
                            switch mode {
                            case .emoji: emojiEditor
                            case .glyph: glyphEditor
                            }
                            if let error {
                                Banner(kind: .danger, text: error)
                            }
                            actions
                        } else {
                            Text(model.access.manageDenialReason(Grant.manageAutonomy, action: "Changing the project icon")
                                 ?? "Changing the project icon needs the owner role.")
                                .ltype(.meta)
                                .foregroundStyle(p.muted)
                        }
                    }
                    .padding(LSpace.l)
                }
                .background(p.bg)
            }
            .navigationTitle("Project icon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(p.bg)
        .onAppear(perform: seed)
        .onChange(of: mode) { error = nil }
    }

    private var preview: some View {
        HStack(spacing: LSpace.m) {
            ProjectIconView(icon: canEdit ? (draft ?? current) : current, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.selectedContainer?.displayName ?? "Project")
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                Text("Shown in the project list and switcher, on the web and desktop too.")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Emoji

    private var emojiEditor: some View {
        VStack(alignment: .leading, spacing: LSpace.s) {
            TextField("One emoji", text: $emoji, prompt: Text("Type or paste one emoji").foregroundStyle(p.faint))
                .accessibilityLabel("Emoji")
                .ltype(.body)
                .foregroundStyle(p.text)
                .padding(.horizontal, LSpace.m)
                .frame(minHeight: 44)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(p.border, lineWidth: 1))
                .onChange(of: emoji) { error = nil }
            if !trimmedEmoji.isEmpty, !ProjectIconUx.isEmoji(trimmedEmoji) {
                Text("Use a single emoji — not text.")
                    .ltype(.meta)
                    .foregroundStyle(p.danger)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(ProjectIconUx.quickEmoji, id: \.self) { e in
                        Button { emoji = e } label: {
                            Text(e)
                                .font(.title3)
                                .frame(width: 44, height: 44)
                                .background(trimmedEmoji == e ? p.lSelected : .clear,
                                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(e)
                        .accessibilityAddTraits(trimmedEmoji == e ? .isSelected : [])
                    }
                }
            }
        }
    }

    // MARK: Glyph

    private var glyphEditor: some View {
        VStack(alignment: .leading, spacing: LSpace.m) {
            LSearchField("Search icons", text: $query)
            let results = ProjectIconUx.search(query)
            if results.isEmpty {
                Text("No icons match “\(query)”.")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 6)], spacing: 6) {
                    ForEach(results, id: \.self) { name in
                        Button { glyph = name } label: {
                            ProjectIconView(icon: .glyph(name, color: color), size: 44, tile: false)
                                .background(glyph == name ? p.lSelected : .clear,
                                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay {
                                    if glyph == name {
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .strokeBorder(p.accent, lineWidth: 1.5)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(name.capitalized)
                        .accessibilityAddTraits(glyph == name ? .isSelected : [])
                    }
                }
            }
            Text("Colour")
                .ltype(.meta)
                .fontWeight(.medium)
                .foregroundStyle(p.text2)
            // Wraps like the glyph grid so all 11 options are visible (a sideways scroll
            // hid colours 8–10 off the edge on a phone).
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 2)], alignment: .leading, spacing: 2) {
                swatch(nil)
                ForEach(0..<ProjectIconUx.hues.count, id: \.self) { swatch($0) }
            }
        }
    }

    private func swatch(_ slot: Int?) -> some View {
        let picked = color == slot
        return Button { color = slot } label: {
            Circle()
                .fill(ProjectIconSwatchColor.color(slot: slot, dark: p.isDark, neutral: p.surface2))
                .overlay {
                    if slot == nil {
                        Image(systemName: "slash.circle")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(p.muted)
                    }
                }
                .overlay(Circle().strokeBorder(picked ? p.accent : p.border, lineWidth: picked ? 2 : 1))
                .frame(width: 26, height: 26)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(slot.map { "Colour \($0 + 1)" } ?? "No colour")
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    // MARK: Actions

    private var actions: some View {
        HStack {
            if current != nil {
                LButton("Remove icon", kind: .ghost) { save(nil) }
                    .disabled(model.actionInFlight)
            }
            Spacer()
            LButton("Save", kind: .primary) { if let draft { save(draft) } }
                .disabled(draft == nil || draft == current || model.actionInFlight)
        }
    }

    private func save(_ icon: ProjectIcon?) {
        error = nil
        Task {
            if let message = await model.setProjectIcon(icon) {
                error = message
            } else {
                dismiss()
            }
        }
    }

    private func seed() {
        switch current {
        case let .emoji(value):
            mode = .emoji
            emoji = value
        case let .glyph(name, slot):
            mode = .glyph
            glyph = ProjectIconUx.glyphs.contains(name) ? name : ProjectIconUx.defaultGlyph
            color = slot
        default:
            break
        }
    }
}
