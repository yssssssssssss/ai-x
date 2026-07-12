import { useState } from 'react';

// 工具箱:统一入口,内嵌各 external-tools/*-lab 自带前端(通道 B「Web 单独调用」)。
// 每个工具是独立服务,门户不重写其 UI,只用 iframe 内嵌 / 新标签打开。
// dev 端口对应各工具 package.json 的 vite --port。
type Lab = { id: string; name: string; desc: string; url: string };

const LABS: Lab[] = [
  { id: 'aesthetic-quant-lab', name: '美学量化实验室', desc: '设计稿色彩/构图/对比度美学量化打分,可选注意力热区', url: 'http://127.0.0.1:5801' },
  { id: 'attention-analysis-lab', name: '视觉注意力分析', desc: '注意力热力图、热点、焦点平衡与干扰风险评分', url: 'http://127.0.0.1:5802' },
  { id: 'experience-model-lab', name: '体验模型实验室', desc: '按研究诉求匹配 HEART/GSM/Kano 等体验模型与问卷', url: 'http://127.0.0.1:5803' },
  { id: 'virtual-user-lab', name: '虚拟用户实验室', desc: '数字人格模拟评审(模型推演,非真实用户)', url: 'http://127.0.0.1:5804' },
  { id: 'vision-brand-lab', name: '视觉品牌实验室', desc: '多角色视觉评审 + 品牌联想一致性打分', url: 'http://127.0.0.1:5805' },
];

export function Labs() {
  const [active, setActive] = useState<Lab | null>(null);

  if (active) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <button className="btn-ghost" onClick={() => setActive(null)}>← 工具箱</button>
          <strong style={{ fontSize: 14 }}>{active.name}</strong>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{active.url}</span>
          <a className="btn-ghost" href={active.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 12 }}>
            新标签打开 ↗
          </a>
        </div>
        <iframe
          title={active.name}
          src={active.url}
          style={{ flex: 1, border: 'none', width: '100%' }}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>工具箱</h1>
      <p style={{ color: 'var(--text-dim)', marginBottom: 24 }}>
        各能力实验室可单独调用。点击卡片在此内嵌打开,或用「新标签打开」独立使用。
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
        {LABS.map((lab) => (
          <button
            key={lab.id}
            onClick={() => setActive(lab)}
            style={{
              textAlign: 'left', background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: 16, cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{lab.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>{lab.desc}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 10 }}>{lab.id}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
