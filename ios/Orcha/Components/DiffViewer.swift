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
    // The backend caps captured run diffs and appends this on its own final line
    // (notifier._capture_diff); it must survive parsing wherever the cap lands.
    private static let truncationMarker = "...[diff truncated]..."

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
                // "\ No newline at end of file" after the hunk's LAST counted line
                // arrives with both counts exhausted — it still belongs to the hunk.
                if line.hasPrefix("\\"), hunk != nil {
                    lineId += 1
                    hunk!.lines.append(DiffLine(id: lineId, kind: .meta, oldNo: nil, newNo: nil, text: line))
                    continue
                }
                // Truncation cap landed after a completed hunk (or between files) —
                // keep the warning visible instead of dropping it as prose.
                if line == truncationMarker {
                    lineId += 1
                    let meta = DiffLine(id: lineId, kind: .meta, oldNo: nil, newNo: nil, text: line)
                    if hunk != nil {
                        hunk!.lines.append(meta)
                    } else {
                        if current == nil { current = DiffFile(id: files.count, path: "changes") }
                        current!.hunks.append(DiffHunk(id: hunkId, header: "", lines: [meta]))
                        hunkId += 1
                    }
                    continue
                }
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
            if line == truncationMarker {
                // Truncation cap landed mid-hunk: keep the marker verbatim as meta —
                // the context fallback would eat its first "." and fake line numbers.
                hunk!.lines.append(DiffLine(id: lineId, kind: .meta, oldNo: nil, newNo: nil, text: line))
            } else if line.hasPrefix("+") {
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
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Text("\(files.count) file\(files.count == 1 ? "" : "s") changed")
                        .font(p.uiFont(15, .bold))
                        .foregroundStyle(p.text)
                    if totalAdds > 0 {
                        Text("+\(totalAdds)")
                            .font(.system(size: 13, weight: .bold, design: .monospaced))
                            .foregroundStyle(p.ok)
                    }
                    if totalDels > 0 {
                        Text("−\(totalDels)")
                            .font(.system(size: 13, weight: .bold, design: .monospaced))
                            .foregroundStyle(p.danger)
                    }
                    Spacer()
                }
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
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(p.faint)
                    Text(file.path)
                        .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(p.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    if file.adds > 0 {
                        Text("+\(file.adds)")
                            .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(p.ok)
                    }
                    if file.dels > 0 {
                        Text("−\(file.dels)")
                            .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(p.danger)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(p.surface2)

            if expanded {
                if file.isBinary {
                    Text("Binary file — no textual diff.")
                        .font(p.uiFont(12.5))
                        .foregroundStyle(p.muted)
                        .padding(12)
                } else {
                    DiffFileBody(file: file)
                }
            } else if !file.isBinary {
                Text("\(lineCount) lines — tap to expand")
                    .font(p.uiFont(12))
                    .foregroundStyle(p.faint)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
        }
        .background(p.surface)
        .clipShape(RoundedRectangle(cornerRadius: p.radiusCard))
        .overlay(RoundedRectangle(cornerRadius: p.radiusCard).strokeBorder(p.border, lineWidth: 1))
    }
}

/// The scrolling code block: gutters + code share one horizontal scroller so
/// they stay aligned; every row is padded to the widest line so the add/del
/// tints span the full scrollable width (monospaced width = chars × advance).
private struct DiffFileBody: View {
    @Environment(\.palette) private var p
    let file: DiffFile

    private static let codeSize: CGFloat = 12
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
                        .foregroundStyle(p.info)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .frame(width: gutterWidth * 2 + codeWidth, alignment: .leading)
                        .background(p.infoSoft)
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
        case .add: p.okSoft
        case .del: p.dangerSoft
        case .context, .meta: .clear
        }
    }

    /// The gutter carries a stronger shade of the row tint (GitHub's darker
    /// number column) — the -line tokens already encode that heavier alpha.
    private var gutterBg: Color {
        switch line.kind {
        case .add: p.okLine
        case .del: p.dangerLine
        case .context, .meta: p.surface2.opacity(0.6)
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
                    .foregroundStyle(line.kind == .meta ? p.faint : p.text)
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
