import { useEffect, useState } from 'react';
import type { PlanProgress } from '../api/client.ts';

const PHASES: Array<{
  phase: PlanProgress['phase'];
  planningLabel: string;
  clarificationLabel: string;
}> = [
  { phase: 'understand', planningLabel: '理解任务需求', clarificationLabel: '已确认研究方向' },
  { phase: 'activate', planningLabel: '激活决策节点', clarificationLabel: '匹配规划节点' },
  { phase: 'guidance', planningLabel: '召回方法论知识', clarificationLabel: '召回研究方法' },
  { phase: 'states', planningLabel: '判定节点状态', clarificationLabel: '构建问题与证据框架' },
  { phase: 'candidates', planningLabel: '生成候选方案', clarificationLabel: '生成并校验候选方案' },
  { phase: 'persist', planningLabel: '归档计划', clarificationLabel: '保存候选方案' },
];

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} 分` : `${minutes} 分 ${remainder} 秒`;
}

function ElapsedTime() {
  const [startedAt] = useState(() => Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return <span aria-hidden="true">已等待 {formatElapsed(elapsedSeconds)}</span>;
}

export function PlanProgressCard({
  steps,
  variant = 'planning',
}: {
  steps: PlanProgress[];
  variant?: 'planning' | 'clarification';
}) {
  const byPhase = new Map(steps.map((step) => [step.phase, step]));
  const visiblePhases = variant === 'clarification'
    ? PHASES
    : PHASES.filter(({ phase }) => byPhase.has(phase) || phase === 'understand');
  const completedCount = visiblePhases.filter(
    ({ phase }) => byPhase.get(phase)?.status === 'done',
  ).length;
  const explicitActiveIndex = visiblePhases.findIndex(
    ({ phase }) => byPhase.get(phase)?.status === 'start',
  );
  const lastDoneIndex = visiblePhases.reduce(
    (last, { phase }, index) => byPhase.get(phase)?.status === 'done' ? index : last,
    -1,
  );
  const activeIndex = explicitActiveIndex >= 0
    ? explicitActiveIndex
    : completedCount < visiblePhases.length ? Math.min(lastDoneIndex + 1, visiblePhases.length - 1) : -1;
  const activePhase = activeIndex >= 0 ? visiblePhases[activeIndex] : null;
  const activeEvent = activePhase ? byPhase.get(activePhase.phase) : undefined;
  const activeLabel = activePhase
    ? variant === 'clarification' ? activePhase.clarificationLabel : activeEvent?.label ?? activePhase.planningLabel
    : '规划已完成';

  return (
    <section
      className="stage-card plan-progress-card"
      aria-labelledby="plan-progress-title"
      aria-busy="true"
    >
      <div className="plan-progress-heading">
        <b id="plan-progress-title" className="plan-progress-title" data-text="AI 规划中">AI 规划中</b>
        <span className="plan-progress-subtitle">正在把研究方向转换为可执行方案</span>
      </div>
      <div className="plan-progress-meta">
        <span>{completedCount}/{visiblePhases.length} 步完成</span>
        <span aria-hidden="true">·</span>
        <ElapsedTime />
      </div>
      <ol className="plan-progress-list">
        {visiblePhases.map((definition, index) => {
          const event = byPhase.get(definition.phase);
          const done = event?.status === 'done';
          const active = index === activeIndex;
          const state = done ? 'done' : active ? 'active' : 'pending';
          const label = variant === 'clarification'
            ? definition.clarificationLabel
            : event?.label ?? definition.planningLabel;
          return (
            <li
              key={definition.phase}
              className={`plan-progress-step plan-progress-step-${state}`}
              data-phase={definition.phase}
            >
              <span className={`plan-progress-node plan-progress-node-${state}`} aria-hidden="true">
                {done ? '✓' : active ? <span className="plan-progress-node-loader" /> : null}
              </span>
              <div className="plan-progress-copy">
                <span className="plan-progress-step-label">{label}</span>
                {event?.detail ? <span className="plan-progress-detail">{event.detail}</span> : null}
              </div>
              <span className="plan-progress-state">
                {done ? '已完成' : active ? '处理中' : '等待'}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {completedCount}/{visiblePhases.length} 步完成，当前{activeLabel}
      </p>
    </section>
  );
}
