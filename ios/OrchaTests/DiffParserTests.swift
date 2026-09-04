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

    @Test func emptyAndBinaryDiffs() {
        #expect(DiffParser.parse("").isEmpty)
        let bin = DiffParser.parse("""
        diff --git a/img.png b/img.png
        Binary files a/img.png and b/img.png differ
        """)
        #expect(bin.count == 1)
        #expect(bin[0].isBinary)
    }

    // ---------- parseFilePatch — GitHub's per-file `patch` (github_hub_routes.py:_pr_files) ----------
    // Hunk lines only, no `diff --git`/`+++`/`---` headers — unlike `parse(_:)`'s full input.

    @Test func parseFilePatchReadsHunkOnlyText() throws {
        let patch = """
        @@ -12,3 +12,4 @@ def charge(amount):
             if amount <= 0:
        -        return None
        +        raise InvalidAmount(amount)
        +    log.info("charging")
             return ok
        """
        let file = try #require(DiffParser.parseFilePatch(patch, filename: "src/app.py"))
        #expect(file.path == "src/app.py")
        #expect(file.adds == 2)
        #expect(file.dels == 1)
        #expect(file.hunks.count == 1)
        #expect(file.hunks[0].header.hasPrefix("@@ -12,3 +12,4 @@"))
    }

    @Test func parseFilePatchHandlesMultipleHunks() throws {
        let patch = """
        @@ -1,2 +1,2 @@
        -old top
        +new top
         keep
        @@ -20,1 +20,2 @@
         keep
        +new bottom
        """
        let file = try #require(DiffParser.parseFilePatch(patch, filename: "b.py"))
        #expect(file.hunks.count == 2)
        #expect(file.adds == 2)
        #expect(file.dels == 1)
    }

    @Test func parseFilePatchOfEmptyTextYieldsNoHunks() throws {
        // `patch_omitted:true` files never reach this call (`GitHubChangedFile.patch` is
        // nil, not ""), but empty input should still degrade to a hunk-less file rather
        // than crash or silently drop the filename.
        let file = try #require(DiffParser.parseFilePatch("", filename: "a.py"))
        #expect(file.path == "a.py")
        #expect(file.hunks.isEmpty)
    }
}
