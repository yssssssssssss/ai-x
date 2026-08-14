// DirectPlanner —— $ 直呼支路:确定性单步 skill 计划,不激活决策节点、不判状态、不走路由 LLM。
// 直呼场景只产 1 份候选,前端仍走"选中"流程但只有一个选项。
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
    const candidates = [
      {
        id: 'depth' as const,
        title: `直呼 ${skill.name}`,
        rationale: `用户 $ 直呼技能 ${skill.name},跳过路由。`,
        tradeoffs: '仅执行该技能,不做横向对比。',
        steps: [
          {
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
          } as PlanStep,
        ],
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
