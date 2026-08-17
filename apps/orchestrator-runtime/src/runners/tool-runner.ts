import { join } from 'node:path';
import { hashFile, loadToolManifest, getConfigRoot } from '../runtime/config-loader.ts';
import type { ToolAdapter } from '../runtime/tool-adapter.ts';
import type { SkillLoader } from '../runtime/skill-loader.ts';
import type { SchemaValidator } from '../schema/validator.ts';
import type { PlanStep } from '../plan-types.ts';
import type { ActorRunner, ExecCtx, StepArtifact } from './actor-runner.ts';

// tool 步:装 input(计划 LLM 生成的 step.input,兜底 {query})→ 图像回填 →
// 清空占位 → input schema 校验 → 调 tool → output schema 校验 → 落盘。
export class ToolActorRunner implements ActorRunner {
  readonly actorType = 'tool' as const;

  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly toolAdapter: ToolAdapter,
    private readonly validator: SchemaValidator,
  ) {}

  async run(step: PlanStep, ctx: ExecCtx): Promise<StepArtifact> {
    const tool = this.skillLoader.getTool(step.actor_id);
    if (!tool) throw new Error(`tool 非 active 或不存在: ${step.actor_id}`);
    const manifest = loadToolManifest(tool.path);

    // 计划 LLM 生成的 step.input 优先;检索类工具兜底 {query}
    const toolInput: Record<string, unknown> = {
      ...(step.input ?? { query: ctx.researchGoal || '直播 数字人 竞品' }),
    };

    // 用户上传的图像按字段 role 回填(同 role 一次上传回填到所有步骤)
    for (const f of manifest.image_input_fields ?? []) {
      const up = (ctx.uploads ?? []).find((u) => u.role === (f.role ?? f.field));
      if (up) toolInput[f.field] = f.multiple ? [{ dataUrl: up.dataUrl }] : { dataUrl: up.dataUrl };
    }

    // 清理 LLM 生成的空占位:顶层空对象与数组内空对象都剔除,避免图像工具 500
    for (const k of Object.keys(toolInput)) {
      const v = toolInput[k];
      if (Array.isArray(v)) {
        const filtered = v.filter((e) => !(e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length === 0));
        if (filtered.length === 0) delete toolInput[k];
        else toolInput[k] = filtered;
      } else if (v && typeof v === 'object' && Object.keys(v).length === 0) {
        delete toolInput[k];
      }
    }

    this.validator.validateFileOrThrow(join(getConfigRoot(), manifest.input_schema), toolInput);
    const res = await this.toolAdapter.invoke({
      toolId: step.actor_id,
      input: toolInput,
      manifest,
      attemptId: ctx.attemptId,
      retryOf: ctx.retryOf,
    });
    this.validator.validateFileOrThrow(join(getConfigRoot(), manifest.output_schema), res.output);

    const outputRef = ctx.ws.writeToolOutput(step.step_no, res.output);

    return {
      kind: 'tool_output',
      actorId: step.actor_id,
      output: res.output,
      outputRef,
      manifestHash: hashFile(tool.path),
    };
  }
}
