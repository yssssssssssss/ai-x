import type { LLMClient } from '../runtime/llm-client.ts';
import type { PlanStep } from '../plan-types.ts';
import type { ActorRunner, ExecCtx, StepArtifact } from './actor-runner.ts';

// llm 步:基于已累积输出产出简洁小结,push 进 toolOutputs 供后续 + synthesis。
// 落盘与内存保持同一结构({note}),供 resume 重建一致。
export class LlmActorRunner implements ActorRunner {
  readonly actorType = 'llm' as const;

  constructor(private readonly llm: LLMClient) {}

  async run(step: PlanStep, ctx: ExecCtx): Promise<StepArtifact> {
    const gen = await this.llm.generateText({
      prompt:
        `你是研究编排中的一步:「${step.step_name}」。${step.purpose ?? ''}\n` +
        `基于已有执行结果(检索数据 + 竞品分析)完成这一步,产出简洁小结;` +
        `凡引用数据的结论标明来源,无据推断需说明。`,
      context: { research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs },
    });

    const out = { note: gen.text };
    const outputRef = ctx.ws.writeToolOutput(step.step_no, out);

    return {
      kind: 'llm_note',
      actorId: step.actor_id,
      output: out,
      outputRef,
      tokens: gen.tokens,
    };
  }
}
