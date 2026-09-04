package io.openorcha.mobile.data

/** The Issues-tab decode regression: labels moved server-side from name strings to
 *  {name, color} objects — the row must decode BOTH shapes (and never break again). */

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GitHubLabelDecodeTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun decodesObjectLabelsWithColor() {
        val row = json.decodeFromString<GitHubIssueRow>(
            """{"number":292,"title":"t","labels":[{"name":"mobile","color":"1D76DB"},{"name":"gap","color":null}]}""",
        )
        assertEquals(listOf("mobile", "gap"), row.labels.map { it.name })
        assertEquals("1D76DB", row.labels[0].color)
        assertNull(row.labels[1].color)
    }

    @Test
    fun decodesLegacyStringLabels() {
        val row = json.decodeFromString<GitHubIssueRow>(
            """{"number":1,"title":"t","labels":["bug","P1"]}""",
        )
        assertEquals(listOf("bug", "P1"), row.labels.map { it.name })
        assertNull(row.labels[0].color)
    }
}
