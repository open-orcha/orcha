import Testing
@testable import Orcha

struct DiffParserTests {
    private let twoFiles = """
    diff --git a/src/app.py b/src/app.py
    index 3f9c2e1..b7a41d9 100644
    --- a/src/app.py
    +++ b/src/app.py
    @@ -12,3 +12,4 @@ def charge(amount):
         if amount <= 0:
    -        return None
    +        raise InvalidAmount(amount)
    +    log.info("charging")
         return ok
    diff --git a/README.md b/README.md
    new file mode 100644
    --- /dev/null
    +++ b/README.md
    @@ -0,0 +1,2 @@
    +# Title
    +Body
    """

    @Test func parsesFilesHunksAndCounts() {
        let files = DiffParser.parse(twoFiles)
        #expect(files.count == 2)
        #expect(files[0].path == "src/app.py")
        #expect(files[0].adds == 2)
        #expect(files[0].dels == 1)
        #expect(files[0].hunks.count == 1)
        #expect(files[1].path == "README.md")
        #expect(files[1].adds == 2)
        #expect(files[1].dels == 0)
    }

    @Test func lineNumbersFollowHunkHeader() {
        let file = DiffParser.parse(twoFiles)[0]
        let lines = file.hunks[0].lines
        #expect(lines[0].kind == .context && lines[0].oldNo == 12 && lines[0].newNo == 12)
        #expect(lines[1].kind == .del && lines[1].oldNo == 13 && lines[1].newNo == nil)
        #expect(lines[2].kind == .add && lines[2].oldNo == nil && lines[2].newNo == 13)
        #expect(lines[3].kind == .add && lines[3].newNo == 14)
    }

    @Test func contentStartingWithPlusPlusPlusStaysContent() {
        // A content line "+++x" inside a hunk is an ADD of "++x", not a file header —
        // the parser must consume hunk lines by the declared counts.
        let diff = """
        diff --git a/x b/x
        --- a/x
        +++ b/x
        @@ -1,1 +1,2 @@
         keep
        ++++x
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        #expect(files[0].adds == 1)
        #expect(files[0].hunks[0].lines.last?.text == "+++x")
    }

    @Test func trailingNoNewlineMarkerIsKeptAsMeta() {
        // The "\ No newline at end of file" marker after the hunk's LAST counted
        // line arrives with both counts exhausted — it still belongs to the hunk.
        let diff = """
        diff --git a/x b/x
        --- a/x
        +++ b/x
        @@ -1,1 +1,1 @@
        -old
        +new
        \\ No newline at end of file
        """
        let lines = DiffParser.parse(diff)[0].hunks[0].lines
        #expect(lines.last?.kind == .meta)
        #expect(lines.last?.text == "\\ No newline at end of file")
    }

    @Test func truncationMarkerAfterCompletedHunkIsKeptAsMeta() {
        let diff = """
        diff --git a/x b/x
        --- a/x
        +++ b/x
        @@ -1,1 +1,1 @@
        -old
        +new
        ...[diff truncated]...
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        let last = files[0].hunks[0].lines.last
        #expect(last?.kind == .meta)
        #expect(last?.text == "...[diff truncated]...")
    }

    @Test func truncationMarkerMidHunkIsKeptVerbatimAsMeta() {
        // Cap landed inside the hunk: declared counts are not yet exhausted when
        // the marker arrives — it must not become a context line with fake numbers.
        let diff = """
        diff --git a/x b/x
        --- a/x
        +++ b/x
        @@ -1,3 +1,3 @@
         keep
        -old
        ...[diff truncated]...
        """
        let lines = DiffParser.parse(diff)[0].hunks[0].lines
        let last = lines.last
        #expect(last?.kind == .meta)
        #expect(last?.text == "...[diff truncated]...")
        #expect(last?.oldNo == nil && last?.newNo == nil)
        #expect(lines.filter { $0.kind == .meta }.count == 1)
    }

    @Test func emptyAndBinaryDiffs() {
        #expect(DiffParser.parse("").isEmpty)
        let bin = DiffParser.parse("""
        diff --git a/img.png b/img.png
        Binary files a/img.png and b/img.png differ
        """)
        #expect(bin.count == 1)
        #expect(bin[0].isBinary)
    }
}
