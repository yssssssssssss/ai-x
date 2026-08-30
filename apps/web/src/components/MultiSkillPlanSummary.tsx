import type { FinalizedPlan } from '../../../../packages/api-contract/http.ts';
import { multiSkillPlanViewModel } from '../multi-skill-view-model.ts';

export function MultiSkillPlanSummary({ plan, compact = false }: {
  plan: FinalizedPlan;
  compact?: boolean;
}) {
  const model = multiSkillPlanViewModel(plan);
  if (!model) return null;
  return (
    <div
      className={`multi-skill-plan-summary${compact ? ' is-compact' : ''}`}
      aria-label="Multi-Skill 组合计划"
      style={{ marginTop: 12, padding: compact ? '8px 10px' : '12px', border: '1px solid var(--border-soft)', borderRadius: 8, textAlign: 'left' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        <strong>{model.contributorCount} 个 Contributor</strong>
        <span>1 个 Synthesizer</span>
        <span>Required Coverage {model.coveredRequiredDemandCount}/{model.requiredDemandCount}</span>
        <span>
          预算 {model.budget.estimated_steps}/{model.budget.max_steps} 逻辑步
          {' · '}{model.budget.expanded_step_count}/{model.budget.expanded_step_limit} 展开步
        </span>
        {model.synthetic ? <span style={{ color: 'var(--warn)' }}>含虚拟用户假设</span> : null}
      </div>
      {!compact ? (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
          {model.invocations.map((invocation) => (
            <li key={invocation.invocation_id} style={{ marginTop: 5, fontSize: 12 }}>
              <strong>{invocation.role === 'synthesizer' ? 'Synthesizer' : 'Contributor'}</strong>
              {' · '}{invocation.skill_id}
              {' · '}{invocation.required ? 'Required' : 'Optional'}
              {' · '}{invocation.question_ids.join(' / ')}
              {' · '}{model.selections.find(({ invocation_id }) => invocation_id === invocation.invocation_id)?.reason_codes.join(' / ') ?? 'policy'}
              {invocation.requested_artifact_types.length > 0
                ? ` · ${invocation.requested_artifact_types.join(' / ')}`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {!compact && model.sharedPrerequisites.length > 0 ? (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <strong>共享阶段：</strong>
          {model.sharedPrerequisites.map((item) => (
            <span key={`${item.capability_type}:${item.capability_id}`}>
              {item.capability_type} {item.capability_id} → {item.consumer_skill_ids.join('、')}
            </span>
          ))}
        </div>
      ) : null}
      {!compact && (model.rejected.length > 0 || model.capabilityGaps.length > 0) ? (
        <details style={{ marginTop: 10 }}>
          <summary>未选能力与缺口（{model.rejected.length + model.capabilityGaps.length}）</summary>
          <ul style={{ paddingLeft: 18, fontSize: 12 }}>
            {model.rejected.map((item) => (
              <li key={`${item.skill_id}:${item.reason_code}`}>{item.skill_id} · {item.reason_code} · {item.related_ids.join('、')}</li>
            ))}
            {model.capabilityGaps.map((gap) => (
              <li key={`${gap.capability_type}:${gap.capability_id}`}>{gap.capability_id} · {gap.code} · {gap.message}</li>
            ))}
          </ul>
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
