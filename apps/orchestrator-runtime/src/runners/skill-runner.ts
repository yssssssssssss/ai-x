import type { LLMClient } from '../runtime/llm-client.ts';
import type { SkillLoader } from '../runtime/skill-loader.ts';
import type { SchemaValidator } from '../schema/validator.ts';
import type { PlanStep } from '../plan-types.ts';
import { prepareSkillExecution } from '../skills/skill-runtime.ts';
import type { ActorRunner, ExecCtx, StepArtifact } from './actor-runner.ts';

// skill 步:加载 SKILL.md 全文 + output schema,调 LLM 按工作流基于 tool_outputs 产出结构化结果。
// 无数据支撑的判断需标 llm_inference,不冒充事实(prompt 约束)。
export class SkillActorRunner implements ActorRunner {
  readonly actorType = 'skill' as const;

  constructor(
    private readonly llm: LLMClient,
    private readonly skillLoader: SkillLoader,
    private readonly validator: SchemaValidator,
  ) {}

  async run(step: PlanStep, ctx: ExecCtx): Promise<StepArtifact> {
    const prepared = prepareSkillExecution({
      skillId: step.actor_id,
      researchGoal: ctx.researchGoal,
      resolvedInput: step.input ?? {},
      priorOutputs: ctx.toolOutputs,
      skillLoader: this.skillLoader,
      validator: this.validator,
    });

    const skillGen = await this.llm.generateStructured<object>({
      prompt: prepared.prompt,
      schema: prepared.schemas.output ?? {},
      schemaName: `skill:${step.actor_id}`,
      context: prepared.context,
      receipt: {
        stage: 'skill',
        attemptId: ctx.attemptId,
        stepNo: step.step_no,
        contextManifestHash: ctx.contextManifestHash,
        expectedModel: ctx.expectedModel,
      },
    });

    this.validator.validateSchemaOrThrow(prepared.schemas.output, skillGen.data, `skill:${step.actor_id}`);

    const outputRef = ctx.ws.writeToolOutput(step.step_no, skillGen.data);

    return {
      kind: 'skill_output',
      actorId: step.actor_id,
      output: skillGen.data,
      outputRef,
      manifestHash: prepared.body.hash,
      tokens: skillGen.tokens,
    };
  }
}
