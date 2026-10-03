package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Decoding of the task deliverables payloads (shapes from `deliverables_routes.py`). */
class DeliverablesDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    private val version = """
        {"version":2,"source":"run_output","run_id":"r1","author_agent_id":"a1","author_alias":"dev","author_kind":"ai",
         "size_bytes":12345,"sha256":"abc","content_type":"text/markdown; charset=utf-8","note":null,
         "created_at":"2026-10-02T10:00:00+00:00","raw_url":"/api/tasks/t1/deliverables/d1/versions/2/raw",
         "text_url":"/api/tasks/t1/deliverables/d1/versions/2/text"}
    """

    @Test
    fun listDecodes() {
        val raw = """
        {"task_id":"t1","deliverables":[{"id":"d1","task_id":"t1","path":"reports/q3.md","name":"q3.md","kind":"markdown",
          "latest_version":2,"version_count":2,"created_at":"2026-10-01T10:00:00+00:00","updated_at":"2026-10-02T10:00:00+00:00",
          "latest":$version}],
         "limits":{"max_bytes":26214400,"max_deliverables_per_task":200,"max_versions_per_deliverable":50,
          "allowed_extensions":["csv","md","pdf","png"],"outputs_folder":".orcha/outputs"}}
        """
        val list = json.decodeFromString<DeliverableListDto>(raw)
        val d = list.deliverables.single()
        assertEquals("reports/q3.md", d.path)
        assertEquals(2, d.versionCount)
        assertEquals("run_output", d.latest?.source)
        assertEquals(12345L, d.latest?.sizeBytes)
        assertEquals("/api/tasks/t1/deliverables/d1/versions/2/text", d.latest?.textUrl)
        assertNull(d.versions)
        assertEquals(26214400L, list.limits.maxBytes)
        assertEquals(listOf("csv", "md", "pdf", "png"), list.limits.allowedExtensions)
    }

    @Test
    fun detailCarriesVersions() {
        val raw = """{"id":"d1","task_id":"t1","path":"chart.png","name":"chart.png","kind":"image","latest_version":2,
          "version_count":2,"latest":$version,"versions":[$version,{"version":1,"source":"attached","size_bytes":10,
          "sha256":"x","content_type":"image/png","raw_url":"/r","text_url":null}]}"""
        val d = json.decodeFromString<DeliverableDto>(raw)
        assertEquals(listOf(2, 1), d.versions?.map { it.version })
        assertNull(d.versions?.last()?.textUrl)
    }

    @Test
    fun textDiffDecodes() {
        val raw = """{"deliverable_id":"d1","path":"q3.md","kind":"markdown","from":$version,"to":$version,"binary":false,
          "bytes_changed":true,"diff":"diff --git a/q3.md b/q3.md\n@@ -1 +1 @@\n-a\n+b","added":1,"removed":1,
          "identical":false,"truncated":false,"from_label":"v1","to_label":"v2"}"""
        val d = json.decodeFromString<DeliverableDiffDto>(raw)
        assertFalse(d.binary)
        assertEquals(1, d.added)
        assertTrue(d.diff!!.contains("@@"))
    }

    @Test
    fun binaryDiffDecodesWithoutTextFields() {
        val raw = """{"deliverable_id":"d1","path":"a.pdf","kind":"pdf","from":$version,"to":$version,"binary":true,"bytes_changed":false}"""
        val d = json.decodeFromString<DeliverableDiffDto>(raw)
        assertTrue(d.binary)
        assertNull(d.diff)
        assertFalse(d.identical)
    }

    @Test
    fun textAndUploadDecode() {
        val t = json.decodeFromString<DeliverableTextDto>(
            """{"deliverable_id":"d1","version":1,"kind":"csv","path":"a.csv","size_bytes":5,"text":"a,b","truncated":true,"max_bytes":4}""",
        )
        assertTrue(t.truncated)
        assertEquals("a,b", t.text)
        val u = json.decodeFromString<DeliverableUploadDto>("""{"created":false,"deduplicated":true,"deliverable":null,"version":$version}""")
        assertTrue(u.deduplicated)
        assertEquals(2, u.version?.version)
    }
}
