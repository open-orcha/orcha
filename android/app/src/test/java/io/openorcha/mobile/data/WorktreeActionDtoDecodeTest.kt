package io.openorcha.mobile.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorktreeActionDtoDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `decodes the server's action shape and reads pending`() {
        val raw = """{"id":"6f1c2a9e-0000-4000-8000-000000000001","action":"clean_up","path":null,"branch":null,
            "keep_branch":false,"confirm_unmerged":false,"include_output":false,"unmerged_paths":[],
            "status":"requested","result":null,"error":null,"requested_by":"a1","claimed_by":null,
            "created_at":"2026-10-02T10:00:00Z","claimed_at":null,"finished_at":null}"""
        val a = json.decodeFromString<WorktreeActionDto>(raw)
        assertEquals("clean_up", a.action)
        assertTrue(a.pending)
        assertTrue(a.copy(status = "claimed").pending)
        assertFalse(a.copy(status = "done").pending)
    }

    @Test
    fun `failed action carries its error`() {
        val a = json.decodeFromString<WorktreeActionDto>("""{"id":"x","status":"failed","error":"git busy"}""")
        assertFalse(a.pending)
        assertEquals("git busy", a.error)
    }

    @Test
    fun `clean count comes from the inventory counts`() {
        val r = json.decodeFromString<AgentWorktreesResponse>(
            """{"settings":{"auto_cleanup":true,"grace_days":7},"inventory":{"host":"mac","counts":{"clean":3,"unmerged":1},"items":[]}}""",
        )
        assertEquals(3, r.inventory?.counts?.get("clean"))
    }
}
