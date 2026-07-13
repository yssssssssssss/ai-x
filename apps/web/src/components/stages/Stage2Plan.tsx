import { useState } from 'react';
import type { PlanResponse, PlanStep, PendingUpload, Upload } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

// 段2 · 待执行计划(HITL 硬闸门):步骤列表 + 假设可就地编辑 + 待传图片 + 确认按钮。
// locked=true 时(已进入执行)隐藏确认按钮、禁用编辑。
export function Stage2Plan({
  plan, locked, onConfirm,
}: {
  plan: PlanResponse; locked: boolean; onConfirm: (uploads: Upload[]) => void;
}) {
  const [assumptions, setAssumptions] = useState(plan.task.assumptions);
  const [confirmed, setConfirmed] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({}); // `${step_no}:${field}` → dataUrl

  function edit(key: string, value: string) {
    setAssumptions((prev) => prev.map((a) => (a.key === key ? { ...a, value } : a)));
  }

  function pickImage(pu: PendingUpload, file: File) {
    const reader = new FileReader();
    reader.onload = () => setImages((prev) => ({ ...prev, [`${pu.step_no}:${pu.field}`]: String(reader.result) }));
    reader.readAsDataURL(file);
  }

  function confirm() {
    const uploads: Upload[] = pending
      .map((pu) => ({ step_no: pu.step_no, field: pu.field, dataUrl: images[`${pu.step_no}:${pu.field}`] }))
      .filter((u): u is Upload => !!u.dataUrl);
    setConfirmed(true);
    onConfirm(uploads);
  }

  const pending = plan.pendingUploads ?? [];

  return (
    <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18, marginBottom: 16 }}>
      <Header n="2" title="待执行计划" note="确认前不执行" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {plan.plan.steps.map((s) => <StepRow key={s.step_no} step={s} />)}
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>系统假设(可点击编辑)</div>
        {assumptions.map((a) => (
          <div key={a.key} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 13 }}>
            <span style={{ color: 'var(--text-dim)', width: 120, flexShrink: 0 }}>{a.key}</span>
            {a.editable && !locked ? (
              <input
                value={a.value}
                onChange={(e) => edit(a.key, e.target.value)}
                style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 13 }}
              />
            ) : (
              <span style={{ flex: 1 }}>{a.value}</span>
            )}
          </div>
        ))}
      </div>

      {pending.length > 0 && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待上传设计稿(部分工具需要图像;不传将跳过该项)</div>
          {pending.map((pu) => {
            const key = `${pu.step_no}:${pu.field}`;
            return (
              <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: 'var(--text-dim)', flex: 1 }}>{pu.label}</span>
                {images[key] ? (
                  <img src={images[key]} alt="" style={{ height: 34, borderRadius: 4, border: '1px solid var(--border)' }} />
                ) : null}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) pickImage(pu, f); }}
                  style={{ fontSize: 12, color: 'var(--text-dim)' }}
                />
              </div>
            );
          })}
        </div>
      )}

      {!locked && !confirmed && (
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="btn-primary" onClick={confirm}>
            ✓ 确认计划,开始执行
          </button>
        </div>
      )}
      {(locked || confirmed) && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ok)' }}>✓ 计划已确认,进入执行</div>
      )}
    </section>
  );
}

function StepRow({ step }: { step: PlanStep }) {
  const cls =
    step.actor_type === 'skill' ? 'badge-skill'
    : step.actor_type === 'tool' ? 'badge-tool'
    : step.actor_type === 'reviewer' ? 'badge-reviewer'
    : 'badge-llm';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', background: 'var(--bg)', borderRadius: 8 }}>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 12 }}>{step.step_no}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{step.step_name}</div>
        {step.purpose && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{step.purpose}</div>}
      </div>
      <span className={`badge ${cls}`}>{step.actor_type.toUpperCase()}</span>
      <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{step.actor_id}</code>
      {step.requires_approval && <span className="badge" style={{ background: 'rgba(251,191,36,.15)', color: 'var(--warn)' }}>需审批</span>}
    </div>
  );
}
