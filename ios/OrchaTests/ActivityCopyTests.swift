import Testing
@testable import Orcha

struct ActivityCopyTests {
    @Test(arguments: [
        ("[DECISION · plan_approval = APPROVED by hussein-owner]", "Approved the plan"),
        ("[DECISION · plan_approval = REJECTED by hussein-owner] — too broad", "Rejected the plan — too broad"),
        ("[verification rejected] Flaky test on CI", "Rejected verification — Flaky test on CI"),
        ("[verification approved] Looks good", "Verified — Looks good"),
        ("[verification approved]", "Verified"),
        ("task_assigned", "Task assigned"),
        ("conversation_turn", "Conversation turn"),
        ("task assigned", "Task assigned"),
        ("this is just a normal lowercase sentence", "this is just a normal lowercase sentence"),
        ("Shipped the fix, see PR #12", "Shipped the fix, see PR #12"),
        ("", ""),
    ])
    func humanize(raw: String, expected: String) {
        #expect(ActivityCopy.humanize(raw) == expected)
    }

    @Test func leavesOrdinaryBracketedTextAlone() {
        #expect(ActivityCopy.humanize("[draft] notes") == "[draft] notes")
    }

    @Test func previewDropsMarkdownMarkers() {
        #expect(ActivityCopy.preview("## Plan\n1. Add `POST /x` **now**") == "Plan 1. Add POST /x now")
    }
}
