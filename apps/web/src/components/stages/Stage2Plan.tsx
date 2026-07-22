import { useState } from 'react';
import { api, ApiError, type MediaAssetRef, type PlanResponse, type PlanStep, type PendingUpload, type Upload } from '../../api/client.ts';
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
  const [images, setImages] = useState<Record<string, Array<{ asset: MediaAssetRef; previewUrl: string }>>>({});
  const [uploadingRole, setUploadingRole] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState('');

  function edit(key: string, value: string) {
    setAssumptions((prev) => prev.map((a) => (a.key === key ? { ...a, value } : a)));
  }

  async function pickImages(pu: PendingUpload, files: File[]) {
    if (!files.length) return;
    setUploadingRole(pu.role);
    setUploadError('');
    try {
      const selected = files.slice(0, pu.maxItems);
      const uploaded = await Promise.all(selected.map(async (file) => ({
        asset: await api.uploadMedia(plan.taskId, pu.role, file),
        previewUrl: URL.createObjectURL(file),
      })));
      setImages((prev) => {
        for (const old of prev[pu.role] ?? []) URL.revokeObjectURL(old.previewUrl);
        return { ...prev, [pu.role]: uploaded };
      });
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : '图片上传失败');
    } finally {
      setUploadingRole(null);
    }
  }

  function confirm() {
    const uploads: Upload[] = pending.flatMap((pu) =>
      (images[pu.role] ?? []).map(({ asset }) => ({ role: pu.role, assetId: asset.id })),
    );
    setConfirmed(true);
    onConfirm(uploads);
  }

  const pending = plan.pendingUploads ?? [];
  const allUploaded = pending.every((pu) => !pu.required || (images[pu.role]?.length ?? 0) >= pu.minItems);
  const uploading = uploadingRole !== null;

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

      {pending.length > 0 && !locked && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: allUploaded ? 'var(--text-faint)' : 'var(--warn, #e67e22)', marginBottom: 6 }}>参考图片</div>
          {pending.map((pu) => (
            <div key={pu.role} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-dim)', flex: 1 }}>
                {pu.label} {pu.required ? '(必填)' : '(可选)'}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · 用于步骤 {pu.targets.map((t) => t.step_no).join('/')}</span>
              </span>
              {(images[pu.role] ?? []).map(({ asset, previewUrl }) => (
                <img key={asset.id} src={previewUrl} alt="" style={{ height: 34, borderRadius: 4, border: '1px solid var(--border)' }} />
              ))}
              <input
                type="file"
                accept={pu.acceptedMimeTypes.join(',')}
                multiple={pu.multiple}
                disabled={uploading}
                onChange={(e) => void pickImages(pu, Array.from(e.target.files ?? []))}
                style={{ fontSize: 12, color: 'var(--text-dim)' }}
              />
              {uploadingRole === pu.role && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>上传中...</span>}
            </div>
          ))}
          {uploadError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{uploadError}</div>}
        </div>
      )}

      {!locked && !confirmed && (
        <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center' }}>
          <button className="btn-primary" onClick={confirm} disabled={!allUploaded || uploading}>
            ✓ 确认计划,开始执行
          </button>
          {!allUploaded && (
            <span style={{ fontSize: 12, color: 'var(--warn, #e67e22)' }}>
              请先上传所有必需图片({pending.filter((pu) => pu.required && (images[pu.role]?.length ?? 0) < pu.minItems).length} 项待上传)
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
