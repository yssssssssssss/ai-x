// sanitizeCandidateToPlan —— 脏候选 → 干净 execution-plan 的纯转换(LLM 漂移防线)。
// 候选生成时 schema:{} 不严格校验,真实 LLM 常给 step 用 step_id/漏 step_name/多塞字段;
// 这里按 execution-plan schema 白名单清洗并兜底:step_no 一律用数组顺序(不信 LLM 编号),
// step_name 缺失用 actor_id 兜底,丢弃 step_id 等非法字段,避免 additionalProperties:false 校验失败。
// 纯函数、零依赖:schema 校验(validateOrThrow)留在调用方,产出「必过 schema」由单测断言。

import type { Assumption, PlanCandidate, PlanStep } from '../plan-types.ts';

export interface ExecutionPlan {
  task_id: string;
  task_type: string;
  steps: PlanStep[];
  activated_nodes: string[];
  assumptions: Assumption[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const cleanStep = (s: PlanStep, i: number): PlanStep => ({
  step_no: i + 1,
  step_name: s.step_name || s.actor_id || `步骤 ${i + 1}`,
  actor_type: s.actor_type,
  actor_id: s.actor_id,
  ...(typeof s.purpose === 'string' ? { purpose: s.purpose } : {}),
  ...(isPlainObject(s.input) ? { input: s.input } : {}),   // 非纯对象(字符串/数组/null)丢弃,执行时回落 {query}
  ...(typeof s.requires_approval === 'boolean' ? { requires_approval: s.requires_approval } : {}),
});

const cleanAssumption = (a: unknown, i: number): Assumption => {
  if (typeof a === 'string') return { key: `假设 ${i + 1}`, value: a, editable: true };
  const o = (a ?? {}) as { key?: string; value?: string; editable?: boolean; name?: string; description?: string; assumption?: string };
  return {
    key: o.key ?? o.name ?? `假设 ${i + 1}`,
    value: o.value ?? o.description ?? o.assumption ?? JSON.stringify(a),
    editable: o.editable ?? true,
  };
};

export function sanitizeCandidateToPlan(
  cand: PlanCandidate,
  taskId: string,
  taskType: string,
): ExecutionPlan {
  return {
    task_id: taskId,
    task_type: taskType,
    steps: cand.steps.map(cleanStep),
    activated_nodes: cand.activated_nodes,
    assumptions: (cand.assumptions ?? []).map(cleanAssumption),
  };
}
