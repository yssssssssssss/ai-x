import type { LLMClient } from '../runtime/llm-client.ts';
import type { SkillLoader } from '../runtime/skill-loader.ts';
import type { SchemaValidator } from '../schema/validator.ts';
import type { PlanStep } from '../plan-types.ts';
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
    const skillEntry = this.skillLoader.getSkill(step.actor_id);
    if (!skillEntry) throw new Error(`skill 非 active 或不存在: ${step.actor_id}`);

    const { body, hash: manifestHash } = this.skillLoader.loadSkillBody(step.actor_id);
    const { output } = this.skillLoader.loadSkillSchemas(step.actor_id);

    const skillGen = await this.llm.generateStructured<object>({
      prompt:
        `你是「${skillEntry.name}」能力。严格按以下 SKILL.md 的工作流与质量门禁执行,` +
        `基于提供的检索数据(tool_outputs)产出结构化结果;无数据支撑的判断标 llm_inference,不得冒充事实。\n\n${body}`,
      schema: output ?? {},
      schemaName: `skill:${step.actor_id}`,
      context: { research_goal: ctx.researchGoal, tool_outputs: ctx.toolOutputs },
      receipt: {
        stage: 'skill',
        attemptId: ctx.attemptId,
        stepNo: step.step_no,
        contextManifestHash: ctx.contextManifestHash,
        expectedModel: ctx.expectedModel,
      },
    });

    this.validator.validateSchemaOrThrow(output, skillGen.data, `skill:${step.actor_id}`);

    const outputRef = ctx.ws.writeToolOutput(step.step_no, skillGen.data);

    return {
      kind: 'skill_output',
      actorId: step.actor_id,
      output: skillGen.data,
      outputRef,
      manifestHash,
      tokens: skillGen.tokens,
    };
  }
}
