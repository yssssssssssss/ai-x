import { useMemo, useState } from 'react';
import type { ClarificationRequiredResponse, ClarifyControlTaskRequest } from '../../api/client.ts';
import { buildClarificationSubmission, missingBlockingAnswers } from '../../current-flow-state.ts';
import { Header } from './Stage1Understand.tsx';

export function CurrentStage1Clarify({
  response,
  onSubmit,
  disabled = false,
}: {
  response: ClarificationRequiredResponse;
  onSubmit: (request: Omit<ClarifyControlTaskRequest, 'idempotencyKey'>) => void;
  disabled?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [assumptionEdits, setAssumptionEdits] = useState<Record<string, string>>(
    Object.fromEntries(response.structuredTask.assumptions.map((assumption) => [assumption.key, assumption.value])),
  );
  const missing = useMemo(
    () => missingBlockingAnswers(response.structuredTask, answers),
    [answers, response.structuredTask],
  );
  const submission = buildClarificationSubmission(response.structuredTask, answers, assumptionEdits);

  return (
    <section className="stage-card" aria-labelledby="current-clarify-title">
      <Header n="1" title="澄清需求" note="先确认系统缺少的信息，再生成候选方案" />
      <div id="current-clarify-title" style={{ fontSize: 13, marginBottom: 14 }}>
        <b>当前理解</b>
        <p style={{ margin: '6px 0', color: 'var(--text-dim)' }}>{response.structuredTask.research_goal}</p>
        <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {response.structuredTask.business_domain} · {response.structuredTask.task_type}
        </div>
      </div>

      {response.structuredTask.ambiguities.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>仍有歧义</b>
          <ul style={{ margin: '6px 0', paddingLeft: 20, color: 'var(--text-dim)', fontSize: 13 }}>
            {response.structuredTask.ambiguities.map((ambiguity) => (
              <li key={ambiguity.id}>{ambiguity.statement}{ambiguity.blocking ? '（需回答）' : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {response.structuredTask.clarification_questions.map((question) => (
        <label key={question.key} style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          <span style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>{question.question}</span>
          <span style={{ display: 'block', marginBottom: 5, color: 'var(--text-faint)', fontSize: 12 }}>为什么要问：{question.rationale}</span>
          <input
            value={answers[question.key] ?? ''}
            onChange={(event) => setAnswers((previous) => ({ ...previous, [question.key]: event.target.value }))}
            disabled={disabled}
            placeholder="请明确回答，系统建议不会自动代替你的回答"
            aria-label={question.question}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
      ))}

      {response.structuredTask.assumptions.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>系统假设（可编辑）</b>
          {response.structuredTask.assumptions.map((assumption) => (
            <label key={assumption.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
              <span style={{ width: 100, color: 'var(--text-faint)' }}>{assumption.key}</span>
              <input
                value={assumptionEdits[assumption.key] ?? assumption.value}
                disabled={disabled || !assumption.editable}
                onChange={(event) => setAssumptionEdits((previous) => ({ ...previous, [assumption.key]: event.target.value }))}
                aria-label={`编辑假设 ${assumption.key}`}
                style={{ flex: 1 }}
              />
            </label>
          ))}
        </div>
      )}

      <button
        type="button"
        disabled={disabled || missing.length > 0}
        onClick={() => onSubmit({
          expectedVersion: response.task.stateVersion,
          ...submission,
        })}
      >
        {missing.length > 0 ? `请回答全部必答问题（还缺 ${missing.length} 项）` : '提交澄清并更新候选方案'}
      </button>
    </section>
  );
}
