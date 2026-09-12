import type { LLMClient } from '../runtime/llm-client.ts';
import type { PlanStep } from '../plan-types.ts';
import type { ActorRunner, ExecCtx, StepArtifact } from './actor-runner.ts';

// reviewer 步:轻量复核,收进 reviewNotes 供 synthesis。
// 不改前序产出,不进 toolOutputs;审查来源标注是否完整、是否把推断当事实、数据缺口是否说明。
export class ReviewerActorRunner implements ActorRunner {
  readonly actorType = 'reviewer' as const;

  constructor(private readonly llm: LLMClient) {}

  async run(step: PlanStep, ctx: ExecCtx): Promise<StepArtifact> {
    const gen = await this.llm.generateText({
      prompt:
        `你是质量复核者:「${step.step_name}」。审查已有执行结果的来源标注是否完整、` +
        `有无把推断当事实、数据缺口是否说明，以及面向用户的内容是否使用与 research_goal 相同的主要语言。` +
        `中文研究目标应使用简体中文，专有名词、标准缩写和来源原文除外。产出复核意见,不改写前序结论。`,
      context: { research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs },
      receipt: {
        stage: 'reviewer',
        attemptId: ctx.attemptId,
        stepNo: step.step_no,
        contextManifestHash: ctx.contextManifestHash,
        expectedModel: ctx.expectedModel,
      },
    });

    const outputRef = ctx.ws.writeToolOutput(step.step_no, { review: gen.text });

    return {
      kind: 'review_note',
      actorId: step.actor_id,
      review: gen.text,
      outputRef,
      tokens: gen.tokens,
    };
  }
}
