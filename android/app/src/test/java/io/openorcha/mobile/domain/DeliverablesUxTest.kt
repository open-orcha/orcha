package io.openorcha.mobile.domain

import io.openorcha.mobile.data.DeliverableDto
import io.openorcha.mobile.data.DeliverableVersionDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DeliverablesUxTest {

    @Test
    fun formatBytesMatchesWeb() {
        assertEquals("—", DeliverablesUx.formatBytes(null))
        assertEquals("512 B", DeliverablesUx.formatBytes(512))
        assertEquals("1.5 KB", DeliverablesUx.formatBytes(1536))
        assertEquals("20 KB", DeliverablesUx.formatBytes(20 * 1024))
        assertEquals("2.5 MB", DeliverablesUx.formatBytes(2_621_440))
    }

    @Test
    fun sourceLabelNamesWhoProducedIt() {
        assertEquals("Run output · dev", DeliverablesUx.sourceLabel(DeliverableVersionDto(source = "run_output", authorAlias = "dev")))
        assertEquals("Run output · agent run", DeliverablesUx.sourceLabel(DeliverableVersionDto(source = "run_output")))
        assertEquals("Attached", DeliverablesUx.sourceLabel(DeliverableVersionDto(source = "attached")))
        assertEquals("", DeliverablesUx.sourceLabel(null))
    }

    @Test
    fun previewModeByKind() {
        assertEquals(DeliverablesUx.Preview.Pdf, DeliverablesUx.preview("pdf"))
        assertEquals(DeliverablesUx.Preview.Image, DeliverablesUx.preview("image"))
        assertEquals(DeliverablesUx.Preview.Csv, DeliverablesUx.preview("csv"))
        assertEquals(DeliverablesUx.Preview.Browser, DeliverablesUx.preview("video"))
    }

    @Test
    fun rowMetaShowsVersionOnlyWhenSeveral() {
        val v = DeliverableVersionDto(source = "attached", authorAlias = "Hussein", sizeBytes = 2048)
        val one = DeliverableDto(path = "a.md", latestVersion = 1, versionCount = 1, latest = v)
        assertEquals("Attached · Hussein · 2.0 KB", DeliverablesUx.rowMeta(one))
        assertTrue(DeliverablesUx.rowMeta(one.copy(latestVersion = 3, versionCount = 3)).startsWith("v3 · "))
    }

    @Test
    fun dirAndExtensions() {
        assertEquals("reports/", DeliverablesUx.dirOf("reports/q3.md"))
        assertEquals("", DeliverablesUx.dirOf("q3.md"))
        assertTrue(DeliverablesUx.extensionAllowed("Q3.PDF", listOf("pdf", "md")))
        assertFalse(DeliverablesUx.extensionAllowed("run.exe", listOf("pdf", "md")))
        assertFalse(DeliverablesUx.extensionAllowed("README", listOf("pdf")))
        assertTrue(DeliverablesUx.extensionAllowed("anything.bin", emptyList()))
    }

    @Test
    fun csvParsesQuotesAndTabs() {
        val rows = DeliverablesUx.parseCsv("name,note\r\n\"Smith, J\",\"said \"\"hi\"\"\"\nx,y", ',')
        assertEquals(listOf(listOf("name", "note"), listOf("Smith, J", "said \"hi\""), listOf("x", "y")), rows)
        assertEquals('\t', DeliverablesUx.delimiterFor("a.TSV"))
        assertEquals(2, DeliverablesUx.parseCsv("a\nb\nc\n", ',', maxRows = 2).size)
    }

    @Test
    fun compareCandidatesAreOlderNewestFirst() {
        val vs = (1..4).map { DeliverableVersionDto(version = it) }
        assertEquals(listOf(2, 1), DeliverablesUx.compareCandidates(vs, 3))
        assertEquals(emptyList(), DeliverablesUx.compareCandidates(vs, 1))
    }

    @Test
    fun prettyJsonFallsBackToRawText() {
        assertEquals("{\n    \"a\": 1\n}", DeliverablesUx.prettyJson("{\"a\":1}"))
        assertEquals("not json", DeliverablesUx.prettyJson("not json"))
    }

    @Test
    fun copyMatchesWeb() {
        assertEquals("No changes — identical to the latest version", DeliverablesUx.uploadNotice("a.md", true))
        assertEquals("Attached a.md", DeliverablesUx.uploadNotice("a.md", false))
        assertEquals("None yet. Agents publish files by writing to .orcha/outputs; you can also attach one.", DeliverablesUx.emptyCopy(".orcha/outputs", true))
        assertEquals(
            "v1 → v2: file changed (1.0 KB → 2.0 KB). Binary files have no text diff — preview each version to compare.",
            DeliverablesUx.binaryDiffCopy(DeliverableVersionDto(version = 1, sizeBytes = 1024), DeliverableVersionDto(version = 2, sizeBytes = 2048), true),
        )
    }

    @Test
    fun reassignRulesMatchIos() {
        assertTrue(TaskInsightsUx.canReassign(false, "in_progress"))
        assertTrue(TaskInsightsUx.canReassign(false, "pending"))
        assertFalse(TaskInsightsUx.canReassign(true, "in_progress"))
        assertFalse(TaskInsightsUx.canReassign(false, "needs_verification"))
        assertFalse(TaskInsightsUx.canReassign(false, "completed"))
    }
}
