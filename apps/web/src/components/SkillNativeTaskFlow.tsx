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
  onSelect: (solutionId: string) => Promise<void>;
  onConfirm: (answers: Record<string, SkillNativeInputAnswer | null>) => Promise<void>;
  onExecute: () => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
  onReplan: () => Promise<void>;
  onPublishZero: () => Promise<SkillNativeZeroPublication | null>;
}) {
  if (phase === 'loading-task' || phase === 'planning') return <Notice text="正在准备 Skill 执行方案…" loading />;
  if (!task) return error ? <ErrorCard message={error} /> : null;
  const selected = task.candidates.find(({ solutionId }) => solutionId === task.selectedSolutionId) ?? null;
  return (
    <>
      <RequirementCard task={task} />
      {phase === 'picking' ? <CandidateCards candidates={task.candidates} error={error} onSelect={onSelect} /> : null}
      {phase === 'planned' && selected ? (
        <PlanConfirmation key={`${task.id}:${task.stateVersion}`} candidate={selected} error={error} onConfirm={onConfirm} />
      ) : null}
      {task.plan ? <FrozenPlan task={task} /> : null}
      {phase === 'ready' ? (
        <section className="stage-card">
          <h2>计划已确认</h2>
          <p>Skill 定义与输入绑定已冻结，可以开始执行。</p>
          <button className="btn-primary" type="button" onClick={() => { void onExecute(); }}>开始执行</button>
        </section>
      ) : null}
      {(phase === 'executing' || phase === 'paused' || phase === 'failed' || phase === 'cancelled' || phase === 'done') && task.plan ? (
        <ExecutionCard task={task} phase={phase} />
      ) : null}
      {phase === 'executing' ? (
        <section className="stage-card"><Notice text="Skill 正在执行，结果会逐步保存。" loading /><button className="btn-ghost" type="button" onClick={() => { void onCancel(); }}>取消任务</button></section>
      ) : null}
      {(phase === 'paused' || phase === 'failed') ? (
        <section className="stage-card">
          <h2>{phase === 'paused' ? '执行已中断' : '执行失败'}</h2>
          <p>{task.failure ?? '可以使用冻结 Plan 重试，或读取最新定义重新规划。'}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" type="button" onClick={() => { void onRetry(); }}>重试</button>
            <button className="btn-ghost" type="button" onClick={() => { void onReplan(); }}>重新规划</button>
          </div>
        </section>
      ) : null}
      {phase === 'cancelled' ? <Notice text="任务已取消。" /> : null}
      {phase === 'done' && task.report ? (
        <ReportFrame task={task} html={reportHtml} error={error} onPublishZero={onPublishZero} />
      ) : null}
      {phase === 'done' ? (
        <section className="stage-card">
          <button className="btn-ghost" type="button" onClick={() => { void onReplan(); }}>读取最新 Skill 定义重新规划</button>
        </section>
      ) : null}
      {error && phase !== 'picking' && phase !== 'planned' && phase !== 'done' ? <ErrorCard message={error} /> : null}
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
  onSelect: (solutionId: string) => Promise<void>;
}) {
  return (
    <section className="stage-card">
      <h2>选择执行方案</h2>
      {error ? <ErrorCard message={error} /> : null}
      <div style={{ display: 'grid', gap: 12 }}>
        {candidates.map((candidate) => (
          <article key={candidate.solutionId} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <strong>{candidate.title}</strong>
              {candidate.recommended ? <span className="badge">推荐</span> : null}
            </div>
            <p style={{ color: 'var(--text-dim)' }}>{candidate.description}</p>
            <ol>{candidate.skills.map((skill) => (
              <li key={skill.skillId}>
                {skill.name}
                {skill.replacementSkillName ? ` · 失败或关键资料缺失时改用 ${skill.replacementSkillName}` : ''}
              </li>
            ))}</ol>
            <button className="btn-primary" type="button" onClick={() => { void onSelect(candidate.solutionId); }}>选择此方案</button>
          </article>
        ))}
      </div>
    </section>
  );
}

function hasAnswer(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : value != null;
}

function PlanConfirmation({
  candidate,
  error,
  onConfirm,
}: {
  candidate: SkillNativeCandidateView;
  error: string;
  onConfirm: (answers: Record<string, SkillNativeInputAnswer | null>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, SkillNativeInputAnswer | null>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const answers: Record<string, SkillNativeInputAnswer | null> = {};
    for (const input of candidate.resolvedInputs) {
      if (!Object.hasOwn(values, input.inputId)) continue;
      const answer = values[input.inputId];
      const requirement = candidate.inputRequirements.find(({ inputId }) => inputId === input.inputId);
      if (answer !== null && (answer === undefined || !hasAnswer(answer.value))) {
        setLocalError(`请完成纠正：${requirement?.label ?? input.inputId}`);
        return;
      }
      if (answer === null && requirement?.missingPolicy === 'stop') {
        setLocalError(`${requirement?.label ?? input.inputId}不能缺失，请提供正确内容`);
        return;
      }
      if (answer !== undefined) answers[input.inputId] = answer;
    }
    for (const question of candidate.questions) {
      const answer = values[question.inputId];
      if (answer === undefined || (answer !== null && !hasAnswer(answer.value))) {
        if (question.missingPolicy === 'stop') {
          setLocalError(`请补充：${question.label}`);
          return;
        }
        answers[question.inputId] = null;
      } else {
        answers[question.inputId] = answer;
      }
    }
    setSubmitting(true);
    setLocalError('');
    try {
      await onConfirm(answers);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="stage-card">
      <h2>确认输入与缺口</h2>
      {candidate.resolvedInputs.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>已自动绑定，可在确认前纠正</div>
          <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
            {candidate.resolvedInputs.map((input) => {
              const requirement = candidate.inputRequirements.find(({ inputId }) => inputId === input.inputId);
              const value = values[input.inputId];
              const isEditing = editing.has(input.inputId);
              return (
                <div key={input.inputId} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12 }}>
                  <div><strong>{requirement?.label ?? input.inputId}</strong> · {input.source}</div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 13, margin: '6px 0' }}>{input.preview}</div>
                  {isEditing && requirement ? (
                    <>
                      <InputQuestion
                        question={requirement}
                        value={value}
                        disabled={submitting}
                        onChange={(next) => setValues((current) => ({ ...current, [input.inputId]: next }))}
                      />
                      <button
                        className="btn-ghost"
                        type="button"
                        disabled={submitting}
                        onClick={() => {
                          setEditing((current) => {
                            const next = new Set(current);
                            next.delete(input.inputId);
                            return next;
                          });
                          setValues((current) => {
                            const next = { ...current };
                            delete next[input.inputId];
                            return next;
                          });
                        }}
                      >恢复自动绑定</button>
                    </>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      {requirement ? (
                        <button
                          className="btn-ghost"
                          type="button"
                          onClick={() => {
                            setEditing((current) => new Set(current).add(input.inputId));
                            setValues((current) => ({
                              ...current,
                              [input.inputId]: {
                                source: requirement.acceptedSources.includes('conversation') ? 'conversation' : 'upload',
                                value: requirement.multiple ? [] : '',
                              },
                            }));
                          }}
                        >纠正</button>
                      ) : null}
                      {requirement && requirement.missingPolicy !== 'stop' ? (
                        <button
                          className="btn-ghost"
                          type="button"
                          onClick={() => {
                            setEditing((current) => new Set(current).add(input.inputId));
                            setValues((current) => ({ ...current, [input.inputId]: null }));
                          }}
                        >{requirement.missingPolicy === 'replace' ? '无法提供，按方案替换 Skill' : '不使用，记为 Gap'}</button>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <form onSubmit={(event) => { void submit(event); }} style={{ display: 'grid', gap: 16 }}>
        {candidate.questions.map((question) => (
          <InputQuestion
            key={question.inputId}
            question={question}
            value={values[question.inputId]}
            disabled={submitting}
            onChange={(value) => setValues((current) => ({ ...current, [question.inputId]: value }))}
          />
        ))}
        {(localError || error) ? <ErrorCard message={localError || error} /> : null}
        <button className="btn-primary" type="submit" disabled={submitting}>{submitting ? '确认中…' : '确认 Plan 与输入'}</button>
      </form>
    </section>
  );
}

function InputQuestion({
  question,
  value,
  disabled,
  onChange,
}: {
  question: SkillNativeCandidateView['questions'][number];
  value: SkillNativeInputAnswer | null | undefined;
  disabled: boolean;
  onChange: (value: SkillNativeInputAnswer | null) => void;
}) {
  const canUpload = question.acceptedSources.includes('upload');
  const canWrite = question.acceptedSources.includes('conversation');
  const source = value?.source ?? (canWrite ? 'conversation' : 'upload');
  const canSkip = question.missingPolicy !== 'stop';
  const skipped = value === null;
  const textValue = value?.source === 'conversation'
    ? Array.isArray(value.value)
      ? value.value.filter((item): item is string => typeof item === 'string').join('\n')
      : typeof value.value === 'string' ? value.value : ''
    : '';
  return (
    <fieldset disabled={disabled} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12 }}>
      <legend style={{ padding: '0 6px' }}>{question.label}{question.required ? ' *' : ''}</legend>
      <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 8 }}>{question.question}</div>
      {canWrite && canUpload ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className={source === 'conversation' ? 'btn-primary' : 'btn-ghost'} type="button" onClick={() => onChange({ source: 'conversation', value: '' })}>输入文字</button>
          <button className={source === 'upload' ? 'btn-primary' : 'btn-ghost'} type="button" onClick={() => onChange({ source: 'upload', value: question.multiple ? [] : '' })}>上传文件</button>
        </div>
      ) : null}
      {source === 'upload' ? (
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,text/plain,text/csv,text/markdown,text/tab-separated-values,application/json"
          multiple={question.multiple}
          disabled={skipped || disabled}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            void Promise.all(files.map(async (file) => {
              const textFile = file.type.startsWith('text/') || /\.(?:csv|json|md|txt|tsv)$/iu.test(file.name);
              return {
                name: file.name,
                mediaType: file.type || (textFile ? 'text/plain' : 'application/octet-stream'),
                ...(textFile
                  ? { content: await file.text() }
                  : { dataUrl: await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(file);
                  }) }),
              };
            })).then((filesValue) => onChange({
              source: 'upload',
              value: question.multiple ? filesValue : filesValue[0],
            }));
          }}
        />
      ) : (
        <textarea
          rows={question.multiple ? 4 : 3}
          disabled={skipped || disabled}
          value={textValue}
          onChange={(event) => onChange({
            source: 'conversation',
            value: question.multiple
              ? event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
              : event.target.value,
          })}
          style={{ width: '100%', resize: 'vertical' }}
        />
      )}
      {canSkip ? (
        <label style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
          <input type="checkbox" checked={skipped} onChange={(event) => onChange(event.target.checked ? null : { source, value: source === 'upload' && question.multiple ? [] : '' })} /> {question.missingPolicy === 'replace' ? '无法提供，按方案替换 Skill' : '暂不提供，作为 Gap 继续'}
        </label>
      ) : null}
    </fieldset>
  );
}

function FrozenPlan({ task }: { task: SkillNativeTaskView }) {
  if (!task.plan) return null;
  return (
    <section className="stage-card">
      <h2>冻结 Plan</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>{task.plan.title} · {task.plan.mode === 'single_skill' ? '单 Skill' : '多 Skill'}</div>
      <ol>{task.plan.invocations.map((invocation) => (
        <li key={invocation.id}><strong>{invocation.name}</strong>{invocation.dependsOn.length > 0 ? ` · 依赖 ${invocation.dependsOn.join('、')}` : ''}</li>
      ))}</ol>
      {task.plan.requirement.gaps.length > 0 ? <p style={{ color: 'var(--warn)' }}>{task.plan.requirement.gaps.length} 项资料将作为 Gap 保留。</p> : null}
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
          return <li key={invocation.id}><strong>{invocation.name}</strong> · {step?.state ?? (phase === 'done' ? '完成' : '等待')}{step?.error ? ` · ${step.error}` : ''}</li>;
        })}
      </ol>
    </section>
  );
}

function ReportFrame({
  task,
  html,
  error,
  onPublishZero,
}: {
  task: SkillNativeTaskView;
  html: string | null;
  error: string;
  onPublishZero: () => Promise<SkillNativeZeroPublication | null>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [publishing, setPublishing] = useState(false);
  const [publication, setPublication] = useState<SkillNativeZeroPublication | null>(null);
  async function downloadMarkdown(): Promise<void> {
    const blob = await api.researchReportMarkdown(task.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'research-report.md';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  function downloadHtml(): void {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'research-report.html';
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 14 }}>
        <strong>研究报告</strong>
        <span className="badge">{task.report?.status}</span>
        <button className="btn-ghost" type="button" onClick={downloadHtml} disabled={!html}>下载 HTML</button>
        <button className="btn-ghost" type="button" onClick={() => { void downloadMarkdown(); }}>下载 Markdown</button>
        <button className="btn-ghost" type="button" onClick={() => frame.current?.contentWindow?.print()}>打印</button>
        <button className="btn-ghost" type="button" disabled={publishing} onClick={() => { void publishZero(); }}>
          {publishing ? '发布中…' : '发布到 Zero'}
        </button>
      </div>
      {publication ? <div style={{ padding: '0 14px 12px', color: 'var(--text-dim)' }}>已发布到 {publication.pageName}</div> : null}
      {error ? <ErrorCard message={error} /> : null}
      {html ? <iframe ref={frame} title="研究报告" srcDoc={html} sandbox="allow-modals allow-same-origin" style={{ width: '100%', minHeight: '80vh', border: 0, background: '#fff' }} /> : <Notice text="正在读取研究报告…" loading />}
    </section>
  );
}

function Notice({ text, loading = false }: { text: string; loading?: boolean }) {
  return <div style={{ padding: 16, color: 'var(--text-dim)' }}>{loading ? <span className="spinner" /> : null} {text}</div>;
}

function ErrorCard({ message }: { message: string }) {
  return <div role="alert" style={{ color: 'var(--danger)', padding: 12, border: '1px solid var(--danger)', borderRadius: 10 }}>{message}</div>;
}
