import SwiftUI

// Responsibility: Create-task advanced options, dependency selection, close guard, and submission.

extension CreateTaskSheet {
    // MARK: advanced

    var advancedSection: some View {
        DisclosureGroup(isExpanded: $advanced) {
            VStack(alignment: .leading, spacing: 12) {
                dependsOnCard
                parkCard
            }
            .padding(.top, 4)
        } label: {
            Text("ADVANCED")
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(p.muted)
        }
        .tint(p.accent)
    }

    var dependsOnCard: some View {
        OrchaCard {
            Text("Depends on").font(.system(size: 14, weight: .bold)).foregroundStyle(p.text)
            Text("This task won't become ready until these complete.")
                .font(.system(size: 13)).foregroundStyle(p.muted)
            ForEach(openTasks.prefix(12)) { task in
                Button {
                    if dependsOn.contains(task.id) {
                        dependsOn.remove(task.id)
                    } else {
                        dependsOn.insert(task.id)
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: dependsOn.contains(task.id) ? "checkmark.square.fill" : "square")
                            .foregroundStyle(dependsOn.contains(task.id) ? p.accent : p.faint)
                        Text(task.title)
                            .font(.system(size: 13))
                            .foregroundStyle(p.text)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        StatusPill(status: task.status, domain: .task)
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    var parkCard: some View {
        OrchaCard {
            Toggle(isOn: $parked) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Park it").font(.system(size: 14, weight: .bold)).foregroundStyle(p.text)
                    Text("The agent won't start yet — task is created pending.")
                        .font(.system(size: 13)).foregroundStyle(p.muted)
                }
            }
            .tint(p.accent)
        }
    }

    // MARK: helpers

    func helper(_ text: String, danger: Bool = false) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(danger ? p.danger : p.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    func requestClose() {
        if dirty { confirmDiscard = true } else { dismiss() }
    }

    func submit() {
        triedSubmit = true
        guard valid, !model.actionInFlight else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDod = dod.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            if await model.createTask(
                title: cleanTitle,
                description: cleanDescription.isEmpty ? nil : cleanDescription,
                dod: cleanDod,
                assignee: assignee,
                priority: MobileUx.priorityFor(band),
                dependsOn: Array(dependsOn),
                notReady: parked
            ) != nil {
                dismiss()
            }
        }
    }
}
