import SwiftUI
import UIKit

// A real unified-diff viewer (GitHub-app anatomy): a changes summary, one
// collapsible section per file, hunk headers, dual line-number gutters, and
// full-width add/del row tints with a darker gutter shade. Long lines scroll
// horizontally per file — gutters ride along, GitHub-style. Colors come from
// the token palette (ok/danger/info), so both skins and all themes just work.

// MARK: - model + parser

struct DiffFile: Identifiable {
    let id: Int
    var path: String
    var isBinary = false
    var adds = 0
    var dels = 0
    var hunks: [DiffHunk] = []
}

struct DiffHunk: Identifiable {
    let id: Int
    var header: String
    var lines: [DiffLine] = []
}

struct DiffLine: Identifiable {
    enum Kind { case add, del, context, meta }
    let id: Int
    let kind: Kind
    let oldNo: Int?
    let newNo: Int?
    let text: String
}

enum DiffParser {
    /// Parse a unified git diff. Hunk content is consumed by the declared
    /// old/new line counts, so content lines that happen to start with
    /// "---"/"+++" are never mistaken for file headers.
    static func parse(_ raw: String) -> [DiffFile] {
        var files: [DiffFile] = []
        var current: DiffFile?
        var hunk: DiffHunk?
        var oldNo = 0, newNo = 0, oldRemain = 0, newRemain = 0
        var lineId = 0, hunkId = 0

        func closeHunk() {
            if let h = hunk, current != nil { current!.hunks.append(h) }
            hunk = nil
        }
        func closeFile() {
            closeHunk()
            if let f = current { files.append(f) }
            current = nil
        }

        for rawLine in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let inHunk = hunk != nil && (oldRemain > 0 || newRemain > 0)

            if !inHunk {
                if line.hasPrefix("diff --git") {
                    closeFile()
                    current = DiffFile(id: files.count, path: gitPath(line))
                    continue
                }
                if line.hasPrefix("+++ ") {
                    let p = strippedPath(line)
                    if current == nil { current = DiffFile(id: files.count, path: p ?? "changes") }
                    else if let p { current!.path = p }
                    continue
                }
                if line.hasPrefix("--- ") || line.hasPrefix("index ") || line.hasPrefix("new file")
                    || line.hasPrefix("deleted file") || line.hasPrefix("old mode") || line.hasPrefix("new mode")
                    || line.hasPrefix("similarity") || line.hasPrefix("rename ") || line.hasPrefix("copy ") {
                    continue
                }
                if line.hasPrefix("Binary files") {
                    if current == nil { current = DiffFile(id: files.count, path: "binary") }
                    current!.isBinary = true
                    continue
                }
                if line.hasPrefix("@@") {
                    closeHunk()
                    let (o, oc, n, nc) = hunkNumbers(line)
                    oldNo = o; newNo = n; oldRemain = oc; newRemain = nc
                    if current == nil { current = DiffFile(id: files.count, path: "changes") }
                    hunk = DiffHunk(id: hunkId, header: line); hunkId += 1
                    continue
                }
                continue   // prose between files (commit text etc.)
            }

            // inside a hunk — classify by prefix, count down the declared sizes
            lineId += 1
            if line.hasPrefix("+") {
                newRemain -= 1
                current!.adds += 1
                hunk!.lines.append(DiffLine(id: lineId, kind: .add, oldNo: nil, newNo: newNo, text: String(line.dropFirst())))
                newNo += 1
            } else if line.hasPrefix("-") {
                oldRemain -= 1
                current!.dels += 1
                hunk!.lines.append(DiffLine(id: lineId, kind: .del, oldNo: oldNo, newNo: nil, text: String(line.dropFirst())))
                oldNo += 1
            } else if line.hasPrefix("\\") {
                hunk!.lines.append(DiffLine(id: lineId, kind: .meta, oldNo: nil, newNo: nil, text: line))
            } else {
                oldRemain -= 1; newRemain -= 1
                hunk!.lines.append(DiffLine(id: lineId, kind: .context, oldNo: oldNo, newNo: newNo,
                                            text: line.isEmpty ? "" : String(line.dropFirst())))
                oldNo += 1; newNo += 1
            }
        }
        closeFile()
        return files
    }

    private static func gitPath(_ line: String) -> String {
        // "diff --git a/x b/y" → y
        if let range = line.range(of: " b/") { return String(line[range.upperBound...]) }
        return line.replacingOccurrences(of: "diff --git ", with: "")
    }

    private static func strippedPath(_ line: String) -> String? {
        let p = String(line.dropFirst(4))
        if p == "/dev/null" { return nil }
        return p.hasPrefix("b/") || p.hasPrefix("a/") ? String(p.dropFirst(2)) : p
    }

    private static func hunkNumbers(_ header: String) -> (Int, Int, Int, Int) {
        // "@@ -a[,b] +c[,d] @@ …"
        var o = 1, oc = 1, n = 1, nc = 1
        for token in header.split(separator: " ") {
            if token.hasPrefix("-") {
                let parts = token.dropFirst().split(separator: ",")
                o = Int(parts.first ?? "1") ?? 1
                oc = parts.count > 1 ? (Int(parts[1]) ?? 1) : 1
            } else if token.hasPrefix("+") {
                let parts = token.dropFirst().split(separator: ",")
                n = Int(parts.first ?? "1") ?? 1
                nc = parts.count > 1 ? (Int(parts[1]) ?? 1) : 1
            }
        }
        return (o, oc, n, nc)
    }

    /// Parse ONE file's raw GitHub `patch` text — hunk lines only (`@@ …` onward), with
    /// no `diff --git`/`+++`/`---` headers, unlike `parse(_:)`'s full multi-file input
    /// (`github_hub_routes.py:_pr_files`'s `patch` field is exactly this shape). Reuses
    /// `parse(_:)` by prepending a synthetic `+++ b/<filename>` header so the same
    /// hunk-consuming state machine applies; the filename is then overwritten with the
    /// caller's own (already known from the file row), so it's cosmetic only.
    static func parseFilePatch(_ patch: String, filename: String) -> DiffFile? {
        guard var file = parse("+++ b/\(filename)\n" + patch).first else { return nil }
        file.path = filename
        return file
    }
}

// MARK: - views

struct DiffViewer: View {
    @Environment(\.palette) private var p
    let files: [DiffFile]

    init(diff: String) {
        files = DiffParser.parse(diff)
    }

    private var totalAdds: Int { files.reduce(0) { $0 + $1.adds } }
    private var totalDels: Int { files.reduce(0) { $0 + $1.dels } }

    var body: some View {
        if files.isEmpty {
            OrchaCard {
                Text("No net change (empty diff).")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.muted)
            }
        } else {
            VStack(alignment: .leading, spacing: LSpace.s) {
                HStack(spacing: LSpace.s) {
                    Text("\(files.count) file\(files.count == 1 ? "" : "s") changed")
                        .ltype(.headline)
                        .foregroundStyle(p.text)
                    Spacer()
                    DiffCounts(adds: totalAdds, dels: totalDels)
                }
                .accessibilityElement(children: .combine)
                ForEach(files) { file in
                    DiffFileSection(file: file)
                }
            }
        }
    }
}

private struct DiffFileSection: View {
    @Environment(\.palette) private var p
    let file: DiffFile
    @State private var expanded: Bool

    private var lineCount: Int { file.hunks.reduce(0) { $0 + $1.lines.count } }

    init(file: DiffFile) {
        self.file = file
        // Very large files start collapsed so a big sweep stays scrollable.
        _expanded = State(initialValue: file.hunks.reduce(0) { $0 + $1.lines.count } <= 800)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(duration: 0.25)) { expanded.toggle() }
            } label: {
                HStack(spacing: LSpace.s) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(p.faint)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .accessibilityHidden(true)
                    Image(systemName: "doc.text")
                        .font(.system(size: 12))
                        .foregroundStyle(p.muted)
                        .accessibilityHidden(true)
                    Text(file.path)
                        .ltype(.mono)
                        .foregroundStyle(p.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: LSpace.s)
                    DiffCounts(adds: file.adds, dels: file.dels, compact: true)
                }
                .padding(.horizontal, LSpace.m)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("\(file.adds) additions, \(file.dels) deletions")

            if expanded {
                LDivider()
                if file.isBinary {
                    Text("Binary file — no textual diff.")
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                        .padding(LSpace.m)
                } else {
                    DiffFileBody(file: file)
                }
            } else if !file.isBinary {
                Text("\(lineCount) lines hidden")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                    .padding(.horizontal, LSpace.m)
                    .padding(.bottom, LSpace.s)
            }
        }
        .background(p.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 1))
    }
}

/// `+12 −3` plus a five-cell proportion bar (GitHub's diffstat), muted and mono.
struct DiffCounts: View {
    @Environment(\.palette) private var p
    let adds: Int
    let dels: Int
    var compact = false

    private var cells: [Color] {
        let total = adds + dels
        guard total > 0 else { return Array(repeating: p.border2, count: 5) }
        let green = Int((Double(adds) / Double(total) * 5).rounded())
        let red = min(5 - green, Int((Double(dels) / Double(total) * 5).rounded()))
        return Array(repeating: p.ok, count: green)
            + Array(repeating: p.danger, count: red)
            + Array(repeating: p.border2, count: max(0, 5 - green - red))
    }

    var body: some View {
        HStack(spacing: 6) {
            if adds > 0 || !compact {
                Text("+\(adds)").foregroundStyle(p.ok)
            }
            if dels > 0 || !compact {
                Text("−\(dels)").foregroundStyle(p.danger)
            }
            HStack(spacing: 1.5) {
                ForEach(cells.indices, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(cells[i].opacity(cells[i] == p.border2 ? 1 : 0.85))
                        .frame(width: 7, height: 7)
                }
            }
            .accessibilityHidden(true)
        }
        .ltype(.mono)
        .monospacedDigit()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(adds) additions, \(dels) deletions")
    }
}

/// The scrolling code block: gutters + code share one horizontal scroller so
/// they stay aligned; every row is padded to the widest line so the add/del
/// tints span the full scrollable width (monospaced width = chars × advance).
/// Not `private`: `GitHubPullDetailScreen`'s per-file expand reuses this hunk body
/// directly — that row already IS the collapsible header, so it only wants the body,
/// not `DiffFileSection`'s own duplicate header/chevron.
struct DiffFileBody: View {
    @Environment(\.palette) private var p
    let file: DiffFile

    private static let codeSize: CGFloat = 12.5
    private static let charW: CGFloat = {
        let font = UIFont.monospacedSystemFont(ofSize: codeSize, weight: .regular)
        return ("M" as NSString).size(withAttributes: [.font: font]).width
    }()

    private var codeWidth: CGFloat {
        let maxChars = file.hunks
            .flatMap(\.lines)
            .reduce(60) { max($0, $1.text.count + 2) }
        let capped = min(maxChars, 400)   // pathological one-liners stay scrollable, not 40k pt wide
        return CGFloat(capped) * Self.charW + 16
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(file.hunks) { hunk in
                    Text(hunk.header)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .frame(width: gutterWidth * 2 + codeWidth, alignment: .leading)
                        .background(p.surface2)
                    ForEach(hunk.lines) { line in
                        DiffLineRow(line: line, codeWidth: codeWidth, gutterWidth: gutterWidth, codeSize: Self.codeSize)
                    }
                }
            }
        }
    }

    private var gutterWidth: CGFloat { 40 }
}

private struct DiffLineRow: View {
    @Environment(\.palette) private var p
    let line: DiffLine
    let codeWidth: CGFloat
    let gutterWidth: CGFloat
    let codeSize: CGFloat

    private var rowBg: Color {
        switch line.kind {
        case .add: p.ok.opacity(p.isDark ? 0.10 : 0.08)
        case .del: p.danger.opacity(p.isDark ? 0.10 : 0.07)
        case .context, .meta: .clear
        }
    }

    /// The gutter carries a stronger shade of the row tint (GitHub's darker
    /// number column) — the -line tokens already encode that heavier alpha.
    private var gutterBg: Color {
        switch line.kind {
        case .add: p.ok.opacity(p.isDark ? 0.16 : 0.13)
        case .del: p.danger.opacity(p.isDark ? 0.16 : 0.12)
        case .context, .meta: .clear
        }
    }

    private var marker: String {
        switch line.kind {
        case .add: "+"
        case .del: "−"
        case .context: " "
        case .meta: ""
        }
    }

    private var markerColor: Color {
        switch line.kind {
        case .add: p.ok
        case .del: p.danger
        case .context, .meta: p.faint
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            gutter(line.oldNo)
            gutter(line.newNo)
            HStack(alignment: .top, spacing: 6) {
                Text(marker)
                    .font(.system(size: codeSize, weight: .bold, design: .monospaced))
                    .foregroundStyle(markerColor)
                Text(line.text.isEmpty ? " " : line.text)
                    .font(.system(size: codeSize, design: .monospaced))
                    .foregroundStyle(line.kind == .meta ? p.faint : (line.kind == .context ? p.text2 : p.text))
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 1.5)
            .frame(width: codeWidth, alignment: .leading)
            .background(rowBg)
        }
    }

    private func gutter(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(p.faint)
            .padding(.trailing, 6)
            .padding(.vertical, 1.5)
            .frame(width: gutterWidth, alignment: .trailing)
            .background(gutterBg)
    }
}
