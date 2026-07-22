import { useState, useCallback } from 'react';
import { api, getToken, type Report, type CoreIssue, type DimensionAnalysis, type Recommendation } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

const SRC_LABEL: Record<string, string> = {
  user_input: '用户输入', knowledge_base: '知识库', tool_result: 'Tool 结果',
  llm_inference: 'LLM 推断', pending_human_review: '待人工确认',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#d93025', major: '#f9ab00', minor: '#5f6368',
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  complete: { text: '完整', color: '#1e8e3e' },
  partial: { text: '部分', color: '#f9ab00' },
  data_incomplete: { text: '数据缺失', color: '#d93025' },
};

// 段4 · 交付:完整可读报告,含摘要/核心问题/维度分析/发现/时间线 + HTML下载
export function Stage4Report({ report, taskId }: { report: Report | null; taskId: string }) {
  if (!report) {
    return (
      <section className="stage-card">
        <Header n="4" title="交付报告" />
        <div style={{ color: 'var(--text-dim)' }}>报告未生成</div>
      </section>
    );
  }
  return (
    <section className="stage-card">
      <Header n="4" title="交付报告" note="完整分析报告" />

      {/* 下载按钮 */}
      <DownloadButton taskId={taskId} />

      {report.report_metadata?.generation_mode === 'mock_demo' && (
        <div style={{ marginBottom: 16, padding: '10px 14px', border: '1px solid #f9ab00', background: '#fef7e0', color: '#5f3b00', borderRadius: 6, fontSize: 13 }}>
          当前为测试/演示报告，不能作为业务结论使用。
        </div>
      )}

      {/* 研究目标 */}
      <Block title="研究目标">{report.research_goal}</Block>

      {/* 摘要 */}
      {report.executive_summary && (
        <div style={{ background: '#1a73e8', color: '#fff', padding: '16px 20px', borderRadius: 8, marginBottom: 20, fontSize: 14, lineHeight: 1.8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.85 }}>摘要</div>
          {report.executive_summary}
        </div>
      )}

      {report.evidence_summary && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20, fontSize: 12, color: 'var(--text-dim)' }}>
          <span>证据来源 {report.evidence_summary.source_count}</span>
          <span>台账条目 {report.evidence_summary.ledger_entry_count}</span>
          <span>已引用 {report.evidence_summary.cited_evidence_count}</span>
        </div>
      )}

      {/* 核心问题 */}
      {report.core_issues && report.core_issues.length > 0 && (
        <Block title="核心问题">
          {report.core_issues.map((issue, i) => (
            <IssueCard key={i} issue={issue} />
          ))}
        </Block>
      )}

      {/* 维度分析 */}
      {report.dimension_analyses && report.dimension_analyses.length > 0 && (
        <Block title="维度分析">
          {report.dimension_analyses.map((dim, i) => (
            <DimensionCard key={i} dim={dim} />
          ))}
        </Block>
      )}

      {report.recommendations && report.recommendations.length > 0 && (
        <Block title="优先行动">
          {report.recommendations.map((recommendation, i) => (
            <RecommendationCard key={i} recommendation={recommendation} />
          ))}
        </Block>
      )}

      {/* 关键发现 */}
      <Block title="关键发现">
        {report.findings.map((f, i) => (
          <div key={i} style={{ marginBottom: 8, padding: '8px 12px', background: 'var(--bg-soft)', borderRadius: 6, fontSize: 13, lineHeight: 1.7 }}>
            {f.statement}
            <span className={`src-tag src-${f.source}`} style={{ marginLeft: 8 }}>{SRC_LABEL[f.source] ?? f.source}</span>
          </div>
        ))}
      </Block>

      {/* 时间线 */}
      {report.timeline?.length > 0 && (
        <Block title="执行时间线">
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <tbody>
              {report.timeline.map((t, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '6px 10px', fontWeight: 600, width: 60, color: 'var(--text-faint)' }}>{t.phase}</td>
                  <td style={{ padding: '6px 10px' }}>{t.activity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}

      {/* 产出物 */}
      {report.deliverables?.length > 0 && (
        <Block title="产出物清单">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
            {report.deliverables.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </Block>
      )}

      {/* 能力编排(折叠) */}
      {report.capability_orchestration?.length > 0 && (
        <Collapsible title="能力编排">
          {report.capability_orchestration.map((c, i) => (
            <div key={i} style={{ marginBottom: 4, fontSize: 12, color: 'var(--text-dim)' }}>
              <span className={`badge badge-${c.capability_type === 'skill' ? 'skill' : 'tool'}`}>{c.capability_type}</span>{' '}
              <code style={{ fontSize: 11 }}>{c.capability_id}</code> — {c.purpose}
            </div>
          ))}
        </Collapsible>
      )}

      {/* 风险 */}
      {report.risks_and_open_issues && report.risks_and_open_issues.length > 0 && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: '#fef7e0', border: '1px solid #f9ab00', borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#b06d00', marginBottom: 8, textTransform: 'uppercase' }}>风险与待确认</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#5f3b00', lineHeight: 1.7 }}>
            {report.risks_and_open_issues.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      <Feedback taskId={taskId} />
    </section>
  );
}

function IssueCard({ issue }: { issue: CoreIssue }) {
  const color = SEVERITY_COLOR[issue.severity] ?? '#5f6368';
  return (
    <div style={{ marginBottom: 12, padding: '12px 16px', border: `1px solid ${color}33`, borderLeft: `4px solid ${color}`, borderRadius: 6, background: 'var(--bg-card-hi)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{issue.severity}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{issue.title}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-dim)' }}>{issue.description}</div>
      {issue.impact && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text)' }}>影响: {issue.impact}</div>}
      {issue.recommendation && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--primary-strong)' }}>建议: {issue.recommendation}</div>
      )}
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
        {issue.evidence_basis === 'inference' ? '依据: 推断，待验证' : `来源: ${issue.evidence_source ?? issue.evidence_refs?.join(', ') ?? '未标注'}`}
      </div>
    </div>
  );
}

function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const priorityColor: Record<Recommendation['priority'], string> = { P0: '#d93025', P1: '#f9ab00', P2: '#1a73e8' };
  return (
    <div style={{ marginBottom: 10, padding: '12px 16px', border: '1px solid var(--border-soft)', borderLeft: `4px solid ${priorityColor[recommendation.priority]}`, borderRadius: 6, background: 'var(--bg-card-hi)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 7 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: priorityColor[recommendation.priority] }}>{recommendation.priority}</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{recommendation.action}</span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-dim)' }}>预期影响: {recommendation.expected_impact}</div>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-dim)' }}>验证方式: {recommendation.validation}</div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
        {recommendation.evidence_basis === 'evidence' ? `证据: ${recommendation.evidence_refs?.join(', ') ?? '未标注'}` : '依据: 推断，待验证'}
      </div>
    </div>
  );
}

function DimensionCard({ dim }: { dim: DimensionAnalysis }) {
  const st = STATUS_LABEL[dim.status] ?? { text: dim.status, color: '#5f6368' };
  return (
    <div style={{ marginBottom: 12, padding: '12px 16px', border: '1px solid var(--border-soft)', borderRadius: 6, background: 'var(--bg-card-hi)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{dim.dimension}</span>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${st.color}18`, color: st.color, fontWeight: 600 }}>{st.text}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-dim)' }}>{dim.summary}</div>
      {dim.metrics && Object.keys(dim.metrics).length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {Object.entries(dim.metrics).map(([k, v]) => (
            <span key={k} style={{ fontSize: 11, padding: '3px 8px', background: 'var(--bg-elev)', borderRadius: 4, color: 'var(--text-dim)' }}>
              {k}: <strong>{typeof v === 'number' ? v.toFixed(3) : v}</strong>
            </span>
          ))}
        </div>
      )}
      {dim.data_source && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>数据源: {dim.data_source}</div>}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 14, lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ fontSize: 12, color: 'var(--text-faint)', cursor: 'pointer', marginBottom: open ? 8 : 0, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}
      >
        {open ? '▼' : '▶'} {title}
      </div>
      {open && <div style={{ fontSize: 14, lineHeight: 1.7, paddingLeft: 12 }}>{children}</div>}
    </div>
  );
}

function Feedback({ taskId }: { taskId: string }) {
  const [done, setDone] = useState(false);
  if (done) return <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ok)' }}>✓ 感谢反馈</div>;
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, alignItems: 'center' }}>
      <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>这份报告有用吗?</span>
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

function DownloadButton({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(false);
  const download = useCallback(async () => {
    setLoading(true);
    try {
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`/api/tasks/${taskId}/report.html`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-${taskId.slice(0, 8)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`下载失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [taskId]);
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
      <button
        onClick={download}
        disabled={loading}
        className="btn-primary"
        style={{ fontSize: 13, padding: '8px 16px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer' }}
      >
        {loading ? '下载中...' : '⬇ 下载完整 HTML 报告'}
      </button>
    </div>
  );
}
