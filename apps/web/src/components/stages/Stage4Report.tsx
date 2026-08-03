import { useState } from 'react';
import { api, type Report } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';
import { SOURCE_LABEL, reportToMarkdown } from '../../report-markdown.ts';

// 段4 · 交付:需求驱动的研究报告。以研究子问题为组织轴,发现带证据编号,分析引用其依据的发现;
// 网页与导出 Markdown 同源(共用 report-markdown.ts)。旧报告(无 sub_questions)降级为扁平发现展示。
export function Stage4Report({ report, taskId }: { report: Report | null; taskId: string }) {
  if (!report) {
    return (
      <section className="stage-card">
        <Header n="4" title="研究报告" />
        <div style={{ color: 'var(--text-dim)' }}>报告未生成</div>
      </section>
    );
  }
  return (
    <section className="stage-card">
      <Header n="4" title="研究报告" note="按研究子问题组织,结论可反查证据" />

      <Block title="研究背景与目标">{report.research_goal}</Block>

      {report.method_summary && (
        <Block title="研究方法">
          <div style={{ marginBottom: 6 }}>{report.method_summary}</div>
          {report.capability_orchestration?.map((c, i) => (
            <div key={i} style={{ fontSize: 13 }}>
              <span className={`badge badge-${c.capability_type === 'skill' ? 'skill' : 'tool'}`}>{c.capability_type.toUpperCase()}</span>{' '}
              <code style={{ fontSize: 11 }}>{c.capability_id}</code> — {c.purpose}
            </div>
          ))}
        </Block>
      )}

      <Block title="关键发现">
        {report.findings.map((f) => (
          <div key={f.id} style={{ marginBottom: 6 }}>
            <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>[{f.id}]</code>{' '}
            {f.statement}
            <span className={`src-tag src-${f.source}`}>{SOURCE_LABEL[f.source] ?? f.source}</span>
            {f.source_ref && <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 6 }}>{f.source_ref}</span>}
          </div>
        ))}
      </Block>

      {report.sub_questions?.map((sq, qi) => (
        <Block key={qi} title={sq.question}>
          {sq.finding_ids?.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>
              相关发现:{sq.finding_ids.map((id) => `[${id}]`).join('')}
            </div>
          )}
          {sq.analysis.map((a, ai) => (
            <div key={ai} style={{ marginBottom: 4 }}>
              {a.statement}{' '}
              <code style={{ fontSize: 11, color: 'var(--accent)' }}>{a.based_on.map((id) => `[${id}]`).join('')}</code>
            </div>
          ))}
          <div style={{ marginTop: 6, fontWeight: 600 }}>小结:{sq.summary}</div>
        </Block>
      ))}

      {report.overall_conclusion?.length > 0 && (
        <Block title="总体结论与建议">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{report.overall_conclusion.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </Block>
      )}

      {report.risks_and_open_issues && report.risks_and_open_issues.length > 0 && (
        <Block title="风险与待验证假设">
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--warn)' }}>
            {report.risks_and_open_issues.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </Block>
      )}

      {report.deliverables?.length > 0 && (
        <Block title="产出物清单">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{report.deliverables.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </Block>
      )}

      {report.timeline?.length > 0 && (
        <Block title="执行时间线">
          {report.timeline.map((t, i) => (
            <div key={i}><code>{t.phase}</code> · {t.activity}</div>
          ))}
        </Block>
      )}

      <ExportBar report={report} />
      <Feedback taskId={taskId} />
    </section>
  );
}

function ExportBar({ report }: { report: Report }) {
  function download() {
    const blob = new Blob([reportToMarkdown(report)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `研究报告-${report.research_goal.slice(0, 20)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div style={{ marginTop: 16 }}>
      <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={download}>
        ⬇ 导出 Markdown
      </button>
    </div>
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
