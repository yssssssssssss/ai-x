import type { FinalizedPlan } from '../../../../packages/api-contract/http.ts';
import { multiSkillPlanViewModel } from '../multi-skill-view-model.ts';

function nativeSkillDisplayName(
  invocation: NonNullable<FinalizedPlan['skill_invocations']>[number],
  index: number,
): string {
  if ('run_spec' in invocation) {
    const heading = /^#\s+(.+)$/mu.exec(invocation.run_spec.body)?.[1]?.trim();
    if (heading && /[\p{Script=Han}]/u.test(heading)) return heading;
  }
  return `专业分析能力 ${index + 1}`;
}

export function MultiSkillPlanSummary({ plan, compact = false }: {
  plan: FinalizedPlan;
  compact?: boolean;
}) {
  if (plan.execution_contract_version === 'native-skill-execution-plan-v1' && plan.mode === 'multi_skill') {
    const invocations = plan.skill_invocations ?? [];
    return (
      <div
        className={`multi-skill-plan-summary${compact ? ' is-compact' : ''}`}
        aria-label="多项能力协作计划"
        style={{ marginTop: 12, padding: compact ? '8px 10px' : '12px', border: '1px solid var(--border-soft)', borderRadius: 8, textAlign: 'left' }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
          <strong>{invocations.length} 项分析能力</strong>
          <span>1 次最终综合</span>
          <span>{plan.steps.length} 个执行步骤</span>
        </div>
        {!compact ? (
          <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
            {invocations.map((invocation, index) => (
              <li key={invocation.invocation_id} style={{ marginTop: 5, fontSize: 12 }}>
                <strong>{nativeSkillDisplayName(invocation, index)}</strong>
                {' · '}{'required' in invocation && invocation.required === false ? '可选' : '必需'}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const model = multiSkillPlanViewModel(plan);
  if (!model) return null;
  return (
    <div
      className={`multi-skill-plan-summary${compact ? ' is-compact' : ''}`}
      aria-label="多项能力协作计划"
      style={{ marginTop: 12, padding: compact ? '8px 10px' : '12px', border: '1px solid var(--border-soft)', borderRadius: 8, textAlign: 'left' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        <strong>{model.contributorCount} 项分析能力</strong>
        <span>1 项综合能力</span>
        <span>必需问题覆盖 {model.coveredRequiredDemandCount}/{model.requiredDemandCount}</span>
        <span>
          预算 {model.budget.estimated_steps}/{model.budget.max_steps} 逻辑步
          {' · '}{model.budget.expanded_step_count}/{model.budget.expanded_step_limit} 展开步
        </span>
        {model.synthetic ? <span style={{ color: 'var(--warn)' }}>含虚拟用户假设</span> : null}
      </div>
      {!compact ? (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
          {model.invocations.map((invocation, index) => (
            <li key={invocation.invocation_id} style={{ marginTop: 5, fontSize: 12 }}>
              <strong>{invocation.role === 'synthesizer' ? '综合分析' : `专业分析 ${index + 1}`}</strong>
              {' · '}{invocation.required ? '必需' : '可选'}
            </li>
          ))}
        </ul>
      ) : null}
      {!compact && model.sharedPrerequisites.length > 0 ? (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <strong>共享准备：</strong>
          {model.sharedPrerequisites.length} 项资料准备将由相关分析能力共同使用
        </div>
      ) : null}
      {!compact && (model.rejected.length > 0 || model.capabilityGaps.length > 0) ? (
        <details style={{ marginTop: 10 }}>
          <summary>暂未采用的能力与资料缺口（{model.rejected.length + model.capabilityGaps.length}）</summary>
          <p style={{ fontSize: 12 }}>这些项目不会阻止当前计划；执行结果会说明可能受影响的范围。</p>
        </details>
      ) : null}
      {model.uncoveredRequiredDemandIds.length > 0 ? (
        <p role="alert" style={{ margin: '8px 0 0', color: 'var(--danger)', fontSize: 12 }}>
          未覆盖：{model.uncoveredRequiredDemandIds.join('、')}
        </p>
      ) : null}
    </div>
  );
}
