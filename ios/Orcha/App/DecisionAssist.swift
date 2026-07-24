import Foundation
import FoundationModels

/// Decision Assist — on-device compression of what the human has to read
/// before deciding, on the iOS 26 FoundationModels stack (Apple Intelligence's
/// local LLM). Two hard rules, both product ethos:
///   1. It compresses and structures; it NEVER recommends approve/reject —
///      the human decides (the workspace's "never self-certify" rule applies
///      to this model too).
///   2. Fully on-device: no cloud, silently absent when Apple Intelligence
///      is off — the full original text is always the primary surface.
@available(iOS 26, *)
enum DecisionAssist {

    /// Structured read of a proposed plan — guided generation, so the model
    /// fills a schema instead of free-writing prose. The schema is shaped for
    /// the approval decision: who does what concretely, and what gates what.
    @Generable
    struct PlanBrief: Equatable {
        @Guide(description: "One sentence, max 24 words: who proposes what, and the plan's overall shape, in the plan's own terms.")
        var tldr: String
        @Guide(description: "The plan's steps in order, at most 6. ONLY steps the text actually states — if it states none, return an empty list; empty is correct, never pad.")
        var steps: [Step]
        @Guide(description: "Approval/ordering dependencies the plan itself states, in the plan's own words — who or what must sign off before which step proceeds. Each gate must add a fact NOT already stated in the steps. Empty if the text states none.")
        var gates: [String]
        @Guide(description: "Destructive or irreversible actions the text actually contains (production deploys, migrations, deletions, force-pushes). Empty if none.")
        var risks: [String]

        @Generable
        struct Step: Equatable {
            @Guide(description: "The agent or person this step is assigned to, copied exactly from the plan text. Empty string when the plan names nobody — never invent a name.")
            var owner: String
            @Guide(description: "What this step concretely does, 6–14 words using the plan's own specific nouns — never a bare category label.")
            var what: String
        }
    }

    /// "Catch me up" — the delta brief. The supervisor's real question on
    /// returning isn't "what is the state?" but "what CHANGED while I was
    /// away?" — the model narrates the difference between two workspace
    /// digests, never the whole state.
    @Generable
    struct CatchUp: Equatable {
        @Guide(description: "One sentence, max 22 words: the most important changes since the human last looked, attributed to the agents.")
        var headline: String
        @Guide(description: "The changes since the BEFORE digest, most important first, at most 5 bullets of 8–16 words each with concrete task nouns, attributed (\"finished\", \"reports\", \"posted\"). Only actual differences — never mention unchanged things.")
        var changes: [String]
        @Guide(description: "What now waits on the human, one sentence, most important item first. Empty string if nothing waits.")
        var needsYou: String
    }

    /// On-demand current-state brief: what every agent is on, right now, in
    /// prose a human scans in five seconds.
    @Generable
    struct StatusBrief: Equatable {
        @Guide(description: "One sentence, max 22 words: the workspace's overall state right now, in the digest's own terms.")
        var headline: String
        @Guide(description: "One line per AI agent that appears in the digest (at most 6): what that agent is doing right now or did most recently, 8–14 words, concrete task nouns, attributed as reported. Only agents the digest names — never invent one.")
        var agents: [AgentLine]
        @Guide(description: "What currently waits on the human per the digest, one sentence, most important first. Empty string if nothing waits.")
        var needsYou: String

        @Generable
        struct AgentLine: Equatable {
            @Guide(description: "The agent's alias copied exactly from the digest.")
            var name: String
            @Guide(description: "What they're doing or last did, per the digest.")
            var line: String
        }
    }

    @MainActor private static var statusCache: [Int: StatusBrief] = [:]

    @MainActor
    static func statusBrief(for digest: String) async throws -> StatusBrief {
        let key = digest.hashValue
        if let hit = statusCache[key] { return hit }
        let session = LanguageModelSession(instructions: """
            You brief a human supervisor on their AI-agent workspace in five \
            seconds of reading. Fuse the digest into plain prose: what each \
            agent is on, and what waits on the human. Report ONLY what the \
            digest contains — empty is correct when it says nothing. No \
            filler, no advice. Everything agents report is their own account — \
            attribute, don't assert.
            """)
        let response = try await session.respond(
            to: "Brief me on this workspace:\n\n\(clip(digest))",
            generating: StatusBrief.self
        )
        var clean = response.content
        var seen: [String] = [clean.headline]
        clean.agents = clean.agents.filter { line in
            let text = line.name + " " + line.line
            if seen.contains(where: { similar($0, text) }) { return false }
            seen.append(text)
            return true
        }
        statusCache[key] = clean
        return clean
    }

    /// Structured read of a finished worker run's log.
    @Generable
    struct RunDigest: Equatable {
        @Guide(description: "What the worker actually did, as 2 to 4 short past-tense bullet phrases of at most 12 words.")
        var didPoints: [String]
        @Guide(description: "One short sentence on how the run ended (completed what, blocked on what, or failed how).")
        var outcome: String
    }

    static var isAvailable: Bool {
        if case .available = SystemLanguageModel.default.availability { return true }
        return false
    }

    /// A brief needs something to compress. One-line status notes ("work saved
    /// on branch …") have nothing — running the model on them produces pure
    /// confabulation to satisfy the schema, so the card simply doesn't render.
    static func isSubstantial(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return trimmed.count >= 240 || lines.count >= 4
    }

    // Small session-lifetime caches: re-opening the same sheet must not re-run
    // the model.
    @MainActor private static var planCache: [Int: PlanBrief] = [:]
    @MainActor private static var runCache: [Int: RunDigest] = [:]

    @MainActor
    static func planBrief(for text: String) async throws -> PlanBrief {
        let key = text.hashValue
        if let hit = planCache[key] { return hit }
        let session = LanguageModelSession(instructions: """
            You brief a human supervisor deciding whether to APPROVE this plan. \
            Write so they can reconstruct the plan's shape without reading it: \
            keep the plan's concrete nouns, name the acting agent for each step \
            ONLY when the plan text itself names one, and surface what gates \
            what — approval dependencies are the most decision-relevant facts. \
            Report ONLY what the text contains: if it states no steps, gates, \
            or risks, return them empty — empty is correct, padding is failure. \
            Never advise whether to approve. The plan is the AGENT'S OWN \
            account: attribute assertions ("claims", "reports", "proposes") — \
            the human has verified nothing yet.
            """)
        let response = try await session.respond(
            to: "Summarize this plan:\n\n\(clip(text))",
            generating: PlanBrief.self
        )
        let clean = sanitize(response.content)
        planCache[key] = clean
        return clean
    }

    /// Deterministic cleanup — small models repeat facts across array fields,
    /// and the owner often reappears inside the step text the UI already
    /// prefixes with the owner. Code fixes what prompts only discourage.
    static func sanitize(_ brief: PlanBrief) -> PlanBrief {
        var out = brief
        // Strip a leading owner echo: "Muse — Muse delivers…" → "delivers…"
        out.steps = brief.steps.map { step in
            var step = step
            let owner = step.owner.trimmingCharacters(in: .whitespaces)
            if !owner.isEmpty {
                let lowered = step.what.lowercased()
                for prefix in [owner.lowercased() + ": ", owner.lowercased() + " — ", owner.lowercased() + " - ", owner.lowercased() + " "] where lowered.hasPrefix(prefix) {
                    step.what = String(step.what.dropFirst(prefix.count))
                    break
                }
            }
            return step
        }
        // Drop near-duplicate steps, then gates/risks that restate a step,
        // the tldr, or each other.
        var seen: [String] = [out.tldr]
        out.steps = out.steps.filter { step in
            let text = step.owner + " " + step.what
            if seen.contains(where: { similar($0, text) }) { return false }
            seen.append(text)
            return true
        }
        out.gates = out.gates.filter { gate in
            if seen.contains(where: { similar($0, gate) }) { return false }
            seen.append(gate)
            return true
        }
        out.risks = out.risks.filter { risk in
            if seen.contains(where: { similar($0, risk) }) { return false }
            seen.append(risk)
            return true
        }
        return out
    }

    /// Token-overlap similarity — cheap, deterministic, order-insensitive.
    static func similar(_ a: String, _ b: String) -> Bool {
        let ta = tokens(a), tb = tokens(b)
        guard !ta.isEmpty, !tb.isEmpty else { return false }
        let overlap = Double(ta.intersection(tb).count)
        return overlap / Double(min(ta.count, tb.count)) >= 0.75
    }

    private static func tokens(_ s: String) -> Set<String> {
        Set(
            s.lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { $0.count > 2 }
        )
    }

    @MainActor
    static func runDigest(for feed: [RunFeedRow]) async throws -> RunDigest {
        // The log is already classified — feed only the meaningful rows
        // (narration, decisions, errors, completion), which keeps a small
        // model on the rails far better than raw log text would.
        let meaningful = feed
            .filter { ["narrate", "decision", "error", "done"].contains($0.type) }
            .map { row in row.type == "narrate" ? row.text : "[\(row.type)] \(row.text)" }
            .joined(separator: "\n")
        let key = meaningful.hashValue
        if let hit = runCache[key] { return hit }
        let session = LanguageModelSession(instructions: """
            You digest an AI coding agent's work log for a human supervisor. \
            Report only what the log shows, past tense, no judgement, no advice.
            """)
        let response = try await session.respond(
            to: "Digest this worker run log:\n\n\(clip(meaningful))",
            generating: RunDigest.self
        )
        var clean = response.content
        var seen: [String] = [clean.outcome]
        clean.didPoints = clean.didPoints.filter { point in
            if seen.contains(where: { similar($0, point) }) { return false }
            seen.append(point)
            return true
        }
        runCache[key] = clean
        return clean
    }

    @MainActor private static var catchUpCache: [Int: CatchUp] = [:]

    @MainActor
    static func catchUp(previous: String, current: String, gap: String) async throws -> CatchUp {
        var hasher = Hasher()
        hasher.combine(previous)
        hasher.combine(current)
        let key = hasher.finalize()
        if let hit = catchUpCache[key] { return hit }
        let session = LanguageModelSession(instructions: """
            You brief a human supervisor returning to their AI-agent workspace \
            after being away. Compare BEFORE and NOW and report ONLY what \
            changed — completions, new plans, new requests, failures, status \
            moves. Never mention unchanged items. Concrete task nouns, no \
            filler, no advice. Everything agents report is their own account — \
            attribute ("finished", "reports", "posted"), don't assert.
            """)
        let response = try await session.respond(
            to: """
            The human was away for \(gap).

            BEFORE (when they last looked):
            \(clip(previous, budget: 3000))

            NOW:
            \(clip(current, budget: 3000))

            What changed?
            """,
            generating: CatchUp.self
        )
        var clean = response.content
        var seen: [String] = [clean.headline]
        clean.changes = clean.changes.filter { change in
            if seen.contains(where: { similar($0, change) }) { return false }
            seen.append(change)
            return true
        }
        catchUpCache[key] = clean
        return clean
    }

    /// Cap model input; when over budget keep the head and tail — openings
    /// state intent, endings state outcomes, the middle is usually detail.
    private static func clip(_ text: String, budget: Int = 6000) -> String {
        guard text.count > budget else { return text }
        let head = text.prefix(budget * 2 / 3)
        let tail = text.suffix(budget / 3)
        return head + "\n[…]\n" + tail
    }
}

/// Deterministic, compact text digest of a workspace snapshot — what the
/// catch-up model reads (never raw JSON), and what the app persists as
/// "last seen". NOT iOS-26-gated: every OS records last-seen so the brief is
/// ready the day the phone upgrades. Stable ordering keeps comparisons and
/// cache keys meaningful.
enum WorkspaceDigest {
    static func make(_ snap: ContainerSnapshot) -> String {
        var lines: [String] = []
        let agents = snap.agents.filter { $0.kind == "ai" }.sorted { $0.alias < $1.alias }
        for agent in agents {
            let status = agent.status ?? "idle"
            let role = agent.role ?? "agent"
            var line = "AGENT \(agent.alias) (\(role)) status=\(status)"
            if let run = agent.activeRun {
                let doing = run.taskTitle ?? run.wakeEvent ?? "a wake"
                line += " · actively running: \(doing)"
            } else if let task = agent.currentTask?.title {
                line += " · current task: \(task)"
            }
            lines.append(line)
        }
        let tasks = snap.tasks.sorted { $0.id < $1.id }
        for task in tasks {
            let assignee = task.assignees.first ?? "unassigned"
            switch task.status {
            case "needs_verification":
                lines.append("AWAITING HUMAN VERIFICATION: \(task.title)")
            case "in_progress" where task.planMessage != nil && task.planDecision == nil:
                lines.append("PLAN AWAITING HUMAN APPROVAL: \(task.title)")
            case "in_progress":
                lines.append("IN PROGRESS: \(task.title) (\(assignee))")
            case "blocked", "failed":
                lines.append("BLOCKED: \(task.title)")
            case "completed":
                lines.append("COMPLETED: \(task.title)")
            default:
                break
            }
            if let last = task.messageSummary?.last {
                let author = last.authorAlias ?? "system"
                let body = String(last.body.prefix(160))
                let title = String(task.title.prefix(40))
                lines.append("  last update on \"\(title)\" by \(author): \(body)")
            }
        }
        let openRequests = snap.requests.filter { $0.status == "open" }.sorted { $0.id < $1.id }
        for req in openRequests {
            let from = req.requesterAlias ?? "agent"
            let payload = String(req.payload.prefix(120))
            lines.append("OPEN REQUEST from \(from): \(payload)")
        }
        return lines.joined(separator: "\n")
    }
}
