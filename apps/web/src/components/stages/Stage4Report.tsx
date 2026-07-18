import { useState } from 'react';
import { api, type Report } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

const SRC_LABEL: Record<string, string> = {
  user_input: '用户输入', knowledge_base: '知识库', tool_result: 'Tool 结果',
  llm_inference: 'LLM 推断', pending_human_review: '待人工确认',
};

// 段4 · 交付:可落地方案。findings 带来源标注,附时间线/产出物/能力编排 + 反馈入口。
export function Stage4Report({ report, taskId }: { report: Report | null; taskId: string }) {
  if (!report) {
    return (
      <section className="stage-card">
        <Header n="4" title="交付方案" />
        <div style={{ color: 'var(--text-dim)' }}>报告未生成</div>
      </section>
    );
  }
  return (
    <section className="stage-card">
      <Header n="4" title="交付方案" note="每条结论带来源标注" />

      <Block title="研究目标">{report.research_goal}</Block>

      <Block title="关键结论">
        {report.findings.map((f, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            {f.statement}
            <span className={`src-tag src-${f.source}`}>{SRC_LABEL[f.source] ?? f.source}</span>
          </div>
        ))}
      </Block>

      {report.timeline?.length > 0 && (
        <Block title="执行时间线">
          {report.timeline.map((t, i) => (
            <div key={i}><code>{t.phase}</code> · {t.activity}</div>
          ))}
        </Block>
      )}

      {report.deliverables?.length > 0 && (
        <Block title="产出物清单">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{report.deliverables.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </Block>
      )}

      {report.capability_orchestration?.length > 0 && (
        <Block title="能力编排">
          {report.capability_orchestration.map((c, i) => (
            <div key={i}>
              <span className={`badge badge-${c.capability_type === 'skill' ? 'skill' : 'tool'}`}>{c.capability_type.toUpperCase()}</span>{' '}
              <code style={{ fontSize: 11 }}>{c.capability_id}</code> — {c.purpose}
            </div>
          ))}
        </Block>
      )}

      {report.risks_and_open_issues && report.risks_and_open_issues.length > 0 && (
        <Block title="风险与待确认">
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--warn)' }}>
            {report.risks_and_open_issues.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </Block>
      )}

      <Feedback taskId={taskId} />
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 14, lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

function Feedback({ taskId }: { taskId: string }) {
  const [done, setDone] = useState(false);
  if (done) return <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ok)' }}>✓ 感谢反馈</div>;
  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, alignItems: 'center' }}>
      <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>这份方案有用吗?</span>
      <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
        onClick={() => api.feedback(taskId, { rating: 5, adopted: true }).then(() => setDone(true)).catch(() => setDone(true))}>
        👍 采纳
      </button>
      <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
        onClick={() => api.feedback(taskId, { rating: 2, adopted: false }).then(() => setDone(true)).catch(() => setDone(true))}>
        👎 待改进
      </button>
    </div>
  );
}
