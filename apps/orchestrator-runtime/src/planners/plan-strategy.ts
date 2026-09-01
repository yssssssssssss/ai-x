// PlanStrategy 契约 —— planPhase 分叉(direct / routed)的接缝。
// 目的:把「候选生成」两条支路各收进独立 planner,glue 只做
//   公共前置(任务理解)→ 选策略 → strategy.plan(ctx) → 落库公共尾。
// direct / routed 的 candidate 形状与 provenance 兜底从此由 PlanArtifacts 统一类型强制对齐,
// 漂移在 tsc 阶段即炸,而非运行时才发现。
//
// 与 runners/actor-runner.ts 对称:契约 + 共享类型集中此文件,
// deps 构造期注入(见 PlannerDeps),ctx 只带运行态数据。planner 不反向依赖 orchestrator(无循环依赖)。

import type { DecisionNode } from '../runtime/config-loader.ts';
import type { LLMClient } from '../runtime/llm-client.ts';
import type { SkillLoader } from '../runtime/skill-loader.ts';
import type { SchemaValidator } from '../schema/validator.ts';
import type { GuidanceRef, PlanCandidate, PlanProgress, ResearchTaskData } from '../plan-types.ts';
import type { CandidateProfile, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { OrchestrationModeV1 } from '../../../../packages/api-contract/control-workflow.ts';
import type { CapabilityApprovalAuthority } from './capability-resolver.ts';
import type { ToolRouter } from '../runtime/tool-adapter.ts';
import type { ScenarioId } from './planning-guidance.ts';

// $<skill> 直呼解析结果(parseDirectInvoke 的非空返回)。命中直呼支路时非 null。
export interface DirectInvoke {
  skillName: string;
  rest: string;
}

// 计划溯源:direct 用段1 taskGen 兜底,routed 用 planGen。四字段与 context_manifest 落盘一致。
export interface PlanProvenance {
  modelName: string;
  modelVersion: string;
  promptHash: string;
  traceId: string;
}

// 决策状态记录 —— PlanArtifacts.decisionStates 的元素。routed 产出、落库段消费,
// 横跨 planner/glue 边界,故权威定义落此契约文件(D5)。
export interface DecisionStateRec {
  node_key: string;
  state: string;
  reason: string;
  confidence?: number;
  user_override: unknown;
  final_state: string;
}

// planner 构造期注入的依赖子集(取自 rt.deps)。与 runners 一样在构造函数拿齐,不进 ctx。
export interface PlannerDeps {
  llm: LLMClient;
  validator: SchemaValidator;
  skillLoader: SkillLoader;
  // 网关实际返回的规范模型 ID(drift 门禁锚点)。注入后 planning receipt 用它做比对,
  // 否则回退到 llm.identity.requestedModel(本地 mock 场景)。
  expectedActualModel?: string;
  tools?: ToolRouter;
  approvalAuthorities?: readonly CapabilityApprovalAuthority[];
  /** Multi-Skill portfolio wiring is built behind an inactive writer gate until Activation. */
  multiSkillPortfolioMode?: 'inactive' | 'active';
  /** Tests/evaluation may inject a complete policy; production loads the checked-in YAML. */
  planningPolicy?: unknown;
}

// 策略入参:公共前置产出的运行态数据 + 流式进度回调。deps 不在此(构造期注入)。
export interface PlanContext {
  task: ResearchTaskData;
  direct: DirectInvoke | null;
  originalInput?: string;
  requirement?: ResearchTaskV2;
  /** User-selected execution path, frozen for the lifetime of the Task. */
  orchestrationMode?: OrchestrationModeV1;
  /** Finalized user requirement before deliverable labels are canonicalized for execution. */
  guidanceRequirement?: ResearchTaskV2;
  /** Explicit user choice returned by the Planning Guidance clarification gate. */
  selectedScenarioId?: ScenarioId;
  /** New routed tasks stop at the direction gate until a Scenario is explicitly selected. */
  requireExplicitScenarioSelection?: boolean;
  /** Revisions keep the active Profile inside the direction's two-specialty cap when still eligible. */
  requiredProfileId?: CandidateProfile;
  // 段1 taskGen 的溯源,direct 支路无路由 LLM,用它兜底 planProvenance。
  taskProvenance: PlanProvenance;
  emit: (ev: PlanProgress) => void;
}

// 策略产物:两支路统一交付的五样,落库公共尾共用。
export interface PlanArtifacts {
  activated: DecisionNode[];
  decisionStates: DecisionStateRec[];
  candidates: PlanCandidate[];
  planProvenance: PlanProvenance;
  guidanceSources: GuidanceRef[];
}

// 单一契约:planner 拿 ctx,产出统一 PlanArtifacts。抛错即规划失败,由 glue/调用方处理。
export interface PlanStrategy {
  plan(ctx: PlanContext): Promise<PlanArtifacts>;
}
