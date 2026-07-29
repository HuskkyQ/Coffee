export type TaskPlanStatus =
  | "active"
  | "blocked"
  | "completed"
  | "cancelled";

export type TaskStepStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "superseded";

export interface TaskStepDraft {
  readonly id: string;
  readonly title: string;
  readonly successCriteria: string;
  readonly dependsOn: readonly string[];
}

export interface TaskStep extends TaskStepDraft {
  readonly status: TaskStepStatus;
  readonly retryCount: number;
  readonly result?: string;
  readonly blockReason?: string;
}

export interface TaskPlan {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly status: TaskPlanStatus;
  readonly revision: number;
  readonly steps: readonly TaskStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlanUpdateAction =
  | {
      readonly type: "start_step";
      readonly stepId: string;
    }
  | {
      readonly type: "complete_step" | "fail_step";
      readonly stepId: string;
      readonly result: string;
    }
  | {
      readonly type: "block_step";
      readonly stepId: string;
      readonly reason: string;
    }
  | {
      readonly type: "resume_step";
      readonly stepId: string;
    }
  | {
      readonly type: "add_steps";
      readonly steps: readonly TaskStepDraft[];
    }
  | {
      readonly type: "replace_pending_steps";
      readonly steps: readonly TaskStepDraft[];
    };

export interface CreateTaskPlanInput {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly steps: readonly TaskStepDraft[];
  readonly now: string;
}
