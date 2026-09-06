import { useRef, useState, type FormEvent } from 'react';
import {
  api,
  type SkillNativeCandidateView,
  type SkillNativeInputAnswer,
  type SkillNativeTaskView,
  type SkillNativeZeroPublication,
} from '../api/client.ts';
import type { SkillNativePhase } from '../hooks/useSkillNativeFlow.ts';

export function SkillNativeTaskFlow({
  phase,
  task,
  reportHtml,
  error,
  zeroPublicationEnabled,
  onSelect,
  onConfirm,
  onExecute,
  onCancel,
  onRetry,
  onReplan,
  onPublishZero,
}: {
  phase: SkillNativePhase;
  task: SkillNativeTaskView | null;
  reportHtml: string | null;
  error: string;
  zeroPublicationEnabled: boolean;
  onSelect: (candidateId: string) => Promise<void>;
  onConfirm: (answers: Record<string, SkillNativeInputAnswer>) => Promise<void>;
  onExecute: () => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: (answers?: Record<string, SkillNativeInputAnswer>) => Promise<void>;
  onReplan: () => Promise<void>;
  onPublishZero: () => Promise<SkillNativeZeroPublication | null>;
}) {
  if (phase === 'loading-task' || phase === 'planning') return <Notice text="正在分析需求并匹配 Skill 包…" loading />;
  if (!task) return error ? <ErrorCard message={error} /> : null;
  const selected = task.candidates.find(({ candidateId }) => candidateId === task.selectedCandidateId) ?? null;
  const asksRuntimeQuestions = phase === 'waiting-for-user'
    || (phase === 'paused' && task.pendingQuestions.length > 0);
  return (
    <>
      <RequirementCard task={task} />
      {phase === 'picking' ? <CandidateCards candidates={task.candidates} error={error} onSelect={onSelect} /> : null}
      {phase === 'planned' && selected ? (
        <PlanConfirmation candidate={selected} error={error} onConfirm={onConfirm} />
      ) : null}
      {task.plan ? <FrozenPlan task={task} /> : null}
      {phase === 'ready' ? (
        <section className="stage-card">
          <h2>计划已确认</h2>
          <p>完整 Skill 包和执行顺序已经冻结，可以开始执行。</p>
          <button className="btn-primary" type="button" onClick={() => { void onExecute(); }}>开始执行</button>
        </section>
      ) : null}
      {task.plan && ['executing', 'waiting-for-user', 'paused', 'failed', 'cancelled', 'done'].includes(phase) ? (
        <ExecutionCard task={task} phase={phase} />
      ) : null}
      {phase === 'executing' ? (
        <section className="stage-card">
          <Notice text="Agent 正按 Skill 包执行，过程与 Artifact 会逐步保存。" loading />
          <button className="btn-ghost" type="button" onClick={() => { void onCancel(); }}>取消任务</button>
        </section>
      ) : null}
      {asksRuntimeQuestions ? (
        <RuntimeQuestions task={task} error={error} onResume={onRetry} onReplan={onReplan} />
      ) : null}
      {((phase === 'paused' && !asksRuntimeQuestions) || phase === 'failed') ? (
        <section className="stage-card">
          <h2>{phase === 'paused' ? '执行已中断' : '执行失败'}</h2>
          <p>{task.failure ?? '可以从冻结快照恢复，或读取最新 Skill 包重新规划。'}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" type="button" onClick={() => { void onRetry(); }}>恢复</button>
            <button className="btn-ghost" type="button" onClick={() => { void onReplan(); }}>重新规划</button>
          </div>
        </section>
      ) : null}
      {phase === 'cancelled' ? <Notice text="任务已取消。" /> : null}
      {phase === 'done' && task.result ? (
        <ReportFrame
          task={task}
          html={reportHtml}
          error={error}
          zeroPublicationEnabled={zeroPublicationEnabled}
          onPublishZero={onPublishZero}
        />
      ) : null}
      {phase === 'done' ? (
        <section className="stage-card">
          <button className="btn-ghost" type="button" onClick={() => { void onReplan(); }}>读取最新 Skill 包重新规划</button>
        </section>
      ) : null}
      {error && !asksRuntimeQuestions && !['picking', 'planned', 'done'].includes(phase) ? <ErrorCard message={error} /> : null}
    </>
  );
}

function RequirementCard({ task }: { task: SkillNativeTaskView }) {
  return (
    <section className="stage-card">
      <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>研究需求 · {task.orchestrationMode === 'single_skill' ? '单 Skill' : '多 Skill'}</div>
      <p style={{ marginBottom: 0 }}>{task.originalInput}</p>
    </section>
  );
}

function CandidateCards({
  candidates,
  error,
  onSelect,
}: {
  candidates: SkillNativeCandidateView[];
  error: string;
  onSelect: (candidateId: string) => Promise<void>;
}) {
  return (
    <section className="stage-card">
      <h2>选择执行方案</h2>
      {error ? <ErrorCard message={error} /> : null}
      <div style={{ display: 'grid', gap: 12 }}>
        {candidates.map((candidate) => (
          <article key={candidate.candidateId} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <strong>{candidate.title}</strong>
              {candidate.recommended ? <span className="badge">推荐</span> : null}
            </div>
            <p style={{ color: 'var(--text-dim)' }}>{candidate.description}</p>
            <ol>{candidate.skills.map((skill) => (
              <li key={skill.skillId}>{skill.name} · {skill.description}</li>
            ))}</ol>
            <p style={{ fontSize: 13 }}><strong>取舍：</strong>{candidate.tradeoffs}</p>
            <button className="btn-primary" type="button" onClick={() => { void onSelect(candidate.candidateId); }}>选择此方案</button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PlanConfirmation({
  candidate,
  error,
  onConfirm,
}: {
  candidate: SkillNativeCandidateView;
  error: string;
  onConfirm: (answers: Record<string, SkillNativeInputAnswer>) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      await onConfirm({});
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="stage-card">
      <h2>确认执行计划</h2>
      <p>{candidate.rationale}</p>
      <p style={{ color: 'var(--text-dim)' }}>确认后会冻结这些 Skill 包的全部文件。Skill 私有问题将在执行到对应步骤时再询问。</p>
      {error ? <ErrorCard message={error} /> : null}
      <button className="btn-primary" type="button" disabled={submitting} onClick={() => { void submit(); }}>
        {submitting ? '确认中…' : '确认并冻结 Skill 包'}
      </button>
    </section>
  );
}

function RuntimeQuestions({
  task,
  error,
  onResume,
  onReplan,
}: {
  task: SkillNativeTaskView;
  error: string;
  onResume: (answers?: Record<string, SkillNativeInputAnswer>) => Promise<void>;
  onReplan: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const missing = task.pendingQuestions.filter(({ required, id, answerType }) => (
      required && (answerType === 'file' ? !files[id] : !values[id]?.trim())
    ));
    if (missing.length > 0) {
      setLocalError(`请回答：${missing.map(({ prompt }) => prompt).join('、')}`);
      return;
    }
    setSubmitting(true);
    setLocalError('');
    try {
      const answers: Record<string, SkillNativeInputAnswer> = Object.fromEntries(Object.entries(values)
        .filter(([, value]) => value.trim())
        .map(([id, value]) => [id, { source: 'conversation' as const, value: value.trim() }]));
      for (const [id, file] of Object.entries(files)) {
        if (!file) continue;
        const image = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
        const supportedText = ['text/plain', 'text/csv', 'text/markdown', 'text/tab-separated-values', 'application/json'];
        const mediaType = file.type || 'text/plain';
        if (!image && !supportedText.includes(mediaType)) {
          throw new Error(`不支持的文件类型：${mediaType}`);
        }
        answers[id] = {
          source: 'upload',
          value: image
            ? { name: file.name, mediaType, dataUrl: await fileDataUrl(file) }
            : { name: file.name, mediaType, content: await file.text() },
        };
      }
      await onResume(answers);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : '文件读取失败');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="stage-card">
      <h2>Skill 需要补充信息</h2>
      <form onSubmit={(event) => { void submit(event); }} style={{ display: 'grid', gap: 14 }}>
        {task.pendingQuestions.map((question) => (
          <label key={question.id} style={{ display: 'grid', gap: 6 }}>
            <span>{question.prompt}{question.required ? ' *' : ''}</span>
            {question.answerType === 'choice' ? (
              <select value={values[question.id] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}>
                <option value="">请选择</option>
                {(question.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : question.answerType === 'file' ? (
              <input
                type="file"
                accept=".txt,.md,.csv,.tsv,.json,image/png,image/jpeg,image/webp"
                onChange={(event) => setFiles((current) => ({ ...current, [question.id]: event.target.files?.[0] ?? null }))}
              />
            ) : (
              <textarea rows={3} value={values[question.id] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))} />
            )}
          </label>
        ))}
        {(localError || error) ? <ErrorCard message={localError || error} /> : null}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" type="submit" disabled={submitting}>{submitting ? '继续中…' : '提交并继续执行'}</button>
          <button className="btn-ghost" type="button" onClick={() => { void onReplan(); }}>需求方向已变化，重新规划</button>
        </div>
      </form>
    </section>
  );
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function FrozenPlan({ task }: { task: SkillNativeTaskView }) {
  if (!task.plan) return null;
  return (
    <section className="stage-card">
      <h2>冻结 Plan</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>{task.plan.title} · {task.plan.mode === 'single_skill' ? '单 Skill' : '多 Skill'}</div>
      <ol>{task.plan.invocations.map((invocation) => (
        <li key={invocation.id}>
          <strong>{invocation.name}</strong> · 包 hash {invocation.packageHash.slice(0, 20)}…
          {invocation.dependsOn.length > 0 ? ` · 依赖 ${invocation.dependsOn.join('、')}` : ''}
        </li>
      ))}</ol>
    </section>
  );
}

function ExecutionCard({ task, phase }: { task: SkillNativeTaskView; phase: SkillNativePhase }) {
  const state = new Map(task.executionSteps.map((step) => [step.invocationId, step]));
  return (
    <section className="stage-card">
      <h2>执行进度</h2>
      <ol style={{ display: 'grid', gap: 8 }}>
        {task.plan!.invocations.map((invocation) => {
          const step = state.get(invocation.id);
          return (
            <li key={invocation.id}>
              <strong>{invocation.name}</strong> · {step?.state ?? (phase === 'done' ? '完成' : '等待')}
              {step ? ` · ${step.turn} 轮` : ''}{step?.error ? ` · ${step.error}` : ''}
            </li>
          );
        })}
      </ol>
      {task.artifacts.length > 0 ? (
        <div>
          <h3>Artifacts</h3>
          <ul>{task.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <a href={`/api/research-tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}`} target="_blank" rel="noreferrer">{artifact.fileName}</a>
              {' '}· {artifact.role} · {artifact.mediaType}
            </li>
          ))}</ul>
        </div>
      ) : null}
    </section>
  );
}

function ReportFrame({
  task,
  html,
  error,
  zeroPublicationEnabled,
  onPublishZero,
}: {
  task: SkillNativeTaskView;
  html: string | null;
  error: string;
  zeroPublicationEnabled: boolean;
  onPublishZero: () => Promise<SkillNativeZeroPublication | null>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [publishing, setPublishing] = useState(false);
  const [publication, setPublication] = useState<SkillNativeZeroPublication | null>(null);
  const primary = task.artifacts.find(({ id }) => id === task.result?.primaryArtifactId);
  async function downloadMarkdown(): Promise<void> {
    const blob = await api.researchReportMarkdown(task.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = primary?.fileName ?? 'research-report.md';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function publishZero(): Promise<void> {
    setPublishing(true);
    try {
      setPublication(await onPublishZero());
    } finally {
      setPublishing(false);
    }
  }
  return (
    <section className="stage-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 14, flexWrap: 'wrap' }}>
        <strong>主要交付物</strong>
        <span className="badge">{task.result?.status}</span>
        {primary ? <a className="btn-ghost" href={`/api/research-tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(primary.id)}`} download={primary.fileName}>下载原文件</a> : null}
        {primary?.mediaType === 'text/markdown' ? <button className="btn-ghost" type="button" onClick={() => { void downloadMarkdown(); }}>下载 Markdown</button> : null}
        <button className="btn-ghost" type="button" disabled={!html} onClick={() => frame.current?.contentWindow?.print()}>打印</button>
        {zeroPublicationEnabled ? (
          <button className="btn-ghost" type="button" disabled={publishing || !html} onClick={() => { void publishZero(); }}>
            {publishing ? '发布中…' : '发布到 Zero'}
          </button>
        ) : null}
      </div>
      {task.result?.summary ? <p style={{ padding: '0 14px' }}>{task.result.summary}</p> : null}
      {publication ? <div style={{ padding: '0 14px 12px', color: 'var(--text-dim)' }}>已发布到 {publication.pageName}</div> : null}
      {error ? <ErrorCard message={error} /> : null}
      {html ? (
        <iframe ref={frame} title="研究报告" srcDoc={html} sandbox="allow-modals" style={{ width: '100%', minHeight: '80vh', border: 0, background: '#fff' }} />
      ) : <Notice text="该交付物没有 Web 预览，请下载原文件。" />}
    </section>
  );
}

function Notice({ text, loading = false }: { text: string; loading?: boolean }) {
  return <div style={{ padding: 16, color: 'var(--text-dim)' }}>{loading ? <span className="spinner" /> : null} {text}</div>;
}

function ErrorCard({ message }: { message: string }) {
  return <div role="alert" style={{ color: 'var(--danger)', padding: 12, border: '1px solid var(--danger)', borderRadius: 10 }}>{message}</div>;
}
