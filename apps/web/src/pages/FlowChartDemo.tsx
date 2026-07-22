import { useState } from 'react';
import { FlowChart } from '../components/FlowChart.tsx';

// ---- Demo Scenes ----
type DemoScene = 'idle' | 'planning' | 'picking' | 'executing' | 'paused' | 'done' | 'error';

const SCENES: Record<DemoScene, { label: string; desc: string }> = {
  idle: { label: '空闲', desc: '系统等待用户输入' },
  planning: { label: '规划中', desc: '正在理解需求 → 激活节点 → 召回知识 → 生成方案' },
  picking: { label: '方案选择', desc: '规划完成,Reply 已就绪,用户正在选择候选方案' },
  executing: { label: '执行中', desc: 'Gateway → Memory → LLM Agent → Tools 活跃调用' },
  paused: { label: '暂停(失败)', desc: 'Tools 执行失败,等待用户决策' },
  done: { label: '完成', desc: '全链路执行完毕 → Trace/Eval/Quality Gate 通过 → 报告合成' },
  error: { label: '错误', desc: 'LLM Agent 异常' },
};

export function FlowChartDemo() {
  const [scene, setScene] = useState<DemoScene>('executing');

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)', padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 12px' }}>Architecture FlowChart Demo</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(Object.keys(SCENES) as DemoScene[]).map((key) => (
            <button
              key={key}
              onClick={() => setScene(key)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: scene === key ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                background: scene === key ? 'var(--primary-tint)' : 'transparent',
                color: scene === key ? 'var(--primary-strong)' : 'var(--text-dim)',
                fontSize: 13,
                fontWeight: scene === key ? 600 : 400,
              }}
            >
              {SCENES[key].label}
            </button>
          ))}
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
          {SCENES[scene].desc}
        </p>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <FlowChart phase={scene} />
      </div>
    </div>
  );
}
