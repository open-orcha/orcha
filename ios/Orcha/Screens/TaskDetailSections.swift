import SwiftUI

// Responsibility: Task description, definition of done, dependencies, thread, and run sections.

extension TaskDetailScreen {
    // MARK: description

    @ViewBuilder
    func descriptionSection(_ task: TaskDto) -> some View {
        if let description = task.description,
           !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            SectionH(title: "Description")
            OrchaCard {
                Text(description)
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.text2)
            }
        }
    }

    // MARK: definition of done

    @ViewBuilder
    func dodSection(_ task: TaskDto) -> some View {
        SectionH(title: "Definition of done")
        OrchaCard(borderColor: p.accentLine, container: p.surface2) {
            let lines = (task.definitionOfDone ?? "No definition of done was provided.")
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("✓")
                        .font(.system(size: 14.5, weight: .heavy))
                        .foregroundStyle(p.accent)
                    Text(line)
                        .font(.system(size: 14.5))
                        .foregroundStyle(p.text)
                }
            }
        }
    }

    // MARK: dependencies

    @ViewBuilder
    func dependenciesSection(_ task: TaskDto) -> some View {
        if !task.dependsOn.isEmpty {
            SectionH(title: "Depends on", count: "\(task.dependsOn.count)")
            ForEach(task.dependsOn, id: \.self) { depId in
                let dep = model.snapshot?.tasks.first { $0.id == depId }
                NavigationLink(value: WorkspaceRoute.task(depId)) {
                    OrchaCard {
                        HStack(spacing: 8) {
                            Text(dep?.status == "completed" ? "✓" : "🔒")
                                .font(.system(size: 14, weight: .heavy))
                                .foregroundStyle(dep?.status == "completed" ? p.ok : p.warn)
                            Text(dep?.title ?? depId)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(p.text)
                                .lineLimit(1)
                            Spacer()
                            if let dep {
                                StatusPill(status: dep.status, domain: .task)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: thread

    @ViewBuilder
    var threadSection: some View {
        SectionH(title: "Thread", count: "\(model.taskMessages.count)")
        NavigationLink(value: WorkspaceRoute.thread(taskId)) {
            OrchaCard {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Thread · \(model.taskMessages.count) messages")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(p.text)
                        if let last = model.taskMessages.last {
                            Text("\(last.authorAlias ?? (last.isHuman ? "you" : "agent")): \(last.body)")
                                .font(.system(size: 13))
                                .foregroundStyle(p.muted)
                                .lineLimit(1)
                        } else {
                            Text("No messages yet — say hi.")
                                .font(.system(size: 13))
                                .foregroundStyle(p.faint)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(p.faint)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: worker runs

    @ViewBuilder
    var runsSection: some View {
        HStack {
            SectionH(title: "Worker runs", count: "\(model.taskRuns.count)")
            if model.taskRuns.contains(where: { $0.status == "running" }) {
                StatusPill(status: "running", domain: .run)
            }
        }
        if model.taskRuns.isEmpty {
            OrchaCard {
                Text("No runs yet — appears when a worker wakes for this task.")
                    .foregroundStyle(p.muted)
            }
        }
        ForEach(allRuns ? model.taskRuns : Array(model.taskRuns.prefix(3))) { run in
            NavigationLink(value: WorkspaceRoute.run(run)) {
                RunRowCard(run: run)
            }
            .buttonStyle(.plain)
        }
        if !allRuns, model.taskRuns.count > 3 {
            Button("All runs (\(model.taskRuns.count))") { allRuns = true }
                .buttonStyle(.plain)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(p.accent)
        }
    }
}
