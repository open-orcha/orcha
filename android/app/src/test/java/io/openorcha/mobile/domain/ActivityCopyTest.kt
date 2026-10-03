package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals

class ActivityCopyTest {

    @Test fun planApproved() =
        assertEquals("Approved the plan", ActivityCopy.humanize("[DECISION · plan_approval = APPROVED by hussein-owner]"))

    @Test fun planRejectedWithReason() =
        assertEquals(
            "Rejected the plan — needs tests first",
            ActivityCopy.humanize("[DECISION · plan_approval = REJECTED by hussein-owner] — needs tests first"),
        )

    @Test fun verificationRejected() =
        assertEquals("Rejected verification — Flaky on CI", ActivityCopy.humanize("[verification rejected] Flaky on CI"))

    @Test fun verificationApprovedWithNote() =
        assertEquals("Verified — looks good", ActivityCopy.humanize("[verification approved] looks good"))

    @Test fun verificationApprovedBare() =
        assertEquals("Verified", ActivityCopy.humanize("[verification approved]"))

    @Test fun rawKinds() {
        assertEquals("Task assigned", ActivityCopy.humanize("task_assigned"))
        assertEquals("Conversation turn", ActivityCopy.humanize("conversation_turn"))
        assertEquals("Needs verification", ActivityCopy.humanizeKind("needs_verification"))
    }

    @Test fun plainTextUnchanged() {
        assertEquals("Pushed the fix to main.", ActivityCopy.humanize("Pushed the fix to main."))
        assertEquals("hello", ActivityCopy.humanize("  hello  "))
        assertEquals("", ActivityCopy.humanize(null))
    }

    @Test fun otherDecisionKeys() =
        assertEquals("Approved the merge request", ActivityCopy.humanize("[DECISION · merge_request = APPROVED by x]"))

    @Test fun previewDropsMarkdownMarkers() =
        assertEquals("Plan 1. Add POST /x now", ActivityCopy.preview("## Plan\n1. Add `POST /x` **now**"))
}
