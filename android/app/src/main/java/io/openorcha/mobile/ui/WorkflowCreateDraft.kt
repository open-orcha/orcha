package io.openorcha.mobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.openorcha.mobile.data.StepOutcomeBody
import io.openorcha.mobile.data.StepRouteBody
import io.openorcha.mobile.data.WorkflowCreateBody
import io.openorcha.mobile.data.WorkflowDraftBody
import io.openorcha.mobile.data.WorkflowNewObjectiveBody
import io.openorcha.mobile.data.WorkflowNewTaskBody
import io.openorcha.mobile.data.WorkflowPreviewDto
import io.openorcha.mobile.data.WorkflowRepeatGroupBody
import io.openorcha.mobile.data.WorkflowsRepository

/**
 * The W10 create draft. Kept in memory by [WorkflowsController] per container and person
 * while the app stays open (as the web keeps its dialog draft); never persisted. Outcome
 * routes and the repeat group are edited here only — after Save they are read-only (W05).
 */
class WorkflowCreateDraft(val scope: String) {
    data class Objective(val title: String = "", val criteria: String = "")

    data class Route(val outcome: String, val destination: String = "next", val destinationTask: String? = null)

    data class Step(
        val clientKey: String,
        val title: String = "",
        val done: String = "",
        val description: String = "",
        val assigneeId: String? = null,
        val dependsOn: List<String> = emptyList(),
        val outcomes: List<String> = emptyList(),
        val routes: List<Route> = emptyList(),
    )

    data class Group(
        val name: String = "Review loop",
        val members: List<String> = emptyList(),
        val reviewTask: String? = null,
        val exitOutcome: String = "",
        val maxRounds: Int = 5,
        val escalationOwnerId: String? = null,
        val stallRule: String = "findings_and_artifact",
    )

    var page by mutableIntStateOf(0)
    var title by mutableStateOf("")
    var goal by mutableStateOf("")
    var mode by mutableStateOf("serial")
    val objectives = mutableStateListOf<Objective>()
    val steps = mutableStateListOf(Step(clientKey = "s1"))
    var group by mutableStateOf<Group?>(null)
    var preview by mutableStateOf<WorkflowPreviewDto?>(null)
    var previewedFor by mutableStateOf<WorkflowDraftBody?>(null)
    var previewError by mutableStateOf<String?>(null)
    private var nextKey = 2
    val idempotencyKey: String = WorkflowsRepository.newIdempotencyKey()

    fun newStep(): Step = Step(clientKey = "s${nextKey++}")

    /** Removing a step that others depend on is refused by the caller ("Change dependents first"). */
    fun dependents(clientKey: String): List<Step> = steps.filter { clientKey in it.dependsOn }

    fun draftBody(): WorkflowDraftBody = WorkflowDraftBody(
        title = title.trim(),
        goal = goal.trim(),
        executionMode = mode,
        objectives = objectives.filter { it.title.isNotBlank() }
            .map { WorkflowNewObjectiveBody(it.title.trim(), it.criteria.trim()) }.takeIf { it.isNotEmpty() },
        tasks = steps.map { s ->
            WorkflowNewTaskBody(
                clientKey = s.clientKey,
                title = s.title.trim(),
                description = s.description.trim().takeIf { it.isNotEmpty() },
                definitionOfDone = s.done.trim().takeIf { it.isNotEmpty() },
                assigneeId = s.assigneeId,
                dependsOn = s.dependsOn.takeIf { it.isNotEmpty() },
                outcomes = s.outcomes.map { StepOutcomeBody(it) }.takeIf { it.isNotEmpty() },
                routes = s.routes.filter { it.outcome in s.outcomes }
                    .map { StepRouteBody(it.outcome, it.destination, it.destinationTask.takeIf { _ -> it.destination == "step" }) }
                    .takeIf { it.isNotEmpty() },
            )
        },
        semanticsVersion = 2,
        repeatGroups = group?.let { g ->
            g.reviewTask?.let { review ->
                listOf(
                    WorkflowRepeatGroupBody(
                        name = g.name.trim(), memberTasks = g.members, reviewTask = review, exitOutcome = g.exitOutcome,
                        maxRounds = g.maxRounds, escalationOwnerId = g.escalationOwnerId, stallRule = g.stallRule,
                    ),
                )
            }
        },
    )

    fun createBody(previewDigest: String?): WorkflowCreateBody = draftBody().let { d ->
        WorkflowCreateBody(
            title = d.title, goal = d.goal, idempotencyKey = idempotencyKey, executionMode = d.executionMode,
            objectives = d.objectives, tasks = d.tasks, semanticsVersion = d.semanticsVersion,
            repeatGroups = d.repeatGroups, previewDigest = previewDigest,
        )
    }

    /** Step 1 and 2 are complete enough to review. */
    val goalReady: Boolean get() = title.isNotBlank() && goal.isNotBlank()
    val stepsReady: Boolean get() = steps.isNotEmpty() && steps.all { it.title.isNotBlank() }

    /** Save is enabled only after a clean review of exactly this draft. */
    val reviewedClean: Boolean
        get() = preview != null && previewedFor == draftBody() && preview?.blockers.isNullOrEmpty()
}
