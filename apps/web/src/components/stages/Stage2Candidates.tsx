import type { PlanCandidate } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

// 段2a · 待选方案:横排 N 张候选卡,展示 rationale + tradeoffs + 步骤概览。
// 选中回调交给上层触发 /select;loading 时禁用点击并在选中卡显示 spinner。
export function Stage2Candidates({
  candidates, onSelect, selectedId, loading,
}: {
  candidates: PlanCandidate[];
  onSelect: (id: PlanCandidate['id']) => void;
  selectedId?: PlanCandidate['id'];
  loading?: boolean;
}) {
  return (
    <section className="stage-card">
      <Header n="2" title="待选执行方案" note="选一份继续,可对比差异后再定" />
      <div className="candidate-grid">
        {candidates.map((c) => {
          const active = selectedId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              disabled={loading}
              onClick={() => onSelect(c.id)}
              className={`candidate-card${active ? ' is-active' : ''}`}
            >
              <div className="candidate-head">
                <span className={`candidate-tag tag-${c.id}`}>{c.id === 'depth' ? '深度优先' : '速度优先'}</span>
                <b className="candidate-title">{c.title}</b>
                {active && loading && <span className="spinner" style={{ marginLeft: 'auto' }} />}
              </div>
              <p className="candidate-rationale">{c.rationale}</p>
              <div className="candidate-tradeoffs">
                <span>代价</span>{c.tradeoffs}
              </div>
              <ol className="candidate-steps">
                {c.steps.map((s, i) => (
                  <li key={s.step_no ?? i}>
                    <span className={`badge badge-${s.actor_type === 'llm' ? 'llm' : s.actor_type === 'reviewer' ? 'reviewer' : s.actor_type}`}>
                      {s.actor_type.toUpperCase()}
                    </span>
                    <span className="step-name">{s.step_name || s.actor_id}</span>
                    <code className="step-id">{s.actor_id}</code>
                  </li>
                ))}
              </ol>
              <div className="candidate-meta">
                共 {c.steps.length} 步 · {countActor(c.steps, 'skill')} skill / {countActor(c.steps, 'tool')} tool
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function countActor(steps: PlanCandidate['steps'], type: string): number {
  return steps.filter((s) => s.actor_type === type).length;
}
