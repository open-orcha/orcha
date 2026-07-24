import Testing
@testable import Orcha

/// The brief sanitizer is deterministic post-processing over model output —
/// small models repeat facts across array fields and echo the owner inside
/// step text. Pin the cleanup rules.
struct DecisionAssistSanitizeTests {
    @available(iOS 26, *)
    private func brief(
        tldr: String = "Atlas proposes a gated pipeline.",
        steps: [(String, String)],
        gates: [String] = [],
        risks: [String] = []
    ) -> DecisionAssist.PlanBrief {
        var b = DecisionAssist.PlanBrief(
            tldr: tldr,
            steps: steps.map { DecisionAssist.PlanBrief.Step(owner: $0.0, what: $0.1) },
            gates: gates,
            risks: risks
        )
        b = DecisionAssist.sanitize(b)
        return b
    }

    @Test func stripsOwnerEchoFromStepText() {
        guard #available(iOS 26, *) else { return }
        let b = brief(steps: [("Muse", "Muse: delivers the design spec with tokens")])
        #expect(b.steps[0].what == "delivers the design spec with tokens")
        #expect(b.steps[0].owner == "Muse")
    }

    @Test func dropsNearDuplicateSteps() {
        guard #available(iOS 26, *) else { return }
        let b = brief(steps: [
            ("Muse", "delivers the design spec with brand tokens"),
            ("Muse", "the design spec with brand tokens is delivered"),
            ("Crimson", "builds the Next.js marketing pages"),
        ])
        #expect(b.steps.count == 2)
        #expect(b.steps[1].owner == "Crimson")
    }

    @Test func dropsGatesThatRestateSteps() {
        guard #available(iOS 26, *) else { return }
        let b = brief(
            steps: [("", "design spec approval by the human before any build")],
            gates: [
                "Design spec approval by the human before build",
                "Deploy only after tests pass on the release tag",
            ]
        )
        #expect(b.gates.count == 1)
        #expect(b.gates[0].contains("Deploy"))
    }

    @Test func keepsDistinctFacts() {
        guard #available(iOS 26, *) else { return }
        let b = brief(
            steps: [("Muse", "delivers the design spec"), ("Crimson", "rebuilds the pricing page")],
            gates: ["Nothing deploys until the human merges the PR"],
            risks: ["Production deploy of the marketing site"]
        )
        #expect(b.steps.count == 2)
        #expect(b.gates.count == 1)
        #expect(b.risks.count == 1)
    }
}

extension DecisionAssistSanitizeTests {
    @Test func thinInputIsNotSummarizable() {
        guard #available(iOS 26, *) else { return }
        #expect(!DecisionAssist.isSubstantial("work saved on branch orcha/task-Forge-36a97391-752 (uncommitted, preserved)"))
        #expect(!DecisionAssist.isSubstantial("  \n"))
        let real = Array(repeating: "1. Muse delivers the design spec with tokens and nav redesign.", count: 5).joined(separator: "\n")
        #expect(DecisionAssist.isSubstantial(real))
    }
}
