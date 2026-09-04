package io.openorcha.mobile.domain

/**
 * Unified-diff parsing — pure model + parser, split out from the Compose diff viewer so
 * it's unit-testable without Android. Mirrors iOS's `DiffParser` (Components/DiffViewer.swift)
 * exactly: hunk content is consumed by the declared old/new line counts, so content lines
 * that happen to start with "---"/"+++" are never mistaken for file headers.
 */

data class DiffFile(
    val id: Int,
    val path: String,
    val isBinary: Boolean = false,
    val adds: Int = 0,
    val dels: Int = 0,
    val hunks: List<DiffHunk> = emptyList(),
)

data class DiffHunk(
    val id: Int,
    val header: String,
    val lines: List<DiffLine> = emptyList(),
)

enum class DiffLineKind { Add, Del, Context, Meta }

data class DiffLine(
    val id: Int,
    val kind: DiffLineKind,
    val oldNo: Int?,
    val newNo: Int?,
    val text: String,
)

object DiffParser {

    /** Parse a unified git diff into per-file, per-hunk lines. */
    fun parse(raw: String): List<DiffFile> {
        val files = mutableListOf<DiffFile>()
        var currentPath = ""
        var currentBinary = false
        var currentAdds = 0
        var currentDels = 0
        var currentHunks = mutableListOf<DiffHunk>()
        var haveCurrent = false

        var hunkHeader: String? = null
        var hunkLines = mutableListOf<DiffLine>()
        var haveHunk = false

        var oldNo = 0
        var newNo = 0
        var oldRemain = 0
        var newRemain = 0
        var lineId = 0
        var hunkId = 0

        fun closeHunk() {
            if (haveHunk && haveCurrent) {
                currentHunks.add(DiffHunk(id = hunkId, header = hunkHeader.orEmpty(), lines = hunkLines))
            }
            haveHunk = false
            hunkLines = mutableListOf()
            hunkHeader = null
        }

        fun closeFile() {
            closeHunk()
            if (haveCurrent) {
                files.add(DiffFile(id = files.size, path = currentPath, isBinary = currentBinary, adds = currentAdds, dels = currentDels, hunks = currentHunks))
            }
            haveCurrent = false
            currentPath = ""
            currentBinary = false
            currentAdds = 0
            currentDels = 0
            currentHunks = mutableListOf()
        }

        fun ensureCurrent(defaultPath: String) {
            if (!haveCurrent) {
                currentPath = defaultPath
                haveCurrent = true
            }
        }

        // split(omittingEmptySubsequences: false) parity: keep every line, including
        // trailing empties, by splitting on "\n" without dropping blank segments.
        val rawLines = raw.split("\n")
        for (line in rawLines) {
            val inHunk = haveHunk && (oldRemain > 0 || newRemain > 0)

            if (!inHunk) {
                when {
                    line.startsWith("diff --git") -> {
                        closeFile()
                        currentPath = gitPath(line)
                        haveCurrent = true
                        continue
                    }
                    line.startsWith("+++ ") -> {
                        val p = strippedPath(line)
                        if (!haveCurrent) {
                            currentPath = p ?: "changes"
                            haveCurrent = true
                        } else if (p != null) {
                            currentPath = p
                        }
                        continue
                    }
                    line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file") ||
                        line.startsWith("deleted file") || line.startsWith("old mode") || line.startsWith("new mode") ||
                        line.startsWith("similarity") || line.startsWith("rename ") || line.startsWith("copy ") -> {
                        continue
                    }
                    line.startsWith("Binary files") -> {
                        ensureCurrent("binary")
                        currentBinary = true
                        continue
                    }
                    line.startsWith("@@") -> {
                        closeHunk()
                        val (o, oc, n, nc) = hunkNumbers(line)
                        oldNo = o; newNo = n; oldRemain = oc; newRemain = nc
                        ensureCurrent("changes")
                        hunkHeader = line
                        haveHunk = true
                        hunkId += 1
                        continue
                    }
                    else -> continue // prose between files (commit text etc.)
                }
            }

            // inside a hunk — classify by prefix, count down the declared sizes
            lineId += 1
            when {
                line.startsWith("+") -> {
                    newRemain -= 1
                    currentAdds += 1
                    hunkLines.add(DiffLine(id = lineId, kind = DiffLineKind.Add, oldNo = null, newNo = newNo, text = line.drop(1)))
                    newNo += 1
                }
                line.startsWith("-") -> {
                    oldRemain -= 1
                    currentDels += 1
                    hunkLines.add(DiffLine(id = lineId, kind = DiffLineKind.Del, oldNo = oldNo, newNo = null, text = line.drop(1)))
                    oldNo += 1
                }
                line.startsWith("\\") -> {
                    hunkLines.add(DiffLine(id = lineId, kind = DiffLineKind.Meta, oldNo = null, newNo = null, text = line))
                }
                else -> {
                    oldRemain -= 1
                    newRemain -= 1
                    hunkLines.add(
                        DiffLine(
                            id = lineId, kind = DiffLineKind.Context, oldNo = oldNo, newNo = newNo,
                            text = if (line.isEmpty()) "" else line.drop(1),
                        ),
                    )
                    oldNo += 1
                    newNo += 1
                }
            }
        }
        closeFile()
        return files
    }

    private fun gitPath(line: String): String {
        // "diff --git a/x b/y" → y
        val marker = " b/"
        val idx = line.indexOf(marker)
        return if (idx >= 0) line.substring(idx + marker.length) else line.removePrefix("diff --git ")
    }

    private fun strippedPath(line: String): String? {
        val p = line.drop(4)
        if (p == "/dev/null") return null
        return if (p.startsWith("b/") || p.startsWith("a/")) p.drop(2) else p
    }

    private fun hunkNumbers(header: String): DiffHunkNumbers {
        // "@@ -a[,b] +c[,d] @@ …"
        var o = 1
        var oc = 1
        var n = 1
        var nc = 1
        for (token in header.split(" ")) {
            if (token.startsWith("-")) {
                val parts = token.drop(1).split(",")
                o = parts.getOrNull(0)?.toIntOrNull() ?: 1
                oc = if (parts.size > 1) (parts[1].toIntOrNull() ?: 1) else 1
            } else if (token.startsWith("+")) {
                val parts = token.drop(1).split(",")
                n = parts.getOrNull(0)?.toIntOrNull() ?: 1
                nc = if (parts.size > 1) (parts[1].toIntOrNull() ?: 1) else 1
            }
        }
        return DiffHunkNumbers(o, oc, n, nc)
    }

    private data class DiffHunkNumbers(val oldStart: Int, val oldCount: Int, val newStart: Int, val newCount: Int)
}
