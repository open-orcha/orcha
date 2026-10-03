import SwiftUI

/// Agent detail "Budget" section — web `AgentBudgetSection` parity: this month's spend
/// against the limit(s) as meters, the hard-stop banner when paused, and (owner /
/// manage_autonomy only) set/edit limits, grant a one-time override, revoke it.
/// Truthful-data rules: unmetered runs are "not metered", never $0; a pause never
/// stops an in-flight run.
struct AgentBudgetSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let alias: String

    @State private var budget: AgentBudgetDto?
    @State private var loadError: String?
    @State private var unsupported = false
    @State private var editing = false
    @State private var overriding = false
    @State private var busy = false

    private var canEdit: Bool {
        model.humanId != nil && model.access.canManage(Grant.manageAutonomy)
    }

    var body: some View {
        Group {
            if !unsupported {
                VStack(alignment: .leading, spacing: 10) {
                    SectionH(title: "Budget", count: budget.map { "\(AgentBudgetUx.period($0.period)) · resets \(AgentBudgetUx.reset($0.resetsAt)) (UTC)" })
                    if let budget {
                        if budget.paused { pausedBanner(budget) }
                        card(budget)
                    } else if let loadError {
                        Banner(kind: .warn, text: "Budget is temporarily unavailable — \(loadError)", action: "Retry") {
                            Task { await load() }
                        }
                    } else {
                        OrchaCard { Text("Loading budget…").font(p.uiFont(13)).foregroundStyle(p.muted) }
                    }
                }
            }
        }
        .task(id: agentId) {
            // Web cadence: on mount, then every 60 s while the screen is up.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .sheet(isPresented: $editing) {
            if let budget {
                BudgetEditSheet(alias: alias, budget: budget) { update in
                    await send(update, ok: "Budget saved")
                }
            }
        }
        .sheet(isPresented: $overriding) {
            if let budget {
                BudgetOverrideSheet(alias: alias, budget: budget) { note in
                    await send(AgentBudgetUpdate(override: "grant", note: note),
                               ok: "Override granted until \(AgentBudgetUx.reset(budget.resetsAt))")
                }
            }
        }
    }

    // MARK: pieces

    private func pausedBanner(_ b: AgentBudgetDto) -> some View {
        OrchaCard(borderColor: p.dangerLine) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "pause.circle.fill")
                    .foregroundStyle(p.danger)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(b.blockedBy == "project" ? "Paused for new runs — project budget reached" : "Paused for new runs")
                        .ltype(.bodyEmph).foregroundStyle(p.text)
                    if let reason = b.reason {
                        Text(reason).ltype(.meta).foregroundStyle(p.text2)
                    }
                }
            }
            if canEdit && b.blockedBy == "agent" {
                HStack(spacing: LSpace.s) {
                    LButton("Raise budget", size: .small) { editing = true }
                    LButton("Override this month", kind: .ghost, size: .small) { overriding = true }
                }
                .disabled(busy)
            } else if b.blockedBy == "project" {
                Text("The project budget is managed from Metrics in the web portal.")
                    .ltype(.micro).foregroundStyle(p.muted)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func card(_ b: AgentBudgetDto) -> some View {
        let u = b.usage
        return OrchaCard {
            HStack(spacing: LSpace.s) {
                if !b.paused, let label = AgentBudgetUx.healthLabel(b) {
                    LTag(label, tint: tint(for: b.state))
                }
                Spacer(minLength: 0)
                Label(canEdit ? "Human-only" : "Read-only", systemImage: "lock.shield")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
            }
            if !b.hasLimit {
                Text("No monthly budget").ltype(.bodyEmph).foregroundStyle(p.text)
                Text(noLimitCopy(b)).ltype(.meta).foregroundStyle(p.muted)
                if canEdit {
                    LButton("Set budget", icon: "plus", size: .small) { editing = true }
                        .disabled(busy)
                }
            } else {
                meterRow(
                    title: "Monthly spend",
                    detail: usdDetail(b),
                    ratio: (b.limits.usd != nil && !b.spendUnknown) ? b.usdRatio : nil,
                    showMeter: b.limits.usd != nil && !b.spendUnknown
                )
                meterRow(
                    title: "Token cap",
                    detail: b.limits.tokens.map { "\(AgentBudgetUx.tokens(u.tokens)) of \(AgentBudgetUx.tokens($0)) tokens · \(AgentBudgetUx.percent(b.tokenRatio))" }
                        ?? "No token cap · \(AgentBudgetUx.tokens(u.tokens)) tokens this month",
                    ratio: b.tokenRatio,
                    showMeter: b.limits.tokens != nil
                )
            }
            if u.unmeteredRuns > 0 {
                Text("\(u.unmeteredRuns) \(u.unmeteredRuns == 1 ? "run" : "runs") · \(AgentBudgetUx.tokens(u.unmeteredTokens)) tokens not metered — not counted as $0.")
                    .ltype(.micro).foregroundStyle(p.muted)
            }
            if b.override.active {
                Text("One-time override active until \(AgentBudgetUx.reset(b.resetsAt))" + (b.override.note.map { " · “\($0)”" } ?? ""))
                    .ltype(.micro).foregroundStyle(p.warn)
            }
            if u.inFlightRuns > 0 {
                Text("\(u.inFlightRuns) \(u.inFlightRuns == 1 ? "run" : "runs") in progress — not stopped by the budget")
                    .ltype(.micro).foregroundStyle(p.muted)
            }
            if canEdit && (b.override.active || b.hasLimit) {
                HStack(spacing: LSpace.s) {
                    Spacer(minLength: 0)
                    if b.override.active {
                        LButton("Revoke override", kind: .ghost, size: .small) {
                            Task { await send(AgentBudgetUpdate(override: "revoke"), ok: "Override revoked") }
                        }
                    }
                    if b.hasLimit {
                        LButton("Edit", icon: "slider.horizontal.3", kind: .ghost, size: .small) { editing = true }
                    }
                }
                .disabled(busy)
            }
        }
    }

    private func meterRow(title: String, detail: String, ratio: Double?, showMeter: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).ltype(.bodyEmph).foregroundStyle(p.text)
            Text(detail).ltype(.meta).monospacedDigit().foregroundStyle(p.text2)
            if showMeter {
                BudgetMeter(ratio: ratio)
                    .accessibilityLabel(title)
                    .accessibilityValue("\(AgentBudgetUx.percent(ratio)) of limit")
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func usdDetail(_ b: AgentBudgetDto) -> String {
        guard let limit = b.limits.usd else {
            return "No dollar limit · " + (b.spendUnknown ? "cost not metered" : "\(AgentBudgetUx.usd(b.usage.spendUsd)) this month")
        }
        if b.spendUnknown { return "Not metered · limit \(AgentBudgetUx.usd(limit))" }
        return "\(AgentBudgetUx.usd(b.usage.spendUsd)) of \(AgentBudgetUx.usd(limit)) · \(AgentBudgetUx.percent(b.usdRatio))"
    }

    private func noLimitCopy(_ b: AgentBudgetDto) -> String {
        let u = b.usage
        guard u.runs > 0 || u.inFlightRuns > 0 else { return "\(alias) can start runs without a spending limit. No runs this month." }
        let spend = b.spendUnknown ? "cost not metered" : AgentBudgetUx.usd(u.spendUsd)
        return "\(alias) can start runs without a spending limit. This month: \(spend) · \(AgentBudgetUx.tokens(u.tokens)) tokens."
    }

    private func tint(for state: String) -> Color? {
        switch state {
        case "ok": p.ok
        case "warning": p.warn
        case "exceeded": p.danger
        default: nil
        }
    }

    // MARK: data

    private func load() async {
        guard let base = model.selectedContainer?.baseUrl else { return }
        do {
            budget = try await model.api.agentBudget(base, agentId)
            loadError = nil
        } catch let e as OrchaApiError where e.status == 404 || e.status == 405 {
            unsupported = true   // an older server without budgets: hide the section
        } catch is CancellationError {
        } catch {
            if budget == nil { loadError = model.friendly(error) }
        }
    }

    private func send(_ update: AgentBudgetUpdate, ok: String) async -> Bool {
        guard let base = model.selectedContainer?.baseUrl, let actor = model.humanId else { return false }
        busy = true
        defer { busy = false }
        do {
            budget = try await model.api.updateAgentBudget(base, agentId, actor: actor, body: update)
            model.toast = ok
            return true
        } catch {
            model.toast = "Budget change failed — \(model.friendly(error))"
            return false
        }
    }
}

/// The spend meter: a thin track with an 80% tick, toned ok / warn / over.
struct BudgetMeter: View {
    @Environment(\.palette) private var p
    let ratio: Double?

    var body: some View {
        let fill = AgentBudgetUx.fill(ratio)
        let color: Color = switch AgentBudgetUx.tone(ratio) {
        case .ok: p.ok
        case .warn: p.warn
        case .over: p.danger
        }
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(p.surface3)
                Capsule().fill(color).frame(width: max(4, geo.size.width * fill))
                Rectangle().fill(p.border2).frame(width: 1).offset(x: geo.size.width * 0.8)
            }
        }
        .frame(height: 6)
    }
}

/// Set / edit the monthly limits. Blank = no limit.
private struct BudgetEditSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let alias: String
    let budget: AgentBudgetDto
    let onSave: (AgentBudgetUpdate) async -> Bool

    @State private var usd = ""
    @State private var tokens = ""
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                Form {
                    Section {
                        TextField("No limit", text: $usd)
                            .keyboardType(.decimalPad)
                            .accessibilityLabel("Monthly limit in US dollars")
                    } header: { Text("Monthly limit (USD)") }
                    Section {
                        TextField("No cap", text: $tokens)
                            .keyboardType(.numberPad)
                            .accessibilityLabel("Monthly token cap")
                    } header: { Text("Token cap") } footer: {
                        Text("At 80% you get a Needs-you notice. At 100% \(alias) is paused for new runs; a run already in progress is not stopped.")
                    }
                    if let error {
                        Text(error).foregroundStyle(p.danger)
                    }
                }
                .scrollContentBackground(.hidden)
                .background(p.bg)
            }
            .navigationTitle("Budget")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(saving)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            usd = budget.limits.usd.map { String(format: "%.2f", $0) } ?? ""
            tokens = budget.limits.tokens.map(String.init) ?? ""
        }
    }

    private func save() {
        let u = AgentBudgetUx.parseLimit(usd, integer: false)
        let t = AgentBudgetUx.parseLimit(tokens, integer: true)
        guard u != .invalid, t != .invalid else {
            error = "Enter a positive number, or leave blank for no limit."
            return
        }
        var update = AgentBudgetUpdate()
        if case let .value(v) = u { update.usd = .set(v) } else { update.usd = .clear }
        if case let .value(v) = t { update.tokens = .set(Int(v)) } else { update.tokens = .clear }
        saving = true
        Task {
            if await onSave(update) { dismiss() }
            saving = false
        }
    }
}

/// Grant a one-time override for the rest of the month, with an optional reason.
private struct BudgetOverrideSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let alias: String
    let budget: AgentBudgetDto
    let onGrant: (String?) async -> Bool

    @State private var note = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                Form {
                    Section {
                        TextField("Reason (optional)", text: $note, axis: .vertical)
                            .lineLimit(1...4)
                            .accessibilityLabel("Override reason")
                    } footer: {
                        Text("Lets \(alias) start new runs for the rest of \(AgentBudgetUx.period(budget.period)) despite the limit. It ends on \(AgentBudgetUx.reset(budget.resetsAt)) and is recorded in the audit log.")
                    }
                }
                .scrollContentBackground(.hidden)
                .background(p.bg)
            }
            .navigationTitle("Override this month")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Grant override") {
                        saving = true
                        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            if await onGrant(trimmed.isEmpty ? nil : String(trimmed.prefix(500))) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(saving)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
