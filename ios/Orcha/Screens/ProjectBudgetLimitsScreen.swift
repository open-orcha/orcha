import SwiftUI

/// Settings › Execution › Budget & limits: the project's monthly budget (a hard stop on
/// new runs for every agent; `GET …/budgets`, `PUT …/budget`) and the agent limit
/// (`GET/PUT …/limits`, 1–50). Editable by an owner / the manage_autonomy grant (budget)
/// or manage_agents (agent limit, the server's gate); read-only otherwise, with the reason.
struct ProjectBudgetLimitsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    @State private var budgets: ProjectBudgetsDto?
    @State private var limits: ContainerLimitsDto?
    @State private var budgetError: String?
    @State private var limitsError: String?
    @State private var usdDraft = ""
    @State private var tokensDraft = ""
    @State private var limitDraft = 12
    @State private var busy = false
    @State private var notice: String?
    @State private var actionError: String?

    private var canBudget: Bool { model.humanId != nil && model.access.canManage(Grant.manageAutonomy) }
    private var canLimit: Bool { model.humanId != nil && model.access.canManage(Grant.manageAgents) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                if let notice { Banner(kind: .info, text: notice) }
                if let actionError { Banner(kind: .danger, text: actionError) }
                budgetSection
                limitSection
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .navigationTitle("Budget & limits")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    // MARK: budget

    @ViewBuilder
    private var budgetSection: some View {
        let caption = budgets.map { "\(AgentBudgetUx.period($0.period)) · resets \(AgentBudgetUx.reset($0.resetsAt)) (UTC)" }
        LSection("Project budget") {
            VStack(alignment: .leading, spacing: LSpace.s) {
                if let caption { Text(caption).ltype(.micro).foregroundStyle(p.muted) }
                if let b = budgets?.project {
                    budgetCard(b)
                } else if let budgetError {
                    Banner(kind: .warn, text: "Budget is temporarily unavailable — \(budgetError)", action: "Retry") {
                        Task { await load() }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
    }

    private func budgetCard(_ b: AgentBudgetDto) -> some View {
        LCard {
            VStack(alignment: .leading, spacing: LSpace.m) {
                HStack {
                    if let label = AgentBudgetUx.healthLabel(b) {
                        LTag(label, tint: b.state == "exceeded" ? p.danger : (b.state == "warning" ? p.warn : p.ok))
                    }
                    Spacer(minLength: 0)
                    Label(canBudget ? "Human-only" : "Read-only", systemImage: "lock.shield")
                        .ltype(.micro).foregroundStyle(p.faint)
                }
                if b.paused {
                    Banner(kind: .danger, text: b.reason ?? "New runs are paused for every agent — the project budget is reached.")
                }
                Text(spendLine(b)).ltype(.bodyEmph).foregroundStyle(p.text)
                Text("\(AgentBudgetUx.tokens(b.usage.tokens)) tokens · \(b.usage.runs) \(b.usage.runs == 1 ? "run" : "runs") this month")
                    .ltype(.meta).foregroundStyle(p.text2)
                if b.usage.unmeteredRuns > 0 {
                    Text("\(b.usage.unmeteredRuns) \(b.usage.unmeteredRuns == 1 ? "run" : "runs") not metered — not counted as $0.")
                        .ltype(.micro).foregroundStyle(p.muted)
                }
                if b.override.active {
                    Text("One-time override active until \(AgentBudgetUx.reset(b.resetsAt))" + (b.override.note.map { " · “\($0)”" } ?? ""))
                        .ltype(.micro).foregroundStyle(p.warn)
                }
                if canBudget {
                    LDivider()
                    limitField("Monthly limit (USD)", text: $usdDraft, placeholder: "No limit", keyboard: .decimalPad)
                    limitField("Monthly token cap", text: $tokensDraft, placeholder: "No cap", keyboard: .numberPad)
                    if let invalid = budgetInvalidText {
                        Text(invalid).ltype(.micro).foregroundStyle(p.danger)
                    }
                    HStack(spacing: LSpace.s) {
                        LButton("Save budget", kind: .primary, size: .small) { Task { await saveBudget(b) } }
                            .disabled(busy || budgetInvalidText != nil || !budgetDirty(b))
                        if b.state == "exceeded" && !b.override.active {
                            LButton("Override this month", kind: .ghost, size: .small) {
                                Task { await sendBudget(AgentBudgetUpdate(override: "grant"), ok: "Override granted until \(AgentBudgetUx.reset(b.resetsAt)).") }
                            }
                            .disabled(busy)
                        } else if b.override.active {
                            LButton("Revoke override", kind: .ghost, size: .small) {
                                Task { await sendBudget(AgentBudgetUpdate(override: "revoke"), ok: "Override revoked.") }
                            }
                            .disabled(busy)
                        }
                    }
                    Text("Leave a field blank for no limit. When the project reaches its budget, no agent starts a new run until next month or an override. Runs in progress are never stopped.")
                        .ltype(.micro).foregroundStyle(p.muted)
                } else if let reason = model.access.manageDenialReason(Grant.manageAutonomy, action: "Changing the project budget") {
                    Text(reason).ltype(.micro).foregroundStyle(p.muted)
                }
            }
        }
    }

    private func spendLine(_ b: AgentBudgetDto) -> String {
        if b.spendUnknown { return "Spend not metered" + (b.limits.usd.map { " · limit \(AgentBudgetUx.usd($0))" } ?? "") }
        if let limit = b.limits.usd {
            return "\(AgentBudgetUx.usd(b.usage.spendUsd)) of \(AgentBudgetUx.usd(limit)) · \(AgentBudgetUx.percent(b.usdRatio))"
        }
        return "\(AgentBudgetUx.usd(b.usage.spendUsd)) this month · no limit"
    }

    private func limitField(_ label: String, text: Binding<String>, placeholder: String, keyboard: UIKeyboardType) -> some View {
        LabeledContent(label) {
            TextField(placeholder, text: text)
                .keyboardType(keyboard)
                .multilineTextAlignment(.trailing)
                .frame(minHeight: 44)
        }
        .ltype(.meta)
        .foregroundStyle(p.text)
    }

    private var budgetInvalidText: String? {
        if AgentBudgetUx.parseLimit(usdDraft, integer: false) == .invalid { return "Enter a dollar amount, or leave it blank." }
        if AgentBudgetUx.parseLimit(tokensDraft, integer: true) == .invalid { return "Enter a whole number of tokens, or leave it blank." }
        return nil
    }

    private func budgetDirty(_ b: AgentBudgetDto) -> Bool {
        usdUpdate(b) != nil || tokensUpdate(b) != nil
    }

    private func usdUpdate(_ b: AgentBudgetDto) -> AgentBudgetUpdate.Limit<Double>? {
        switch AgentBudgetUx.parseLimit(usdDraft, integer: false) {
        case .none: b.limits.usd == nil ? nil : .clear
        case let .value(v): b.limits.usd == v ? nil : .set(v)
        case .invalid: nil
        }
    }

    private func tokensUpdate(_ b: AgentBudgetDto) -> AgentBudgetUpdate.Limit<Int>? {
        switch AgentBudgetUx.parseLimit(tokensDraft, integer: true) {
        case .none: b.limits.tokens == nil ? nil : .clear
        case let .value(v): b.limits.tokens == Int(v) ? nil : .set(Int(v))
        case .invalid: nil
        }
    }

    private func saveBudget(_ b: AgentBudgetDto) async {
        await sendBudget(AgentBudgetUpdate(usd: usdUpdate(b), tokens: tokensUpdate(b)), ok: "Project budget saved.")
    }

    private func sendBudget(_ update: AgentBudgetUpdate, ok: String) async {
        guard let sel = model.selectedContainer, let actor = model.humanId else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await model.api.putProjectBudget(sel.baseUrl, sel.id, actor: actor, body: update)
            notice = ok
            actionError = nil
            await load()
        } catch {
            actionError = "Couldn't change the project budget — " + InboxErrorText.describe(error)
        }
    }

    // MARK: agent limit

    @ViewBuilder
    private var limitSection: some View {
        LSection("Agent limit") {
            if let limits {
                LCard {
                    VStack(alignment: .leading, spacing: LSpace.s) {
                        Stepper(value: $limitDraft, in: limits.minMaxAutoAgents...limits.maxMaxAutoAgents) {
                            Text("\(limitDraft) agents").ltype(.bodyEmph).foregroundStyle(p.text)
                        }
                        .disabled(!canLimit || busy)
                        .accessibilityLabel("Agent limit")
                        .accessibilityValue("\(limitDraft)")
                        Text(ProjectLimitsUx.agentLimitDesc(inUse: limits.autoAgentsInUse))
                            .ltype(.meta).foregroundStyle(p.text2)
                        if canLimit {
                            if limitDraft != limits.maxAutoAgents {
                                LButton("Save", kind: .primary, size: .small) { Task { await saveLimit() } }
                                    .disabled(busy)
                            }
                        } else if let reason = model.access.manageDenialReason(Grant.manageAgents, action: "Changing the agent limit") {
                            Text(reason).ltype(.micro).foregroundStyle(p.muted)
                        }
                    }
                }
            } else if let limitsError {
                Text("Couldn't load the agent limit — \(limitsError)").ltype(.meta).foregroundStyle(p.danger)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private func saveLimit() async {
        guard let sel = model.selectedContainer, let actor = model.humanId, let limits else { return }
        let n = ProjectLimitsUx.clampLimit(limitDraft, limits)
        busy = true
        defer { busy = false }
        do {
            self.limits = try await model.api.putContainerLimits(sel.baseUrl, sel.id, actor: actor, maxAutoAgents: n)
            notice = "Agent limit set to \(n)."
            actionError = nil
            await model.refresh()
        } catch {
            actionError = "Couldn't change the agent limit — " + InboxErrorText.describe(error)
        }
    }

    // MARK: load

    private func load() async {
        guard let sel = model.selectedContainer else { return }
        do {
            let b = try await model.api.projectBudgets(sel.baseUrl, sel.id)
            budgets = b
            budgetError = nil
            if let project = b.project {
                usdDraft = project.limits.usd.map { String(format: "%.2f", $0) } ?? ""
                tokensDraft = project.limits.tokens.map(String.init) ?? ""
            }
        } catch {
            budgetError = InboxErrorText.describe(error)
        }
        do {
            let l = try await model.api.containerLimits(sel.baseUrl, sel.id)
            limits = l
            limitDraft = l.maxAutoAgents
            limitsError = nil
        } catch {
            limitsError = InboxErrorText.describe(error)
        }
    }
}
