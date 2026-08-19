import type { ResearchTaskData, ResearchTaskV2 } from '../../api/client.ts';

// 段1 · 任务理解:展示结构化 ResearchTask + 激活的决策节点。诚实标注"由 LLM 结构化"。
export function Stage1Understand({ task, activatedNodes }: { task: ResearchTaskData | ResearchTaskV2; activatedNodes: string[] }) {
  return (
    <section className="stage-card">
      <Header n="1" title="任务理解" note="由 LLM 结构化为 ResearchTask" />
      <Row label="任务类型"><code>{task.task_type}</code></Row>
      <Row label="业务场域"><code>{task.business_domain}</code></Row>
      <Row label="研究目标">{task.research_goal}</Row>
      <Row label="激活决策节点">
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          按 task_type 过滤,{activatedNodes.length} 个 · {activatedNodes.join(' / ')}
        </span>
      </Row>
      {task.assumptions.length > 0 && (
        <Row label="系统假设">
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)' }}>
            {task.assumptions.map((a) => (
              <li key={a.key}><b style={{ color: 'var(--text)' }}>{a.key}</b>: {a.value}</li>
            ))}
          </ul>
        </Row>
      )}
    </section>
  );
}

export function Header({ n, title, note }: { n: string; title: string; note?: string }) {
  return (
    <div className="stage-header">
      <span className="stage-number">{n}</span>
      <b className="stage-title">{title}</b>
      {note && <span className="stage-note">· {note}</span>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 13.5 }}>
      <span style={{ width: 92, flexShrink: 0, color: 'var(--text-faint)' }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
