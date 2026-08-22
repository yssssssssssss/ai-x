import { useState } from 'react';
import {
  COMPETITIVE_WEIGHT_TITLE,
  extractCompetitiveScoringWeights,
} from '../../../../orchestrator-runtime/src/report/competitive-weight-chart.ts';
import type { CurrentPlanStep } from '../../../../../packages/api-contract/research-deliverable.ts';
import type { PlanResponse, PlanStep, PendingUpload, Upload } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';
import { buildPlanConfirmationPayload } from './stage2-plan-confirmation.ts';

// 段2 · 待执行计划(HITL 硬闸门):步骤列表 + 假设可就地编辑 + 待传图片 + 确认按钮。
// locked=true 时(已进入执行)隐藏确认按钮、禁用编辑。
export function Stage2Plan({
  plan, locked, revising, onConfirm, onRevise,
}: {
  plan: PlanResponse;
  locked: boolean;
  revising: boolean;
  onConfirm: (
    confirmationAnswers: Record<string, unknown>,
    inputValues: Record<string, unknown>,
    uploads: Upload[],
  ) => void;
  onRevise: (instruction: string) => void;
}) {
  const confirmations = 'confirmations' in plan.task
    ? confirmationRequirements(plan.task.confirmations)
    : [];
  const scoringWeights = extractCompetitiveScoringWeights(plan.plan);
  const resourceGaps = plan.plan.skill_invocations?.flatMap(({ skill_id, resource_gaps }) => (
    resource_gaps.map((gap) => ({ ...gap, skillId: skill_id }))
  )) ?? [];
  const [assumptions, setAssumptions] = useState(plan.task.assumptions);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [images, setImages] = useState<Record<string, string[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [revisionInstruction, setRevisionInstruction] = useState('');

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
    if (missingAnswers.length > 0 || missingInputs.length > 0) return;
    const payload = buildPlanConfirmationPayload({
      confirmationAnswers: answers,
      pending,
      values,
      images,
    });
    setConfirmed(true);
    onConfirm(payload.confirmationAnswers, payload.inputValues, payload.uploads);
  }

  const pending = plan.pendingUploads ?? [];
  const missingAnswers = confirmations.filter(({ key }) => !answers[key]?.trim());
  const missingInputs = pending.filter((input) => {
    if (input.kind === 'visual') return (images[input.role] ?? []).length === 0;
    if (input.kind === 'value') {
      const raw = values[input.role] ?? '';
      return input.multiple
        ? raw.split('\n').every((item) => item.trim() === '')
        : raw.trim() === '';
    }
    return true;
  });

  return (
    <section className="stage-card">
      <Header n="2" title="待执行计划" note={locked ? '计划内容已锁定' : '确认前不执行'} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {plan.plan.steps.map((s) => <StepRow key={s.step_no} step={s} />)}
      </div>

      {scoringWeights.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 6, color: 'var(--text-faint)', fontSize: 12 }}>
            {COMPETITIVE_WEIGHT_TITLE}
          </div>
          <dl style={{ margin: 0, borderTop: '1px solid var(--border-soft)' }}>
            {scoringWeights.map(({ dimension, percentage }) => (
              <div
                key={dimension}
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 13 }}
              >
                <dt style={{ minWidth: 0, color: 'var(--text-dim)' }}>{dimension}</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>{percentage}%</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {resourceGaps.length > 0 && (
        <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid rgba(251,191,36,.3)', borderRadius: 8, color: 'var(--warn)', fontSize: 12 }}>
          <strong>知识资源缺口</strong>
          {resourceGaps.map((gap) => (
            <div key={`${gap.skillId}:${gap.query_id}`}>
              {gap.skillId} · {gap.query_id}：已选 {gap.selected_items}，最低 {gap.min_items}。{gap.reason}
            </div>
          ))}
        </div>
      )}

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

      {pending.some((input) => input.kind === 'value') && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待补充输入（必须填写）</div>
          {pending.filter((input) => input.kind === 'value').map((input) => (
            <label key={input.role} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10, fontSize: 13 }}>
              <span>
                {input.label}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · 用于步骤 {input.targets.map((target) => target.step_no).join('/')}</span>
              </span>
              {input.multiple ? (
                <textarea
                  disabled={locked || confirmed}
                  value={values[input.role] ?? ''}
                  onChange={(event) => setValues((previous) => ({ ...previous, [input.role]: event.target.value }))}
                  placeholder="每行填写一个值"
                  rows={3}
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13, resize: 'vertical' }}
                />
              ) : (
                <input
                  required
                  disabled={locked || confirmed}
                  value={values[input.role] ?? ''}
                  onChange={(event) => setValues((previous) => ({ ...previous, [input.role]: event.target.value }))}
                  placeholder="请输入"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13 }}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {pending.some((input) => input.kind === 'visual') && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>待上传图片（必须上传；同一张图会自动用于所有需要它的步骤）</div>
          {pending.filter((input) => input.kind === 'visual').map((pu) => (
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
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={confirm} disabled={revising || missingAnswers.length > 0 || missingInputs.length > 0}>
              ✓ 确认计划
            </button>
            <button
              className="btn-ghost"
              onClick={() => onRevise(revisionInstruction.trim())}
              disabled={revising || revisionInstruction.trim() === ''}
            >
              {revising ? '正在重新生成…' : '重新生成计划'}
            </button>
          </div>
          <textarea
            value={revisionInstruction}
            onChange={(event) => setRevisionInstruction(event.target.value)}
            disabled={revising}
            placeholder="填写调整要求；可用 $skill-name 指定技能"
            rows={2}
            aria-label="计划调整要求"
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 13, resize: 'vertical' }}
          />
          {(missingAnswers.length > 0 || missingInputs.length > 0) && (
            <span role="alert" style={{ color: 'var(--warn)', fontSize: 12 }}>
              {missingAnswers.length > 0 && `请先回答全部确认项：${missingAnswers.map(({ question, key }) => question ?? key).join('、')}`}
              {missingAnswers.length > 0 && missingInputs.length > 0 ? '；' : ''}
              {missingInputs.length > 0 && `请先补充全部输入：${missingInputs.map((input) => input.label).join('、')}`}
            </span>
          )}
        </div>
      )}
      {(locked || confirmed) && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ok)' }}>✓ 计划已确认，内容已锁定</div>
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

function StepRow({ step }: { step: PlanStep | CurrentPlanStep }) {
  const purpose = 'purpose' in step ? step.purpose : undefined;
  const cls =
    step.actor_type === 'skill' ? 'badge-skill'
    : step.actor_type === 'tool' ? 'badge-tool'
    : step.actor_type === 'reviewer' ? 'badge-reviewer'
    : step.actor_type === 'knowledge' ? 'badge-knowledge'
    : 'badge-llm';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', background: 'var(--bg)', borderRadius: 8 }}>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 12 }}>{step.step_no}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{step.step_name}</div>
        {purpose && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{purpose}</div>}
      </div>
      <span className={`badge ${cls}`}>{step.actor_type.toUpperCase()}</span>
      <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{step.actor_id}</code>
      {step.requires_approval && <span className="badge" style={{ background: 'rgba(251,191,36,.15)', color: 'var(--warn)' }}>需审批</span>}
    </div>
  );
}
