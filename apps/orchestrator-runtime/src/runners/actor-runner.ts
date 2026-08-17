// ActorRunner 契约 —— runStep 4-way switch 的接缝。
// 目的:把每种 actor_type 的执行装配收进独立 Runner,orchestrator 只做
//   log(running) → runner.run(step, ctx) → 落 artifact → log(succeeded)
// 的流水线,不再关心"tool 要不要清空占位"、"skill 要不要装 SKILL.md 全文"这类差异。
//
// 深度取自 Q1-Q11 grilling 决策:
//   - Q4a: ExecCtx 保留全字段,Runner 只回 artifact,orchestrator 负责 commit 累积
//   - Q7a: 单个 discriminated union StepArtifact,kind 区分产物类别
//   - Q10a: run() 抛错即步失败,orchestrator 层统一 catch 落 stepFailures/run_state
//
// Runner 不写 execution_log 也不 updateTaskStatus —— 那属于 orchestrator 的编排职责。
// Runner 只做"这一步该干什么"。

import type { RunWorkspace } from '../run-workspace.ts';
import type { PlanStep } from '../plan-types.ts';

// 执行累积上下文:runFrom / resume 一路带下来的跨步产物。
// Runner 读它拿"迄今为止的检索数据 / 已用能力 / 复核意见",不直接改它。
// (改由 orchestrator 在 commitArtifact 时统一进行,保持累积逻辑单点。)
export interface ExecCtx {
  taskId: string;
  conversationId: string;
  researchGoal: string;
  ws: RunWorkspace;
  plan: { steps: PlanStep[]; task_id: string };
  graphHash: string;
  attemptId?: string;
  retryOf?: string | null;
  contextManifestHash?: string;
  expectedModel?: string;
  uploads?: Array<{ role: string; dataUrl: string }>;
  toolOutputs: Array<{ toolId: string; output: unknown }>;
  reviewNotes: string[];
  stepFailures: StepFailure[];
  usedCapabilities: Array<{ id: string; type: string }>;
  toolOutputRefs: Array<{ stepNo: number; toolId: string }>;
}

export interface StepFailure {
  stepNo: number;
  stepName: string;
  actorType: PlanStep['actor_type'];
  actorId: string;
  message: string;
}

// StepArtifact:Runner 的产物 —— orchestrator 据此累积上下文 + 记 execution_log。
// kind 决定后续注入 toolOutputs 还是 reviewNotes,以及 skill/tool manifest hash 归属。
export type StepArtifact =
  | {
      kind: 'tool_output';
      actorId: string;
      output: unknown;
      outputRef: string;
      manifestHash: string;
      tokens?: TokenUsage;
    }
  | {
      kind: 'skill_output';
      actorId: string;
      output: unknown;
      outputRef: string;
      manifestHash: string;
      tokens?: TokenUsage;
    }
  | {
      kind: 'llm_note';
      actorId: string;
      output: { note: string };
      outputRef: string;
      tokens?: TokenUsage;
    }
  | {
      kind: 'review_note';
      actorId: string;
      review: string;
      outputRef: string;
      tokens?: TokenUsage;
    };

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

// 单一契约:Runner 拿 step + ctx,决定这一步该干什么,回一份 artifact。
// 抛错即 step failed;orchestrator 层负责 catch/落 stepFailures/落 run_state/停到 paused。
export interface ActorRunner {
  readonly actorType: PlanStep['actor_type'];
  run(step: PlanStep, ctx: ExecCtx): Promise<StepArtifact>;
}
