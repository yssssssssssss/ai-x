// Public plan/execute 类型 —— orchestrator 对外契约。
// 定义已上移到中立契约包 packages/api-contract/plan.ts(前后端共享同一份)。
// 这里 re-export 让 orchestrator/runner/tests 的老 import 路径('./plan-types.ts')继续可用。

export type {
  CandidateProfile,
  PlanningProvenance,
  GuidanceRef,
  Assumption,
  ResearchTaskData,
  PendingUpload,
  PlanStep,
  PlanCandidate,
  PlanResult,
  PlanPhaseKey,
  PlanProgress,
  SelectResult,
  ExecuteResult,
} from '../../../packages/api-contract/plan.ts';
