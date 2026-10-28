// Generated from FastAPI OpenAPI slices. DO NOT EDIT.
// Workflow source SHA-256: a3fae6acd911fee8d0b0a19103f47a4a168af856458c02e4ebe1b6aee632e5ca
// Evidence GET source SHA-256: f2a794298f992bd3ff3955fa5d6aefc30a97e373794a3c1e9d03c8f46796853e
// Regenerate with tools/generate-workflow-contract.mjs and both source files.

export type AcceptBasis = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "evidence": EvidenceBasis;
};

export type AcceptTask = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "evidence": EvidenceReference;
};

export type AcceptedEvidenceItem = {
  "item_id": string;
  "deliverable_id": string;
  "deliverable_version": number;
  "sha256": string;
  "kind"?: "result_summary" | "file_changes" | "log_excerpt" | "owner_result" | "outside_result" | "import_result" | null;
  "source"?: "worker" | "owner" | "outside" | "import" | "cancelled_attempt" | "released_attempt" | null;
  "snapshot_phase"?: "submission" | "terminal" | null;
  "complete"?: boolean | null;
  "note"?: string | null;
  "storage_state"?: "readable" | "missing" | "corrupt" | "missing_after_restore" | null;
  "captured_by"?: string | null;
  "captured_by_alias"?: string | null;
  "captured_by_kind"?: "human" | "ai" | null;
};

export type Activity = {
  "id": string;
  "task_id"?: string | null;
  "actor_alias": string;
  "actor_kind": string;
  "event": string;
  "revision": number;
  "detail": Record<string, unknown>;
  "created_at": string;
};

export type ActivityPage = {
  "activity": Array<Activity>;
  "next_before_at"?: string | null;
  "next_before_id"?: string | null;
};

export type AddEvidence = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "evidence": EvidenceBasis;
};

export type AvailableAction = {
  "action": string;
  "enabled": boolean;
  "reason"?: string | null;
  "permission"?: string | null;
  "holds"?: Array<"start" | "human"> | null;
};

export type Blocker = {
  "code": string;
  "message": string;
  "task_id"?: string | null;
};

export type Capability = {
  "workflow_read"?: boolean;
  "workflow_human_write"?: boolean;
  "reason"?: string | null;
};

export type CompletionCheck = {
  "can_finish": boolean;
  "blockers": Array<Blocker>;
};

export type DependencyEdit = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "depends_on": Array<string>;
};

export type DisplayState = {
  "label": string;
  "release_available"?: boolean;
  "release_available_at"?: string | null;
  "warning"?: string | null;
  "list_warning"?: boolean;
};

export type EvidenceBasis = {
  "narrative": string;
  "task_revisions"?: Record<string, number>;
  "evidence_sets"?: Array<EvidenceReference>;
};

export type EvidenceItem = {
  "item_id": string;
  "deliverable_id": string;
  "deliverable_version": number;
  "sha256": string;
};

export type EvidenceReference = {
  "evidence_set_id": string;
  "items": Array<EvidenceItem>;
};

export type Finding = {
  "id"?: string | null;
  "text": string;
  "severity"?: "blocker" | "major" | "minor" | "note" | null;
};

export type HTTPValidationError = {
  "detail"?: Array<ValidationError>;
};

export type Impact = {
  "kind": "start" | "release" | "cancellation";
  "revision": number;
  "graph_revision": number;
  "scope_revision": number;
  "task_revisions": Record<string, number>;
  "holds"?: Array<"start" | "human">;
  "tasks"?: Array<ImpactTask>;
  "counts_by_state"?: Record<string, number>;
  "accepted_retained"?: Array<string>;
  "workers_to_stop"?: Array<WorkerToStop>;
};

export type ImpactTask = {
  "task_id": string;
  "title": string;
  "work_revision": number;
  "selected": boolean;
  "current_status": string;
  "resulting_status": "refused" | "unchanged" | "blocked" | "waiting_for_prerequisites" | "ready" | "takes_turn_alone";
  "can_start": boolean;
  "refusal"?: Blocker | null;
  "blockers"?: Array<Blocker>;
};

export type ImportAcceptance = {
  "reviewed_result_digest": string;
  "evidence": EvidenceBasis;
};

export type ImportPreview = {
  "task_ids": Array<string>;
  "acceptances"?: Record<string, ImportAcceptance>;
};

export type ImportTaskImpact = {
  "id": string;
  "title": string;
  "status": string;
  "workflow_id"?: string | null;
  "eligible": boolean;
  "requires_acceptance": boolean;
  "result_digest"?: string | null;
  "description"?: string | null;
  "definition_of_done": string;
  "completed_at"?: string | null;
  "result_text"?: string | null;
  "result_by_agent_id"?: string | null;
  "preparation_state": "draft" | "prepared";
  "start_hold": boolean;
  "releasable"?: boolean;
  "human_hold_reason"?: string | null;
  "assignee_ids": Array<string>;
  "depends_on": Array<string>;
};

export type ImportTasks = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "task_ids": Array<string>;
  "acceptances"?: Record<string, ImportAcceptance>;
  "preview_digest": string;
  "release_task_ids"?: Array<string>;
};

export type IntegrationCapability = {
  "available"?: boolean;
  "reason"?: string | null;
};

export type MoveTasks = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "task_ids": Array<string>;
  "destination_workflow_id"?: string | null;
  "destination_revision"?: number | null;
};

export type Mutation = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
};

export type NewObjective = {
  "title": string;
  "criteria": string;
};

export type NewTask = {
  "client_key": string;
  "title": string;
  "description"?: string;
  "definition_of_done"?: string;
  "assignee_id"?: string | null;
  "priority"?: number;
  "depends_on"?: Array<string>;
  "outcomes"?: Array<StepOutcome>;
  "routes"?: Array<StepRoute>;
};

export type Objective = {
  "id": string;
  "title": string;
  "criteria": string;
  "revision": number;
  "accepted_revision": number | null;
  "evidence"?: EvidenceBasis | null;
  "available_actions"?: Array<AvailableAction>;
};

export type ObjectiveEdit = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "title": string;
  "criteria": string;
};

export type OutcomeChoice = {
  "outcome": string;
  "expected_work_revision": number;
};

export type OutcomeReport = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "outcome": string;
  "findings"?: Array<Finding>;
  "note"?: string;
};

export type OutsideResult = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "evidence": EvidenceBasis;
  "produced_by"?: string | null;
};

export type PrepareTask = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "title"?: string | null;
  "description"?: string | null;
  "definition_of_done"?: string | null;
  "assignee_id"?: string | null;
};

export type Preview = {
  "graph_revision": number;
  "preview_digest": string;
  "selected_task_ids": Array<string>;
  "required_task_ids": Array<string>;
  "blockers": Array<Blocker>;
  "task_impacts"?: Array<ImportTaskImpact>;
  "save_starts_work"?: false;
};

export type Progress = {
  "accepted": number;
  "total": number;
  "percent": number | null;
  "withdrawn": number;
  "objectives_accepted": number;
  "objectives_total": number;
};

export type Receipt = {
  "status": "saved" | "not_found";
  "operation": string;
  "idempotency_key": string;
  "result"?: WorkflowDetail | null;
};

export type ReleaseTasks = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "task_ids"?: Array<string>;
  "task_revisions"?: Record<string, number>;
  "holds"?: Array<"start" | "human">;
};

export type RepeatGroup = {
  "name": string;
  "member_tasks": Array<string>;
  "review_task": string;
  "exit_outcome": string;
  "max_rounds"?: number;
  "escalation_owner_id"?: string | null;
  "stall_rule"?: "findings_and_artifact" | "off";
};

export type RetryTask = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
  "assignee_id"?: string | null;
};

export type ReviewHistory = {
  "id": string;
  "loop_key": string;
  "round_number": number;
  "review_task_id": string;
  "correction_task_id"?: string | null;
  "outcome"?: string | null;
  "reviewed_artifact": EvidenceReference;
  "reviewed_task_id"?: string | null;
  "reviewed_work_revision"?: number | null;
  "review_work_revision"?: number | null;
  "resolved_by_owner"?: string | null;
  "resolved_reason"?: string | null;
};

export type ReviewRound = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "loop_key": string;
  "review_task_id": string;
  "reviewed_task_id": string;
  "reviewed_artifact": EvidenceReference;
  "outcome": "changes_requested" | "accepted" | "inconclusive";
  "correction"?: NewTask | null;
  "next_review"?: NewTask | null;
};

export type RoutingPreview = {
  "task_id": string;
  "outcome": string;
  "destination": "next" | "step" | "return" | "ask_owner" | "exit_group" | "stop";
  "destination_task_id"?: string | null;
  "group"?: string | null;
  "round"?: number | null;
  "rounds_remaining"?: number | null;
  "repeats"?: Array<string>;
  "kept"?: Array<string>;
  "stale"?: Array<string>;
  "not_selected"?: Array<string>;
  "blocked_by"?: "limit" | null;
  "message": string;
};

export type StepOutcome = {
  "name": string;
  "kind"?: "success" | "changes" | "failure" | "custom";
};

export type StepRoute = {
  "outcome": string;
  "destination": "next" | "step" | "return" | "ask_owner" | "exit_group" | "stop";
  "destination_task"?: string | null;
};

export type TaskAcceptance = {
  "id": string;
  "work_revision": number;
  "actor_id": string;
  "actor_kind": "human" | "ai";
  "actor_alias": string;
  "autonomy_at_acceptance": "off" | "on";
  "autonomy_revision": number;
  "acceptance_source": string;
  "evidence_set_id": string;
  "evidence_items": Array<AcceptedEvidenceItem>;
  "accepted_at": string;
};

export type TaskApprovalHistory = {
  "task_id": string;
  "approvals": Array<TaskApprovalRecord>;
};

export type TaskApprovalRecord = {
  "id": string;
  "phase": "plan" | "completion";
  "work_revision": number;
  "requirements_sha256": string;
  "submission_sha256": string;
  "actor_id": string;
  "actor_kind": "human" | "ai";
  "actor_alias": string;
  "autonomy_at_approval": "off" | "on";
  "autonomy_revision": number;
  "permission_source": string;
  "approved_at": string;
};

export type TaskAutonomyResult = {
  "task_id": string;
  "autonomy": "off" | "on";
  "autonomy_revision": number;
  "changed": boolean;
  "changed_at"?: string | null;
};

export type TaskAutonomyUpdate = {
  "autonomy": "off" | "on";
  "actor_agent_id"?: string | null;
};

export type TaskBatch = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "tasks": Array<NewTask>;
};

export type TaskMutation = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "expected_work_revision": number;
};

export type TransferOwner = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "new_owner_id": string;
};

export type ValidationError = {
  "loc": Array<string | number>;
  "msg": string;
  "type": string;
  "input"?: unknown;
  "ctx"?: Record<string, unknown>;
};

export type VisibilityCheck = {
  "revision": number;
  "title": string;
  "status": "active" | "paused" | "completed" | "cancelled";
  "hidden": boolean;
  "task_count": number;
  "live_turns": number;
  "can_hide": boolean;
  "can_restore": boolean;
  "blockers"?: Array<Blocker>;
};

export type WorkerToStop = {
  "task_id": string;
  "agent_id"?: string | null;
  "name"?: string | null;
};

export type WorkflowCreate = {
  "title": string;
  "goal": string;
  "execution_mode"?: "serial" | "parallel";
  "objectives"?: Array<NewObjective>;
  "tasks"?: Array<NewTask>;
  "existing_task_ids"?: Array<string>;
  "import_acceptances"?: Record<string, ImportAcceptance>;
  "semantics_version"?: 1 | 2 | null;
  "repeat_groups"?: Array<RepeatGroup>;
  "turn_allowance"?: number;
  "idempotency_key": string;
  "preview_digest"?: string | null;
};

export type WorkflowDetail = {
  "id": string;
  "container_id": string;
  "title": string;
  "created_at"?: string | null;
  "goal": string;
  "owner_human_id": string;
  "status": "active" | "paused" | "completed" | "cancelled";
  "execution_mode": "serial" | "parallel";
  "launch_enabled": boolean;
  "revision": number;
  "graph_revision": number;
  "scope_revision": number;
  "goal_revision": number;
  "goal_accepted_revision": number | null;
  "task_limit": number;
  "round_limit": number;
  "limit_reached": boolean;
  "capability": Capability;
  "available_actions": Array<AvailableAction>;
  "progress": Progress;
  "completion": CompletionCheck;
  "tasks": Array<WorkflowTask>;
  "objectives": Array<Objective>;
  "review_rounds"?: Array<ReviewHistory>;
  "activity"?: Array<Activity>;
  "activity_truncated"?: boolean;
  "hidden"?: boolean;
  "hidden_at"?: string | null;
  "hidden_by_human_id"?: string | null;
  "hidden_by_alias"?: string | null;
  "hidden_reason"?: string | null;
  "evidence_capability"?: IntegrationCapability;
  "created_task_ids"?: Record<string, string>;
};

export type WorkflowDraft = {
  "title": string;
  "goal": string;
  "execution_mode"?: "serial" | "parallel";
  "objectives"?: Array<NewObjective>;
  "tasks"?: Array<NewTask>;
  "existing_task_ids"?: Array<string>;
  "import_acceptances"?: Record<string, ImportAcceptance>;
  "semantics_version"?: 1 | 2 | null;
  "repeat_groups"?: Array<RepeatGroup>;
  "turn_allowance"?: number;
};

export type WorkflowImpact = {
  "id": string;
  "container_id": string;
  "title": string;
  "created_at"?: string | null;
  "goal": string;
  "owner_human_id": string;
  "status": "active" | "paused" | "completed" | "cancelled";
  "execution_mode": "serial" | "parallel";
  "launch_enabled": boolean;
  "revision": number;
  "graph_revision": number;
  "scope_revision": number;
  "goal_revision": number;
  "goal_accepted_revision": number | null;
  "task_limit": number;
  "round_limit": number;
  "limit_reached": boolean;
  "capability": Capability;
  "available_actions": Array<AvailableAction>;
  "progress": Progress;
  "completion": CompletionCheck;
  "tasks": Array<WorkflowTask>;
  "objectives": Array<Objective>;
  "review_rounds"?: Array<ReviewHistory>;
  "activity"?: Array<Activity>;
  "activity_truncated"?: boolean;
  "hidden"?: boolean;
  "hidden_at"?: string | null;
  "hidden_by_human_id"?: string | null;
  "hidden_by_alias"?: string | null;
  "hidden_reason"?: string | null;
  "evidence_capability"?: IntegrationCapability;
  "created_task_ids"?: Record<string, string>;
  "impact": Impact;
};

export type WorkflowList = {
  "workflows": Array<WorkflowDetail>;
  "capability": Capability;
  "next_cursor"?: string | null;
};

export type WorkflowPatch = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "title"?: string | null;
  "goal"?: string | null;
  "execution_mode"?: "serial" | "parallel" | null;
  "task_limit"?: number | null;
  "round_limit"?: number | null;
};

export type WorkflowTask = {
  "id": string;
  "title": string;
  "description"?: string | null;
  "definition_of_done": string;
  "status": string;
  "work_revision": number;
  "autonomy"?: "off" | "on";
  "autonomy_revision"?: number;
  "preparation_state": string | null;
  "start_hold": boolean;
  "human_hold_by": string | null;
  "human_hold_reason": string | null;
  "awaiting_owner_decision": string | null;
  "withdrawn_at": string | null;
  "withdrawn_by"?: string | null;
  "withdrawn_reason"?: string | null;
  "priority": number;
  "assignee_ids": Array<string>;
  "depends_on": Array<string>;
  "can_start": boolean;
  "blockers": Array<Blocker>;
  "display_state": DisplayState;
  "available_actions": Array<AvailableAction>;
  "outside_result_id"?: string | null;
  "outside_result_state"?: string | null;
  "current_evidence_set_id"?: string | null;
  "evidence_state"?: string | null;
  "acceptance"?: TaskAcceptance | null;
};

export type WorkflowTaskChoice = {
  "id": string;
  "title": string;
  "status": string;
  "is_root": boolean;
  "workflow_id"?: string | null;
};

export type WorkflowTaskSearch = {
  "results": Array<WorkflowTaskChoice>;
  "selected": Array<WorkflowTaskChoice>;
};

export type WorkflowTaskEvidence = {
  "task_id": string;
  "workflow_id": string;
  "current_evidence_set_id": string | null;
  "sets": Array<SavedEvidenceSet>;
  "next_before_revision"?: number | null;
};

export type SavedEvidenceSet = {
  "evidence_set_id": string;
  "task_id": string;
  "workflow_id": string;
  "workflow_execution_id": string;
  "run_id": string | null;
  "work_revision": number;
  "result_revision": number;
  "source_sequence": number;
  "generation": number;
  "state": "pending" | "saved" | "missing" | "superseded";
  "purpose": "acceptance" | "attempt_record";
  "missing_reason": string | null;
  "terminal_cause": string | null;
  "created_at": string;
  "frozen_at": string | null;
  "source_revision": string | null;
  "items": Array<SavedEvidenceItem>;
};

export type SavedEvidenceItem = {
  "item_id": string;
  "deliverable_id": string;
  "deliverable_version": number;
  "sha256": string;
  "kind": "result_summary" | "file_changes" | "log_excerpt" | "owner_result" | "outside_result" | "import_result";
  "source": "worker" | "owner" | "outside" | "import" | "cancelled_attempt" | "released_attempt";
  "snapshot_phase": "submission" | "terminal";
  "complete": boolean;
  "note": string | null;
  "storage_state": "readable" | "missing" | "corrupt" | "missing_after_restore";
  "captured_by"?: string | null;
  "captured_by_alias"?: string | null;
  "captured_by_kind"?: "human" | "ai" | null;
};

export type WorkflowModels = {
  AcceptBasis: AcceptBasis;
  AcceptTask: AcceptTask;
  AcceptedEvidenceItem: AcceptedEvidenceItem;
  Activity: Activity;
  ActivityPage: ActivityPage;
  AddEvidence: AddEvidence;
  AvailableAction: AvailableAction;
  Blocker: Blocker;
  Capability: Capability;
  CompletionCheck: CompletionCheck;
  DependencyEdit: DependencyEdit;
  DisplayState: DisplayState;
  EvidenceBasis: EvidenceBasis;
  EvidenceItem: EvidenceItem;
  EvidenceReference: EvidenceReference;
  Finding: Finding;
  HTTPValidationError: HTTPValidationError;
  Impact: Impact;
  ImpactTask: ImpactTask;
  ImportAcceptance: ImportAcceptance;
  ImportPreview: ImportPreview;
  ImportTaskImpact: ImportTaskImpact;
  ImportTasks: ImportTasks;
  IntegrationCapability: IntegrationCapability;
  MoveTasks: MoveTasks;
  Mutation: Mutation;
  NewObjective: NewObjective;
  NewTask: NewTask;
  Objective: Objective;
  ObjectiveEdit: ObjectiveEdit;
  OutcomeChoice: OutcomeChoice;
  OutcomeReport: OutcomeReport;
  OutsideResult: OutsideResult;
  PrepareTask: PrepareTask;
  Preview: Preview;
  Progress: Progress;
  Receipt: Receipt;
  ReleaseTasks: ReleaseTasks;
  RepeatGroup: RepeatGroup;
  RetryTask: RetryTask;
  ReviewHistory: ReviewHistory;
  ReviewRound: ReviewRound;
  RoutingPreview: RoutingPreview;
  StepOutcome: StepOutcome;
  StepRoute: StepRoute;
  TaskAcceptance: TaskAcceptance;
  TaskApprovalHistory: TaskApprovalHistory;
  TaskApprovalRecord: TaskApprovalRecord;
  TaskAutonomyResult: TaskAutonomyResult;
  TaskAutonomyUpdate: TaskAutonomyUpdate;
  TaskBatch: TaskBatch;
  TaskMutation: TaskMutation;
  TransferOwner: TransferOwner;
  ValidationError: ValidationError;
  VisibilityCheck: VisibilityCheck;
  WorkerToStop: WorkerToStop;
  WorkflowCreate: WorkflowCreate;
  WorkflowDetail: WorkflowDetail;
  WorkflowDraft: WorkflowDraft;
  WorkflowImpact: WorkflowImpact;
  WorkflowList: WorkflowList;
  WorkflowPatch: WorkflowPatch;
  WorkflowTask: WorkflowTask;
  WorkflowTaskChoice: WorkflowTaskChoice;
  WorkflowTaskSearch: WorkflowTaskSearch;
  WorkflowTaskEvidence: WorkflowTaskEvidence;
  SavedEvidenceSet: SavedEvidenceSet;
  SavedEvidenceItem: SavedEvidenceItem;
};
export const workflowSchemas = {
  "AcceptBasis": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "evidence": {
        "$ref": "#/components/schemas/EvidenceBasis"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "evidence"
    ]
  },
  "AcceptTask": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "evidence": {
        "$ref": "#/components/schemas/EvidenceReference"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision",
      "evidence"
    ]
  },
  "AcceptedEvidenceItem": {
    "properties": {
      "item_id": {
        "type": "string"
      },
      "deliverable_id": {
        "type": "string"
      },
      "deliverable_version": {
        "type": "integer",
        "minimum": 1
      },
      "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "kind": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "result_summary",
              "file_changes",
              "log_excerpt",
              "owner_result",
              "outside_result",
              "import_result"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "source": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "worker",
              "owner",
              "outside",
              "import",
              "cancelled_attempt",
              "released_attempt"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "snapshot_phase": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "submission",
              "terminal"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "complete": {
        "anyOf": [
          {
            "type": "boolean"
          },
          {
            "type": "null"
          }
        ]
      },
      "note": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "storage_state": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "readable",
              "missing",
              "corrupt",
              "missing_after_restore"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "captured_by": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "captured_by_alias": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "captured_by_kind": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "human",
              "ai"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "item_id",
      "deliverable_id",
      "deliverable_version",
      "sha256"
    ]
  },
  "Activity": {
    "properties": {
      "id": {
        "type": "string"
      },
      "task_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "actor_alias": {
        "type": "string"
      },
      "actor_kind": {
        "type": "string"
      },
      "event": {
        "type": "string"
      },
      "revision": {
        "type": "integer"
      },
      "detail": {
        "additionalProperties": true,
        "type": "object"
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "type": "object",
    "required": [
      "id",
      "actor_alias",
      "actor_kind",
      "event",
      "revision",
      "detail",
      "created_at"
    ]
  },
  "ActivityPage": {
    "properties": {
      "activity": {
        "items": {
          "$ref": "#/components/schemas/Activity"
        },
        "type": "array"
      },
      "next_before_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "next_before_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "activity"
    ]
  },
  "AddEvidence": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "evidence": {
        "$ref": "#/components/schemas/EvidenceBasis"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision",
      "evidence"
    ]
  },
  "AvailableAction": {
    "properties": {
      "action": {
        "type": "string"
      },
      "enabled": {
        "type": "boolean"
      },
      "reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "permission": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "holds": {
        "anyOf": [
          {
            "items": {
              "type": "string",
              "enum": [
                "start",
                "human"
              ]
            },
            "type": "array"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "action",
      "enabled"
    ]
  },
  "Blocker": {
    "properties": {
      "code": {
        "type": "string"
      },
      "message": {
        "type": "string"
      },
      "task_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "code",
      "message"
    ]
  },
  "Capability": {
    "properties": {
      "workflow_read": {
        "type": "boolean"
      },
      "workflow_human_write": {
        "type": "boolean"
      },
      "reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object"
  },
  "CompletionCheck": {
    "properties": {
      "can_finish": {
        "type": "boolean"
      },
      "blockers": {
        "items": {
          "$ref": "#/components/schemas/Blocker"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "can_finish",
      "blockers"
    ]
  },
  "DependencyEdit": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "depends_on": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 3
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision",
      "depends_on"
    ]
  },
  "DisplayState": {
    "properties": {
      "label": {
        "type": "string"
      },
      "release_available": {
        "type": "boolean"
      },
      "release_available_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "warning": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "list_warning": {
        "type": "boolean"
      }
    },
    "type": "object",
    "required": [
      "label"
    ]
  },
  "EvidenceBasis": {
    "properties": {
      "narrative": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "task_revisions": {
        "additionalProperties": {
          "type": "integer"
        },
        "type": "object"
      },
      "evidence_sets": {
        "items": {
          "$ref": "#/components/schemas/EvidenceReference"
        },
        "type": "array"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "narrative"
    ]
  },
  "EvidenceItem": {
    "properties": {
      "item_id": {
        "type": "string"
      },
      "deliverable_id": {
        "type": "string"
      },
      "deliverable_version": {
        "type": "integer",
        "minimum": 1
      },
      "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "item_id",
      "deliverable_id",
      "deliverable_version",
      "sha256"
    ]
  },
  "EvidenceReference": {
    "properties": {
      "evidence_set_id": {
        "type": "string"
      },
      "items": {
        "items": {
          "$ref": "#/components/schemas/EvidenceItem"
        },
        "type": "array",
        "minItems": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "evidence_set_id",
      "items"
    ]
  },
  "Finding": {
    "properties": {
      "id": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 80
          },
          {
            "type": "null"
          }
        ]
      },
      "text": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "severity": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "blocker",
              "major",
              "minor",
              "note"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "text"
    ]
  },
  "HTTPValidationError": {
    "properties": {
      "detail": {
        "items": {
          "$ref": "#/components/schemas/ValidationError"
        },
        "type": "array"
      }
    },
    "type": "object"
  },
  "Impact": {
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "start",
          "release",
          "cancellation"
        ]
      },
      "revision": {
        "type": "integer"
      },
      "graph_revision": {
        "type": "integer"
      },
      "scope_revision": {
        "type": "integer"
      },
      "task_revisions": {
        "additionalProperties": {
          "type": "integer"
        },
        "type": "object"
      },
      "holds": {
        "items": {
          "type": "string",
          "enum": [
            "start",
            "human"
          ]
        },
        "type": "array"
      },
      "tasks": {
        "items": {
          "$ref": "#/components/schemas/ImpactTask"
        },
        "type": "array"
      },
      "counts_by_state": {
        "additionalProperties": {
          "type": "integer"
        },
        "type": "object"
      },
      "accepted_retained": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "workers_to_stop": {
        "items": {
          "$ref": "#/components/schemas/WorkerToStop"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "kind",
      "revision",
      "graph_revision",
      "scope_revision",
      "task_revisions"
    ]
  },
  "ImpactTask": {
    "properties": {
      "task_id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "work_revision": {
        "type": "integer"
      },
      "selected": {
        "type": "boolean"
      },
      "current_status": {
        "type": "string"
      },
      "resulting_status": {
        "type": "string",
        "enum": [
          "refused",
          "unchanged",
          "blocked",
          "waiting_for_prerequisites",
          "ready",
          "takes_turn_alone"
        ]
      },
      "can_start": {
        "type": "boolean"
      },
      "refusal": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/Blocker"
          },
          {
            "type": "null"
          }
        ]
      },
      "blockers": {
        "items": {
          "$ref": "#/components/schemas/Blocker"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "task_id",
      "title",
      "work_revision",
      "selected",
      "current_status",
      "resulting_status",
      "can_start"
    ]
  },
  "ImportAcceptance": {
    "properties": {
      "reviewed_result_digest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "evidence": {
        "$ref": "#/components/schemas/EvidenceBasis"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "reviewed_result_digest",
      "evidence"
    ]
  },
  "ImportPreview": {
    "properties": {
      "task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 200,
        "minItems": 1
      },
      "acceptances": {
        "additionalProperties": {
          "$ref": "#/components/schemas/ImportAcceptance"
        },
        "type": "object"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "task_ids"
    ]
  },
  "ImportTaskImpact": {
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "workflow_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "eligible": {
        "type": "boolean"
      },
      "requires_acceptance": {
        "type": "boolean"
      },
      "result_digest": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "description": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "definition_of_done": {
        "type": "string"
      },
      "completed_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "result_text": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "result_by_agent_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "preparation_state": {
        "type": "string",
        "enum": [
          "draft",
          "prepared"
        ]
      },
      "start_hold": {
        "type": "boolean"
      },
      "releasable": {
        "type": "boolean"
      },
      "human_hold_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "assignee_ids": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "depends_on": {
        "items": {
          "type": "string"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "id",
      "title",
      "status",
      "eligible",
      "requires_acceptance",
      "definition_of_done",
      "preparation_state",
      "start_hold",
      "assignee_ids",
      "depends_on"
    ]
  },
  "ImportTasks": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 200,
        "minItems": 1
      },
      "acceptances": {
        "additionalProperties": {
          "$ref": "#/components/schemas/ImportAcceptance"
        },
        "type": "object"
      },
      "preview_digest": {
        "type": "string"
      },
      "release_task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 200
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "task_ids",
      "preview_digest"
    ]
  },
  "IntegrationCapability": {
    "properties": {
      "available": {
        "type": "boolean"
      },
      "reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object"
  },
  "MoveTasks": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "minItems": 1
      },
      "destination_workflow_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "destination_revision": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 1
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "task_ids"
    ]
  },
  "Mutation": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key"
    ]
  },
  "NewObjective": {
    "properties": {
      "title": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "criteria": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "title",
      "criteria"
    ]
  },
  "NewTask": {
    "properties": {
      "client_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "title": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "description": {
        "type": "string",
        "maxLength": 4000
      },
      "definition_of_done": {
        "type": "string",
        "maxLength": 4000
      },
      "assignee_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "priority": {
        "type": "integer"
      },
      "depends_on": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 3
      },
      "outcomes": {
        "items": {
          "$ref": "#/components/schemas/StepOutcome"
        },
        "type": "array",
        "maxItems": 8
      },
      "routes": {
        "items": {
          "$ref": "#/components/schemas/StepRoute"
        },
        "type": "array",
        "maxItems": 8
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "client_key",
      "title"
    ]
  },
  "Objective": {
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "criteria": {
        "type": "string"
      },
      "revision": {
        "type": "integer"
      },
      "accepted_revision": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "evidence": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/EvidenceBasis"
          },
          {
            "type": "null"
          }
        ]
      },
      "available_actions": {
        "items": {
          "$ref": "#/components/schemas/AvailableAction"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "id",
      "title",
      "criteria",
      "revision",
      "accepted_revision"
    ]
  },
  "ObjectiveEdit": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "title": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "criteria": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "title",
      "criteria"
    ]
  },
  "OutcomeChoice": {
    "properties": {
      "outcome": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "outcome",
      "expected_work_revision"
    ]
  },
  "OutcomeReport": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "outcome": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "findings": {
        "items": {
          "$ref": "#/components/schemas/Finding"
        },
        "type": "array",
        "maxItems": 50
      },
      "note": {
        "type": "string",
        "maxLength": 4000
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision",
      "outcome"
    ]
  },
  "OutsideResult": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "evidence": {
        "$ref": "#/components/schemas/EvidenceBasis"
      },
      "produced_by": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 200
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision",
      "evidence"
    ]
  },
  "PrepareTask": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "title": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 200,
            "minLength": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "description": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 4000
          },
          {
            "type": "null"
          }
        ]
      },
      "definition_of_done": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 4000,
            "minLength": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "assignee_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision"
    ]
  },
  "Preview": {
    "properties": {
      "graph_revision": {
        "type": "integer"
      },
      "preview_digest": {
        "type": "string"
      },
      "selected_task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "required_task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "blockers": {
        "items": {
          "$ref": "#/components/schemas/Blocker"
        },
        "type": "array"
      },
      "task_impacts": {
        "items": {
          "$ref": "#/components/schemas/ImportTaskImpact"
        },
        "type": "array"
      },
      "save_starts_work": {
        "type": "boolean",
        "const": false
      }
    },
    "type": "object",
    "required": [
      "graph_revision",
      "preview_digest",
      "selected_task_ids",
      "required_task_ids",
      "blockers"
    ]
  },
  "Progress": {
    "properties": {
      "accepted": {
        "type": "integer"
      },
      "total": {
        "type": "integer"
      },
      "percent": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "withdrawn": {
        "type": "integer"
      },
      "objectives_accepted": {
        "type": "integer"
      },
      "objectives_total": {
        "type": "integer"
      }
    },
    "type": "object",
    "required": [
      "accepted",
      "total",
      "percent",
      "withdrawn",
      "objectives_accepted",
      "objectives_total"
    ]
  },
  "Receipt": {
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "saved",
          "not_found"
        ]
      },
      "operation": {
        "type": "string"
      },
      "idempotency_key": {
        "type": "string"
      },
      "result": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/WorkflowDetail"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "status",
      "operation",
      "idempotency_key"
    ]
  },
  "ReleaseTasks": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 200
      },
      "task_revisions": {
        "additionalProperties": {
          "type": "integer"
        },
        "type": "object"
      },
      "holds": {
        "items": {
          "type": "string",
          "enum": [
            "start",
            "human"
          ]
        },
        "type": "array",
        "maxItems": 2,
        "minItems": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key"
    ]
  },
  "RepeatGroup": {
    "properties": {
      "name": {
        "type": "string",
        "maxLength": 80,
        "minLength": 1
      },
      "member_tasks": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 10,
        "minItems": 2
      },
      "review_task": {
        "type": "string"
      },
      "exit_outcome": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "max_rounds": {
        "type": "integer",
        "maximum": 20,
        "minimum": 1
      },
      "escalation_owner_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "stall_rule": {
        "type": "string",
        "enum": [
          "findings_and_artifact",
          "off"
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "name",
      "member_tasks",
      "review_task",
      "exit_outcome"
    ]
  },
  "RetryTask": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "assignee_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision"
    ]
  },
  "ReviewHistory": {
    "properties": {
      "id": {
        "type": "string"
      },
      "loop_key": {
        "type": "string"
      },
      "round_number": {
        "type": "integer"
      },
      "review_task_id": {
        "type": "string"
      },
      "correction_task_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "outcome": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "reviewed_artifact": {
        "$ref": "#/components/schemas/EvidenceReference"
      },
      "reviewed_task_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "reviewed_work_revision": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "review_work_revision": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "resolved_by_owner": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "resolved_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "id",
      "loop_key",
      "round_number",
      "review_task_id",
      "reviewed_artifact"
    ]
  },
  "ReviewRound": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "loop_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "review_task_id": {
        "type": "string"
      },
      "reviewed_task_id": {
        "type": "string"
      },
      "reviewed_artifact": {
        "$ref": "#/components/schemas/EvidenceReference"
      },
      "outcome": {
        "type": "string",
        "enum": [
          "changes_requested",
          "accepted",
          "inconclusive"
        ]
      },
      "correction": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/NewTask"
          },
          {
            "type": "null"
          }
        ]
      },
      "next_review": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/NewTask"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "loop_key",
      "review_task_id",
      "reviewed_task_id",
      "reviewed_artifact",
      "outcome"
    ]
  },
  "RoutingPreview": {
    "properties": {
      "task_id": {
        "type": "string"
      },
      "outcome": {
        "type": "string"
      },
      "destination": {
        "type": "string",
        "enum": [
          "next",
          "step",
          "return",
          "ask_owner",
          "exit_group",
          "stop"
        ]
      },
      "destination_task_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "group": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "round": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "rounds_remaining": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "repeats": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "kept": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "stale": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "not_selected": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "blocked_by": {
        "anyOf": [
          {
            "type": "string",
            "const": "limit"
          },
          {
            "type": "null"
          }
        ]
      },
      "message": {
        "type": "string"
      }
    },
    "type": "object",
    "required": [
      "task_id",
      "outcome",
      "destination",
      "message"
    ]
  },
  "StepOutcome": {
    "properties": {
      "name": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "kind": {
        "type": "string",
        "enum": [
          "success",
          "changes",
          "failure",
          "custom"
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "name"
    ]
  },
  "StepRoute": {
    "properties": {
      "outcome": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "destination": {
        "type": "string",
        "enum": [
          "next",
          "step",
          "return",
          "ask_owner",
          "exit_group",
          "stop"
        ]
      },
      "destination_task": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "outcome",
      "destination"
    ]
  },
  "TaskAcceptance": {
    "properties": {
      "id": {
        "type": "string"
      },
      "work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "actor_id": {
        "type": "string"
      },
      "actor_kind": {
        "type": "string",
        "enum": [
          "human",
          "ai"
        ]
      },
      "actor_alias": {
        "type": "string"
      },
      "autonomy_at_acceptance": {
        "type": "string",
        "enum": [
          "off",
          "on"
        ]
      },
      "autonomy_revision": {
        "type": "integer",
        "minimum": 1
      },
      "acceptance_source": {
        "type": "string"
      },
      "evidence_set_id": {
        "type": "string"
      },
      "evidence_items": {
        "items": {
          "$ref": "#/components/schemas/AcceptedEvidenceItem"
        },
        "type": "array",
        "minItems": 1
      },
      "accepted_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "type": "object",
    "required": [
      "id",
      "work_revision",
      "actor_id",
      "actor_kind",
      "actor_alias",
      "autonomy_at_acceptance",
      "autonomy_revision",
      "acceptance_source",
      "evidence_set_id",
      "evidence_items",
      "accepted_at"
    ]
  },
  "TaskApprovalHistory": {
    "properties": {
      "task_id": {
        "type": "string"
      },
      "approvals": {
        "items": {
          "$ref": "#/components/schemas/TaskApprovalRecord"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "task_id",
      "approvals"
    ]
  },
  "TaskApprovalRecord": {
    "properties": {
      "id": {
        "type": "string"
      },
      "phase": {
        "type": "string",
        "enum": [
          "plan",
          "completion"
        ]
      },
      "work_revision": {
        "type": "integer",
        "minimum": 1
      },
      "requirements_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "submission_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "actor_id": {
        "type": "string"
      },
      "actor_kind": {
        "type": "string",
        "enum": [
          "human",
          "ai"
        ]
      },
      "actor_alias": {
        "type": "string"
      },
      "autonomy_at_approval": {
        "type": "string",
        "enum": [
          "off",
          "on"
        ]
      },
      "autonomy_revision": {
        "type": "integer",
        "minimum": 1
      },
      "permission_source": {
        "type": "string"
      },
      "approved_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "type": "object",
    "required": [
      "id",
      "phase",
      "work_revision",
      "requirements_sha256",
      "submission_sha256",
      "actor_id",
      "actor_kind",
      "actor_alias",
      "autonomy_at_approval",
      "autonomy_revision",
      "permission_source",
      "approved_at"
    ]
  },
  "TaskAutonomyResult": {
    "properties": {
      "task_id": {
        "type": "string"
      },
      "autonomy": {
        "type": "string",
        "enum": [
          "off",
          "on"
        ]
      },
      "autonomy_revision": {
        "type": "integer",
        "minimum": 1
      },
      "changed": {
        "type": "boolean"
      },
      "changed_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "task_id",
      "autonomy",
      "autonomy_revision",
      "changed"
    ]
  },
  "TaskAutonomyUpdate": {
    "properties": {
      "autonomy": {
        "type": "string",
        "enum": [
          "off",
          "on"
        ]
      },
      "actor_agent_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "autonomy"
    ]
  },
  "TaskBatch": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "tasks": {
        "items": {
          "$ref": "#/components/schemas/NewTask"
        },
        "type": "array",
        "maxItems": 200,
        "minItems": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "tasks"
    ]
  },
  "TaskMutation": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "expected_work_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "expected_work_revision"
    ]
  },
  "TransferOwner": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "new_owner_id": {
        "type": "string"
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key",
      "new_owner_id"
    ]
  },
  "ValidationError": {
    "properties": {
      "loc": {
        "items": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "integer"
            }
          ]
        },
        "type": "array"
      },
      "msg": {
        "type": "string"
      },
      "type": {
        "type": "string"
      },
      "input": {},
      "ctx": {
        "type": "object"
      }
    },
    "type": "object",
    "required": [
      "loc",
      "msg",
      "type"
    ]
  },
  "VisibilityCheck": {
    "properties": {
      "revision": {
        "type": "integer"
      },
      "title": {
        "type": "string"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "paused",
          "completed",
          "cancelled"
        ]
      },
      "hidden": {
        "type": "boolean"
      },
      "task_count": {
        "type": "integer"
      },
      "live_turns": {
        "type": "integer"
      },
      "can_hide": {
        "type": "boolean"
      },
      "can_restore": {
        "type": "boolean"
      },
      "blockers": {
        "items": {
          "$ref": "#/components/schemas/Blocker"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "revision",
      "title",
      "status",
      "hidden",
      "task_count",
      "live_turns",
      "can_hide",
      "can_restore"
    ]
  },
  "WorkerToStop": {
    "properties": {
      "task_id": {
        "type": "string"
      },
      "agent_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "name": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "task_id"
    ]
  },
  "WorkflowCreate": {
    "properties": {
      "title": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "goal": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "execution_mode": {
        "type": "string",
        "enum": [
          "serial",
          "parallel"
        ]
      },
      "objectives": {
        "items": {
          "$ref": "#/components/schemas/NewObjective"
        },
        "type": "array",
        "maxItems": 50
      },
      "tasks": {
        "items": {
          "$ref": "#/components/schemas/NewTask"
        },
        "type": "array",
        "maxItems": 200
      },
      "existing_task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 200
      },
      "import_acceptances": {
        "additionalProperties": {
          "$ref": "#/components/schemas/ImportAcceptance"
        },
        "type": "object"
      },
      "semantics_version": {
        "anyOf": [
          {
            "type": "integer",
            "enum": [
              1,
              2
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "repeat_groups": {
        "items": {
          "$ref": "#/components/schemas/RepeatGroup"
        },
        "type": "array",
        "maxItems": 5
      },
      "turn_allowance": {
        "type": "integer",
        "maximum": 1000,
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "preview_digest": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "title",
      "goal",
      "idempotency_key"
    ]
  },
  "WorkflowDetail": {
    "properties": {
      "id": {
        "type": "string"
      },
      "container_id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "created_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "goal": {
        "type": "string"
      },
      "owner_human_id": {
        "type": "string"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "paused",
          "completed",
          "cancelled"
        ]
      },
      "execution_mode": {
        "type": "string",
        "enum": [
          "serial",
          "parallel"
        ]
      },
      "launch_enabled": {
        "type": "boolean"
      },
      "revision": {
        "type": "integer"
      },
      "graph_revision": {
        "type": "integer"
      },
      "scope_revision": {
        "type": "integer"
      },
      "goal_revision": {
        "type": "integer"
      },
      "goal_accepted_revision": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "task_limit": {
        "type": "integer"
      },
      "round_limit": {
        "type": "integer"
      },
      "limit_reached": {
        "type": "boolean"
      },
      "capability": {
        "$ref": "#/components/schemas/Capability"
      },
      "available_actions": {
        "items": {
          "$ref": "#/components/schemas/AvailableAction"
        },
        "type": "array"
      },
      "progress": {
        "$ref": "#/components/schemas/Progress"
      },
      "completion": {
        "$ref": "#/components/schemas/CompletionCheck"
      },
      "tasks": {
        "items": {
          "$ref": "#/components/schemas/WorkflowTask"
        },
        "type": "array"
      },
      "objectives": {
        "items": {
          "$ref": "#/components/schemas/Objective"
        },
        "type": "array"
      },
      "review_rounds": {
        "items": {
          "$ref": "#/components/schemas/ReviewHistory"
        },
        "type": "array"
      },
      "activity": {
        "items": {
          "$ref": "#/components/schemas/Activity"
        },
        "type": "array"
      },
      "activity_truncated": {
        "type": "boolean"
      },
      "hidden": {
        "type": "boolean"
      },
      "hidden_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "hidden_by_human_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "hidden_by_alias": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "hidden_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "evidence_capability": {
        "$ref": "#/components/schemas/IntegrationCapability"
      },
      "created_task_ids": {
        "additionalProperties": {
          "type": "string"
        },
        "type": "object"
      }
    },
    "type": "object",
    "required": [
      "id",
      "container_id",
      "title",
      "goal",
      "owner_human_id",
      "status",
      "execution_mode",
      "launch_enabled",
      "revision",
      "graph_revision",
      "scope_revision",
      "goal_revision",
      "goal_accepted_revision",
      "task_limit",
      "round_limit",
      "limit_reached",
      "capability",
      "available_actions",
      "progress",
      "completion",
      "tasks",
      "objectives"
    ]
  },
  "WorkflowDraft": {
    "properties": {
      "title": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "goal": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "execution_mode": {
        "type": "string",
        "enum": [
          "serial",
          "parallel"
        ]
      },
      "objectives": {
        "items": {
          "$ref": "#/components/schemas/NewObjective"
        },
        "type": "array",
        "maxItems": 50
      },
      "tasks": {
        "items": {
          "$ref": "#/components/schemas/NewTask"
        },
        "type": "array",
        "maxItems": 200
      },
      "existing_task_ids": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "maxItems": 200
      },
      "import_acceptances": {
        "additionalProperties": {
          "$ref": "#/components/schemas/ImportAcceptance"
        },
        "type": "object"
      },
      "semantics_version": {
        "anyOf": [
          {
            "type": "integer",
            "enum": [
              1,
              2
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "repeat_groups": {
        "items": {
          "$ref": "#/components/schemas/RepeatGroup"
        },
        "type": "array",
        "maxItems": 5
      },
      "turn_allowance": {
        "type": "integer",
        "maximum": 1000,
        "minimum": 1
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "title",
      "goal"
    ]
  },
  "WorkflowImpact": {
    "properties": {
      "id": {
        "type": "string"
      },
      "container_id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "created_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "goal": {
        "type": "string"
      },
      "owner_human_id": {
        "type": "string"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "paused",
          "completed",
          "cancelled"
        ]
      },
      "execution_mode": {
        "type": "string",
        "enum": [
          "serial",
          "parallel"
        ]
      },
      "launch_enabled": {
        "type": "boolean"
      },
      "revision": {
        "type": "integer"
      },
      "graph_revision": {
        "type": "integer"
      },
      "scope_revision": {
        "type": "integer"
      },
      "goal_revision": {
        "type": "integer"
      },
      "goal_accepted_revision": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "task_limit": {
        "type": "integer"
      },
      "round_limit": {
        "type": "integer"
      },
      "limit_reached": {
        "type": "boolean"
      },
      "capability": {
        "$ref": "#/components/schemas/Capability"
      },
      "available_actions": {
        "items": {
          "$ref": "#/components/schemas/AvailableAction"
        },
        "type": "array"
      },
      "progress": {
        "$ref": "#/components/schemas/Progress"
      },
      "completion": {
        "$ref": "#/components/schemas/CompletionCheck"
      },
      "tasks": {
        "items": {
          "$ref": "#/components/schemas/WorkflowTask"
        },
        "type": "array"
      },
      "objectives": {
        "items": {
          "$ref": "#/components/schemas/Objective"
        },
        "type": "array"
      },
      "review_rounds": {
        "items": {
          "$ref": "#/components/schemas/ReviewHistory"
        },
        "type": "array"
      },
      "activity": {
        "items": {
          "$ref": "#/components/schemas/Activity"
        },
        "type": "array"
      },
      "activity_truncated": {
        "type": "boolean"
      },
      "hidden": {
        "type": "boolean"
      },
      "hidden_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "hidden_by_human_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "hidden_by_alias": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "hidden_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "evidence_capability": {
        "$ref": "#/components/schemas/IntegrationCapability"
      },
      "created_task_ids": {
        "additionalProperties": {
          "type": "string"
        },
        "type": "object"
      },
      "impact": {
        "$ref": "#/components/schemas/Impact"
      }
    },
    "type": "object",
    "required": [
      "id",
      "container_id",
      "title",
      "goal",
      "owner_human_id",
      "status",
      "execution_mode",
      "launch_enabled",
      "revision",
      "graph_revision",
      "scope_revision",
      "goal_revision",
      "goal_accepted_revision",
      "task_limit",
      "round_limit",
      "limit_reached",
      "capability",
      "available_actions",
      "progress",
      "completion",
      "tasks",
      "objectives",
      "impact"
    ]
  },
  "WorkflowList": {
    "properties": {
      "workflows": {
        "items": {
          "$ref": "#/components/schemas/WorkflowDetail"
        },
        "type": "array"
      },
      "capability": {
        "$ref": "#/components/schemas/Capability"
      },
      "next_cursor": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "workflows",
      "capability"
    ]
  },
  "WorkflowPatch": {
    "properties": {
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "reason": {
        "type": "string",
        "maxLength": 4000
      },
      "title": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 200,
            "minLength": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "goal": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 4000,
            "minLength": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "execution_mode": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "serial",
              "parallel"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "task_limit": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "round_limit": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 1
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "expected_revision",
      "idempotency_key"
    ]
  },
  "WorkflowTask": {
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "description": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "definition_of_done": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "work_revision": {
        "type": "integer"
      },
      "autonomy": {
        "type": "string",
        "enum": [
          "off",
          "on"
        ]
      },
      "autonomy_revision": {
        "type": "integer"
      },
      "preparation_state": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "start_hold": {
        "type": "boolean"
      },
      "human_hold_by": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "human_hold_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "awaiting_owner_decision": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "withdrawn_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "withdrawn_by": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "withdrawn_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "priority": {
        "type": "integer"
      },
      "assignee_ids": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "depends_on": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "can_start": {
        "type": "boolean"
      },
      "blockers": {
        "items": {
          "$ref": "#/components/schemas/Blocker"
        },
        "type": "array"
      },
      "display_state": {
        "$ref": "#/components/schemas/DisplayState"
      },
      "available_actions": {
        "items": {
          "$ref": "#/components/schemas/AvailableAction"
        },
        "type": "array"
      },
      "outside_result_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "outside_result_state": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "current_evidence_set_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "evidence_state": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "acceptance": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/TaskAcceptance"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "id",
      "title",
      "definition_of_done",
      "status",
      "work_revision",
      "preparation_state",
      "start_hold",
      "human_hold_by",
      "human_hold_reason",
      "awaiting_owner_decision",
      "withdrawn_at",
      "priority",
      "assignee_ids",
      "depends_on",
      "can_start",
      "blockers",
      "display_state",
      "available_actions"
    ]
  },
  "WorkflowTaskChoice": {
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "is_root": {
        "type": "boolean"
      },
      "workflow_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "id",
      "title",
      "status",
      "is_root"
    ]
  },
  "WorkflowTaskSearch": {
    "properties": {
      "results": {
        "items": {
          "$ref": "#/components/schemas/WorkflowTaskChoice"
        },
        "type": "array",
        "maxItems": 5
      },
      "selected": {
        "items": {
          "$ref": "#/components/schemas/WorkflowTaskChoice"
        },
        "type": "array",
        "maxItems": 200
      }
    },
    "type": "object",
    "required": [
      "results",
      "selected"
    ]
  },
  "WorkflowTaskEvidence": {
    "properties": {
      "task_id": {
        "type": "string"
      },
      "workflow_id": {
        "type": "string"
      },
      "current_evidence_set_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "sets": {
        "items": {
          "$ref": "#/components/schemas/SavedEvidenceSet"
        },
        "type": "array"
      },
      "next_before_revision": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "type": "object",
    "required": [
      "task_id",
      "workflow_id",
      "current_evidence_set_id",
      "sets"
    ]
  },
  "SavedEvidenceSet": {
    "properties": {
      "evidence_set_id": {
        "type": "string"
      },
      "task_id": {
        "type": "string"
      },
      "workflow_id": {
        "type": "string"
      },
      "workflow_execution_id": {
        "type": "string"
      },
      "run_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "work_revision": {
        "type": "integer"
      },
      "result_revision": {
        "type": "integer"
      },
      "source_sequence": {
        "type": "integer"
      },
      "generation": {
        "type": "integer"
      },
      "state": {
        "type": "string",
        "enum": [
          "pending",
          "saved",
          "missing",
          "superseded"
        ]
      },
      "purpose": {
        "type": "string",
        "enum": [
          "acceptance",
          "attempt_record"
        ]
      },
      "missing_reason": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "terminal_cause": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "frozen_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "source_revision": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "items": {
        "items": {
          "$ref": "#/components/schemas/SavedEvidenceItem"
        },
        "type": "array"
      }
    },
    "type": "object",
    "required": [
      "evidence_set_id",
      "task_id",
      "workflow_id",
      "workflow_execution_id",
      "run_id",
      "work_revision",
      "result_revision",
      "source_sequence",
      "generation",
      "state",
      "purpose",
      "missing_reason",
      "terminal_cause",
      "created_at",
      "frozen_at",
      "source_revision",
      "items"
    ]
  },
  "SavedEvidenceItem": {
    "properties": {
      "item_id": {
        "type": "string"
      },
      "deliverable_id": {
        "type": "string"
      },
      "deliverable_version": {
        "type": "integer",
        "minimum": 1
      },
      "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "kind": {
        "type": "string",
        "enum": [
          "result_summary",
          "file_changes",
          "log_excerpt",
          "owner_result",
          "outside_result",
          "import_result"
        ]
      },
      "source": {
        "type": "string",
        "enum": [
          "worker",
          "owner",
          "outside",
          "import",
          "cancelled_attempt",
          "released_attempt"
        ]
      },
      "snapshot_phase": {
        "type": "string",
        "enum": [
          "submission",
          "terminal"
        ]
      },
      "complete": {
        "type": "boolean"
      },
      "note": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "storage_state": {
        "type": "string",
        "enum": [
          "readable",
          "missing",
          "corrupt",
          "missing_after_restore"
        ]
      },
      "captured_by": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "captured_by_alias": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "captured_by_kind": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "human",
              "ai"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "item_id",
      "deliverable_id",
      "deliverable_version",
      "sha256",
      "kind",
      "source",
      "snapshot_phase",
      "complete",
      "note",
      "storage_state"
    ]
  }
};
export const workflowRoutes = [
  {
    "path": "/api/containers/{cid}/workflow-operations/{idempotency_key}",
    "method": "get"
  },
  {
    "path": "/api/containers/{cid}/workflow-task-search",
    "method": "get"
  },
  {
    "path": "/api/containers/{cid}/workflows",
    "method": "get"
  },
  {
    "path": "/api/containers/{cid}/workflows",
    "method": "post",
    "body": "WorkflowCreate"
  },
  {
    "path": "/api/containers/{cid}/workflows/capability",
    "method": "get"
  },
  {
    "path": "/api/containers/{cid}/workflows/preview",
    "method": "post",
    "body": "WorkflowDraft"
  },
  {
    "path": "/api/tasks/{tid}/accept",
    "method": "post",
    "operation": "accept",
    "body": "AcceptTask"
  },
  {
    "path": "/api/tasks/{tid}/approvals",
    "method": "get",
    "operation": "task_approvals"
  },
  {
    "path": "/api/tasks/{tid}/autonomy",
    "method": "put",
    "operation": "task_autonomy",
    "body": "TaskAutonomyUpdate"
  },
  {
    "path": "/api/tasks/{tid}/dependencies",
    "method": "put",
    "operation": "dependencies",
    "body": "DependencyEdit"
  },
  {
    "path": "/api/tasks/{tid}/external-result",
    "method": "post",
    "operation": "external_result",
    "body": "OutsideResult"
  },
  {
    "path": "/api/tasks/{tid}/external-result/{eid}/withdraw",
    "method": "post",
    "operation": "withdraw_evidence",
    "body": "TaskMutation"
  },
  {
    "path": "/api/tasks/{tid}/hold",
    "method": "post",
    "operation": "hold",
    "body": "TaskMutation"
  },
  {
    "path": "/api/tasks/{tid}/outcome",
    "method": "post",
    "operation": "report_outcome",
    "body": "OutcomeReport"
  },
  {
    "path": "/api/tasks/{tid}/outcome/preview",
    "method": "post",
    "body": "OutcomeChoice"
  },
  {
    "path": "/api/tasks/{tid}/prepare",
    "method": "post",
    "operation": "prepare",
    "body": "PrepareTask"
  },
  {
    "path": "/api/tasks/{tid}/reissue-stop",
    "method": "post",
    "operation": "reissue_stop",
    "body": "TaskMutation"
  },
  {
    "path": "/api/tasks/{tid}/reject",
    "method": "post",
    "operation": "reject",
    "body": "TaskMutation"
  },
  {
    "path": "/api/tasks/{tid}/release-lost-worker",
    "method": "post",
    "operation": "release_lost_worker",
    "body": "TaskMutation"
  },
  {
    "path": "/api/tasks/{tid}/retry",
    "method": "post",
    "operation": "retry",
    "body": "RetryTask"
  },
  {
    "path": "/api/tasks/{tid}/stop",
    "method": "post",
    "operation": "stop",
    "body": "TaskMutation"
  },
  {
    "path": "/api/tasks/{tid}/withdraw-from-scope",
    "method": "post",
    "operation": "withdraw",
    "body": "TaskMutation"
  },
  {
    "path": "/api/workflows/{wid}",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}",
    "method": "patch",
    "operation": "patch",
    "body": "WorkflowPatch"
  },
  {
    "path": "/api/workflows/{wid}/activity",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/cancel",
    "method": "post",
    "operation": "cancel",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/cancellation-check",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/completion-check",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/dependencies",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/finish",
    "method": "post",
    "operation": "finish",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/goal/accept",
    "method": "post",
    "operation": "accept_goal",
    "body": "AcceptBasis"
  },
  {
    "path": "/api/workflows/{wid}/hide",
    "method": "post",
    "operation": "hide",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/import",
    "method": "post",
    "operation": "import",
    "body": "ImportTasks"
  },
  {
    "path": "/api/workflows/{wid}/import-preview",
    "method": "post",
    "body": "ImportPreview"
  },
  {
    "path": "/api/workflows/{wid}/move",
    "method": "post",
    "operation": "move",
    "body": "MoveTasks"
  },
  {
    "path": "/api/workflows/{wid}/objectives/{oid}",
    "method": "patch",
    "operation": "edit_objective",
    "body": "ObjectiveEdit"
  },
  {
    "path": "/api/workflows/{wid}/objectives/{oid}/accept",
    "method": "post",
    "operation": "accept_objective",
    "body": "AcceptBasis"
  },
  {
    "path": "/api/workflows/{wid}/pause",
    "method": "post",
    "operation": "pause",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/release",
    "method": "post",
    "operation": "release",
    "body": "ReleaseTasks"
  },
  {
    "path": "/api/workflows/{wid}/release-check",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/restore",
    "method": "post",
    "operation": "restore",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/resume",
    "method": "post",
    "operation": "resume",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/review-loops/{tid}/resolve",
    "method": "post",
    "operation": "resolve_loop",
    "body": "Mutation"
  },
  {
    "path": "/api/workflows/{wid}/review-rounds",
    "method": "post",
    "operation": "review_round",
    "body": "ReviewRound"
  },
  {
    "path": "/api/workflows/{wid}/start",
    "method": "post",
    "operation": "start",
    "body": "ReleaseTasks"
  },
  {
    "path": "/api/workflows/{wid}/start-check",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/tasks",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/tasks",
    "method": "post",
    "operation": "add_tasks",
    "body": "TaskBatch"
  },
  {
    "path": "/api/workflows/{wid}/tasks/{tid}/evidence",
    "method": "post",
    "operation": "add_evidence",
    "body": "AddEvidence"
  },
  {
    "path": "/api/workflows/{wid}/tasks/{tid}/evidence",
    "method": "get"
  },
  {
    "path": "/api/workflows/{wid}/transfer-owner",
    "method": "post",
    "operation": "transfer_owner",
    "body": "TransferOwner"
  },
  {
    "path": "/api/workflows/{wid}/visibility-check",
    "method": "get"
  }
] as const;
