import { useState } from 'react';
import type { PlanResponse, PlanStep, PendingUpload, Upload } from '../../api/client.ts';
import { pendingImageUploads } from '../../pending-upload-values.ts';
import { Header } from './Stage1Understand.tsx';

// 段2 · 待执行计划(HITL 硬闸门):步骤列表 + 假设可就地编辑 + 待传图片 + 确认按钮。
// locked=true 时(已进入执行)隐藏确认按钮、禁用编辑。
export function Stage2Plan({
  plan, locked, onConfirm,
}: {
  plan: PlanResponse;
  locked: boolean;
  onConfirm: (confirmationAnswers: Record<string, unknown>, uploads: Upload[]) => void;
}) {
  const confirmations = confirmationRequirements('confirmations' in plan.task
    ? plan.task.confirmations
    : plan.task.clarification_questions);
  const [assumptions, setAssumptions] = useState(plan.task.assumptions);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [images, setImages] = useState<Record<string, string[]>>({});

  function edit(key: string, value: string) {
    setAssumptions((prev) => prev.map((a) => (a.key === key ? { ...a, value } : a)));
  }

  function readImage(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  async function pickImages(pu: PendingUpload, files: File[]): Promise<void> {
    const selected = pu.multiple ? files : files.slice(0, 1);
    const dataUrls = (await Promise.all(selected.map(readImage))).filter(Boolean);
    setImages((previous) => ({ ...previous, [pu.role]: dataUrls }));
  }

  function confirm() {
    if (missingAnswers.length > 0) return;
    const uploads: Upload[] = pendingImageUploads(pending, images);
    setConfirmed(true);
    onConfirm(answers, uploads);
  }

  const pending = plan.pendingUploads ?? [];
  const missingAnswers = confirmations.filter(({ key }) => !answers[key]?.trim());

  return (
    <section className="stage-card">
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

      {confirmations.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 8 }}>确认项（必须由你明确回答）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {confirmations.map((confirmation) => (
              <label key={confirmation.key} style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
                <span>{confirmation.question ?? confirmation.key}</span>
                {confirmation.suggestion !== undefined && (
                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                    建议（不会自动采用）：{formatSuggestion(confirmation.suggestion)}
                  </span>
                )}
                <input
                  required
                  disabled={locked || confirmed}
                  value={answers[confirmation.key] ?? ''}
                  onChange={(event) => setAnswers((previous) => ({
                    ...previous,
                    [confirmation.key]: event.target.value,
                  }))}
                  placeholder="请输入你的明确回答"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13 }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {pending.length > 0 && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待上传图片(同一张图会自动用于所有需要它的步骤;不传将跳过该项)</div>
          {pending.map((pu) => (
            <div key={pu.role} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-dim)', flex: 1 }}>
                {pu.label}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · 用于步骤 {pu.targets.map((t) => t.step_no).join('/')}</span>
              </span>
              {(images[pu.role] ?? []).map((dataUrl, index) => (
                <img key={`${pu.role}-${index}`} src={dataUrl} alt="" style={{ height: 34, borderRadius: 4, border: '1px solid var(--border)' }} />
              ))}
              <input
                type="file"
                accept="image/*"
                multiple={pu.multiple}
                onChange={(event) => {
                  void pickImages(pu, Array.from(event.currentTarget.files ?? []));
                }}
                style={{ fontSize: 12, color: 'var(--text-dim)' }}
              />
            </div>
          ))}
        </div>
      )}

      {!locked && !confirmed && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 18 }}>
          <button className="btn-primary" onClick={confirm} disabled={missingAnswers.length > 0}>
            ✓ 确认计划,开始执行
          </button>
          {missingAnswers.length > 0 && (
            <span role="alert" style={{ color: 'var(--warn)', fontSize: 12 }}>
              请先回答全部确认项：{missingAnswers.map(({ question, key }) => question ?? key).join('、')}
            </span>
          )}
        </div>
      )}
      {(locked || confirmed) && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ok)' }}>✓ 计划已确认,进入执行</div>
      )}
    </section>
  );
}

interface ConfirmationRequirement {
  key: string;
  question?: string;
  suggestion?: unknown;
}

function confirmationRequirements(values: unknown[]): ConfirmationRequirement[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as { key?: unknown; question?: unknown; suggestion?: unknown };
    if (typeof candidate.key !== 'string' || candidate.key.trim() === '') return [];
    return [{
      key: candidate.key,
      question: typeof candidate.question === 'string' ? candidate.question : undefined,
      suggestion: candidate.suggestion,
    }];
  });
}

function formatSuggestion(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value);
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
