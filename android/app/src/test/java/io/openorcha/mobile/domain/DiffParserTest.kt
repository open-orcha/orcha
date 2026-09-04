package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Unified-diff parsing — Android's #177 gap closed with a real diff viewer. Mirrors
 *  iOS's DiffParser test contract (hunk content consumed by declared line counts, so
 *  content lines starting with "---"/"+++" never get mistaken for file headers). */
class DiffParserTest {

    @Test
    fun emptyDiffYieldsNoFiles() {
        assertTrue(DiffParser.parse("").isEmpty())
    }

    @Test
    fun singleFileSingleHunkParsesAddDelContextLines() {
        val diff = """
            diff --git a/foo.txt b/foo.txt
            index 1234567..89abcde 100644
            --- a/foo.txt
            +++ b/foo.txt
            @@ -1,3 +1,3 @@
             context line
            -removed line
            +added line
        """.trimIndent()
        val files = DiffParser.parse(diff)
        assertEquals(1, files.size)
        val file = files[0]
        assertEquals("foo.txt", file.path)
        assertEquals(1, file.adds)
        assertEquals(1, file.dels)
        assertFalse(file.isBinary)
        assertEquals(1, file.hunks.size)

        val lines = file.hunks[0].lines
        assertEquals(3, lines.size)
        assertEquals(DiffLineKind.Context, lines[0].kind)
        assertEquals(1, lines[0].oldNo)
        assertEquals(1, lines[0].newNo)
        assertEquals(DiffLineKind.Del, lines[1].kind)
        assertEquals(2, lines[1].oldNo)
        assertEquals(null, lines[1].newNo)
        assertEquals(DiffLineKind.Add, lines[2].kind)
        assertEquals(null, lines[2].oldNo)
        assertEquals(2, lines[2].newNo)
    }

    @Test
    fun contentLinesResemblingHeadersDoNotBreakParsing() {
        // A content line inside the hunk that itself starts with "---" or "+++" must be
        // consumed by the declared hunk line counts, not misread as a new file header.
        val diff = """
            diff --git a/notes.md b/notes.md
            --- a/notes.md
            +++ b/notes.md
            @@ -1,2 +1,2 @@
            -+++ this looks like a header but isn't
            +--- neither does this
        """.trimIndent()
        val files = DiffParser.parse(diff)
        assertEquals(1, files.size)
        assertEquals("notes.md", files[0].path)
        val lines = files[0].hunks[0].lines
        assertEquals(2, lines.size)
        assertEquals("+++ this looks like a header but isn't", lines[0].text)
        assertEquals("--- neither does this", lines[1].text)
    }

    @Test
    fun multipleFilesEachGetOwnEntry() {
        val diff = """
            diff --git a/a.txt b/a.txt
            --- a/a.txt
            +++ b/a.txt
            @@ -1 +1 @@
            -old a
            +new a
            diff --git a/b.txt b/b.txt
            --- a/b.txt
            +++ b/b.txt
            @@ -1 +1 @@
            -old b
            +new b
        """.trimIndent()
        val files = DiffParser.parse(diff)
        assertEquals(2, files.size)
        assertEquals(listOf("a.txt", "b.txt"), files.map { it.path })
        assertEquals(1, files[0].adds)
        assertEquals(1, files[1].adds)
    }

    @Test
    fun binaryFileMarksIsBinaryWithNoHunks() {
        val diff = """
            diff --git a/image.png b/image.png
            index 111..222 100644
            Binary files a/image.png and b/image.png differ
        """.trimIndent()
        val files = DiffParser.parse(diff)
        assertEquals(1, files.size)
        assertTrue(files[0].isBinary)
        assertTrue(files[0].hunks.isEmpty())
    }

    @Test
    fun hunkHeaderNumbersParsedIncludingSingleLineForm() {
        // "@@ -a +c @@" (no comma) implies counts of 1 for both sides.
        val diff = """
            diff --git a/one.txt b/one.txt
            --- a/one.txt
            +++ b/one.txt
            @@ -5 +7 @@
            -old
            +new
        """.trimIndent()
        val lines = DiffParser.parse(diff)[0].hunks[0].lines
        assertEquals(5, lines[0].oldNo)
        assertEquals(7, lines[1].newNo)
    }

    @Test
    fun noNewlineAtEndOfFileMarkerIsMetaLine() {
        val diff = """
            diff --git a/tail.txt b/tail.txt
            --- a/tail.txt
            +++ b/tail.txt
            @@ -1 +1 @@
            -old
            \ No newline at end of file
            +new
        """.trimIndent()
        val lines = DiffParser.parse(diff)[0].hunks[0].lines
        assertEquals(DiffLineKind.Meta, lines[1].kind)
    }

    @Test
    fun renamedFileWithoutHunksStillYieldsAFileEntry() {
        val diff = """
            diff --git a/old-name.txt b/new-name.txt
            similarity index 100%
            rename from old-name.txt
            rename to new-name.txt
        """.trimIndent()
        val files = DiffParser.parse(diff)
        assertEquals(1, files.size)
        assertEquals("new-name.txt", files[0].path)
        assertTrue(files[0].hunks.isEmpty())
    }
}
