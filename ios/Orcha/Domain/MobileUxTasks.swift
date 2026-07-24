import Foundation

// Responsibility: Task priority, agent ordering, status copy, autonomy, and grouping behavior.

extension MobileUx {
    // MARK: flows 11 + 05 — priority

    static func priorityBand(_ priority: Int?) -> PriorityBand {
        guard let priority else { return .normal }
        if priority <= 20 { return .high }
        if priority <= 40 { return .elevated }
        return .normal
    }

    static func priorityFor(_ band: PriorityBand) -> Int {
        switch band {
        case .high: 20
        case .elevated: 40
        case .normal: 100
        case .low: 300
        }
    }

    // MARK: flow 09 — roster order (working first, terminated last)

    static func orderAgents(_ agents: [AgentDto]) -> [AgentDto] {
        func rank(_ status: String?) -> Int {
            switch status {
            case "working": 0
            case "awaiting_human": 1
            case "blocked": 2
            case "awaiting_request": 3
            case "idle": 4
            case "terminated": 9
            default: 5
            }
        }
        return agents.enumerated()
            .sorted { (rank($0.element.status), $0.offset) < (rank($1.element.status), $1.offset) }
            .map(\.element)
    }

    // MARK: doc 12 — binding status display copy

    static func statusCopy(_ status: String) -> String {
        switch status {
        case "needs_verification": "needs verification"
        case "converted_to_task": "became a task"
        case "awaiting_request": "waiting on a request"
        case "awaiting_human": "waiting on you"
        case "in_progress": "in progress"
        default: status.replacingOccurrences(of: "_", with: " ")
        }
    }

    // MARK: GH #148 — the autonomy gearbox (`plan` | `pr` | `full`)

    static func autonomyLabel(_ level: String) -> String {
        switch level {
        case "pr": "Build to PR"
        case "full": "Full"
        default: "Plan-only"
        }
    }

    static func autonomyBlurb(_ level: String) -> String {
        switch level {
        case "pr": "Agents execute approved plans up to an open PR; you still merge."
        case "full": "Agents may carry approved work to its terminal state without further gates."
        default: "Agents wake & propose, but every plan stops at the approval gate — you approve before any execution."
        }
    }

    // MARK: flow 05 — "Needs me" + status group order

    static func needsMe(_ tasks: [TaskDto]) -> [TaskDto] {
        tasks.filter {
            $0.status == "needs_verification" ||
                ($0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil)
        }
    }

    static func taskGroupRank(_ status: String) -> Int {
        switch status {
        case "in_progress": 0
        case "blocked": 1
        case "needs_verification": 2
        case "ready": 3
        case "pending": 4
        case "not_ready": 5
        case "completed": 6
        case "cancelled": 7
        default: 8
        }
    }

    static func isTerminalGroup(_ status: String) -> Bool {
        status == "completed" || status == "cancelled"
    }

}
