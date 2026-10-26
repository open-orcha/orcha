// Generated from FastAPI OpenAPI slices. DO NOT EDIT.
// Workflow source SHA-256: 9ec06a7f1db24b8223b04da8a9f82ab56ee937abd27490f5add7bd7917eb753f
// Evidence GET source SHA-256: a3a98a4093221faf85216c9e00bfa7d9ed5384c9c435b1f23dd5333f0bf45413
// Regenerate with tools/generate-workflow-contract.mjs and both source files.

export type AcceptBasis = {
  "expected_revision": number;
  "idempotency_key": string;
  "reason"?: string;
  "evidence": EvidenceBasis;
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

export type HTTPValidationError = {
  "detail"?: Array<ValidationError>;
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

export type WorkflowCreate = {
  "title": string;
  "goal": string;
  "execution_mode"?: "serial" | "parallel";
  "objectives"?: Array<NewObjective>;
  "tasks"?: Array<NewTask>;
  "existing_task_ids"?: Array<string>;
  "import_acceptances"?: Record<string, ImportAcceptance>;
  "idempotency_key": string;
  "preview_digest"?: string | null;
};

export type WorkflowDetail = {
  "id": string;
  "container_id": string;
  "title": string;
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
  "kind": "result_summary" | "file_changes" | "log_excerpt" | "owner_result" | "outside_result";
  "source": "worker" | "owner" | "outside" | "cancelled_attempt" | "released_attempt";
  "snapshot_phase": "submission" | "terminal";
  "complete": boolean;
  "note": string | null;
  "storage_state": "readable" | "missing" | "corrupt" | "missing_after_restore";
};

export type WorkflowModels = {
  AcceptBasis: AcceptBasis;
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
  HTTPValidationError: HTTPValidationError;
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
  OutsideResult: OutsideResult;
  PrepareTask: PrepareTask;
  Preview: Preview;
  Progress: Progress;
  Receipt: Receipt;
  ReleaseTasks: ReleaseTasks;
  RetryTask: RetryTask;
  ReviewHistory: ReviewHistory;
  ReviewRound: ReviewRound;
  TaskBatch: TaskBatch;
  TaskMutation: TaskMutation;
  TransferOwner: TransferOwner;
  ValidationError: ValidationError;
  WorkflowCreate: WorkflowCreate;
  WorkflowDetail: WorkflowDetail;
  WorkflowDraft: WorkflowDraft;
  WorkflowList: WorkflowList;
  WorkflowPatch: WorkflowPatch;
  WorkflowTask: WorkflowTask;
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
      }
    },
    "additionalProperties": false,
    "type": "object",
    "required": [
      "title",
      "goal"
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
          "outside_result"
        ]
      },
      "source": {
        "type": "string",
        "enum": [
          "worker",
          "owner",
          "outside",
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
  }
] as const;
