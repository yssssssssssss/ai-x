import type { CurrentPlanCandidate } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

// 段2a · Current 候选计划：选择的稳定标识是 planVersionId，而不是展示用 candidateId。
export function Stage2Candidates({
  candidates, onSelect, selectedId, loading, readOnly = false,
}: {
  candidates: CurrentPlanCandidate[];
  onSelect: (planVersionId: CurrentPlanCandidate['planVersionId']) => void;
  selectedId?: CurrentPlanCandidate['planVersionId'];
  loading?: boolean;
  readOnly?: boolean;
}) {
  return (
    <section className="stage-card">
      <Header n="2" title="待选执行方案" note={readOnly ? '旧任务仅可查看' : '选一份继续，可对比差异后再定'} />
      <div className="candidate-grid">
        {candidates.map((candidate) => {
          const active = selectedId === candidate.planVersionId;
          const steps = candidate.plan.steps;
          return (
            <button
              key={candidate.planVersionId}
              type="button"
              aria-pressed={active}
              aria-busy={active && loading}
              disabled={readOnly || loading}
              onClick={readOnly ? undefined : () => onSelect(candidate.planVersionId)}
              className={`candidate-card${active ? ' is-active' : ''}`}
            >
              <div className="candidate-head">
                <span className={`candidate-tag tag-${candidate.candidateId}`}>
                  {candidate.candidateId === 'depth' ? '深度优先' : '速度优先'}
                </span>
                <b className="candidate-title">{candidate.title}</b>
                {active && loading && <span className="spinner" style={{ marginLeft: 'auto' }} />}
              </div>
              <p className="candidate-rationale">{candidate.rationale}</p>
              <div className="candidate-tradeoffs">
                <span>代价</span>{candidate.tradeoffs}
              </div>
              <ol className="candidate-steps">
                {steps.map((step, index) => (
                  <li key={step.step_no ?? index}>
                    <span className={`badge badge-${step.actor_type === 'llm' ? 'llm' : step.actor_type === 'reviewer' ? 'reviewer' : step.actor_type}`}>
                      {step.actor_type.toUpperCase()}
                    </span>
                    <span className="step-name">{step.step_name || step.actor_id}</span>
                    <code className="step-id">{step.actor_id}</code>
                  </li>
                ))}
              </ol>
              <div className="candidate-meta">
                共 {steps.length} 步 · {steps.filter((step) => step.actor_type === 'skill').length} skill / {steps.filter((step) => step.actor_type === 'tool').length} tool
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
