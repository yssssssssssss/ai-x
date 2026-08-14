// DirectPlanner —— $ 直呼支路:确定性 depth/speed skill 计划,不激活决策节点、不判状态、不走路由 LLM。
// speed 只执行直呼 skill；depth 在相同 skill step 后追加 reviewer，使两个候选可审计且 hash distinct。
// provenance 无路由 LLM,用公共前置段1 taskGen 兜底(ctx.taskProvenance)。

import type { PlanStep } from '../plan-types.ts';
import type {
  PlanArtifacts,
  PlanContext,
  PlannerDeps,
  PlanStrategy,
} from './plan-strategy.ts';

export class DirectPlanner implements PlanStrategy {
  constructor(private readonly deps: PlannerDeps) {}

  async plan(ctx: PlanContext): Promise<PlanArtifacts> {
    const { skillLoader } = this.deps;
    const { task, direct, taskProvenance, emit, requirement } = ctx;
    if (!direct) throw new Error('DirectPlanner 需要非空 direct(内部错误:glue 路由有误)');

    const skill = skillLoader.getSkill(direct.skillName);
    if (!skill) {
      throw new Error(
        `未知 skill "$${direct.skillName}"。可用 skill: ${skillLoader.listActiveSkills().map((s) => s.id).join(', ')}`,
      );
    }
    const directStep = (): PlanStep => ({
      step_no: 1,
      step_name: `直呼 ${skill.id}`,
      actor_type: 'skill',
      actor_id: skill.id,
      purpose: `用户 $ 直呼技能 ${skill.name}`,
      input: {
        research_goal: task.research_goal,
        brief: direct.rest,
        ...(requirement ? { requirement } : {}),
      },
    });
    const candidates = [
      {
        id: 'depth' as const,
        title: `直呼 ${skill.name}（含复核）`,
        rationale: `执行用户直呼的 ${skill.name}，并追加独立质量复核。`,
        tradeoffs: '多一步复核，耗时略长。',
        steps: [
          directStep(),
          {
            step_no: 2,
            step_name: '复核直呼结果',
            actor_type: 'reviewer',
            actor_id: 'research-plan-reviewer',
            purpose: `复核 ${skill.name} 的输出质量与需求覆盖`,
          } as PlanStep,
        ],
        assumptions: task.assumptions ?? [],
        activated_nodes: [],
      },
      {
        id: 'speed' as const,
        title: `直呼 ${skill.name}`,
        rationale: `用户 $ 直呼技能 ${skill.name}，跳过路由与额外复核。`,
        tradeoffs: '仅执行该技能，速度更快但不做独立复核。',
        steps: [directStep()],
        assumptions: task.assumptions ?? [],
        activated_nodes: [],
      },
    ];
    emit({ phase: 'candidates', status: 'done', label: '生成候选方案', detail: `直呼 ${direct.skillName}` });

    // 直呼无路由 LLM(planGen),provenance 用段1 taskGen 兜底。
    return {
      activated: [],
      decisionStates: [],
      candidates,
      planProvenance: taskProvenance,
      guidanceSources: [],
    };
  }
}
