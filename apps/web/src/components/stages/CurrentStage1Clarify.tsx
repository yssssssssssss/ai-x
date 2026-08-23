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
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [assumptionEdits, setAssumptionEdits] = useState<Record<string, string>>(
    Object.fromEntries(response.structuredTask.assumptions.map((assumption) => [assumption.key, assumption.value])),
  );
  const missing = useMemo(
    () => missingBlockingAnswers(response.structuredTask, answers),
    [answers, response.structuredTask],
  );
  const submission = buildClarificationSubmission(response.structuredTask, answers, assumptionEdits);
  const requiresScenarioSelection = response.planningGuidance?.reasonCode === 'scenario_selection_required';
  const scenarioSelectionMissing = requiresScenarioSelection && selectedScenarioId.length === 0;
  const submittingLabel = requiresScenarioSelection
    ? '正在生成候选方案…'
    : '正在提交澄清…';
  let submitButtonLabel = '提交澄清并更新候选方案';
  if (disabled) submitButtonLabel = submittingLabel;
  else if (missing.length > 0) submitButtonLabel = `请回答全部必答问题（还缺 ${missing.length} 项）`;
  else if (scenarioSelectionMissing) submitButtonLabel = '请选择一个研究方向';
  else if (requiresScenarioSelection) submitButtonLabel = '确认方向并生成候选方案';

  return (
    <section className="stage-card" aria-labelledby="current-clarify-title">
      <Header
        n="1"
        title={requiresScenarioSelection ? '选择研究方向' : '澄清需求'}
        note={requiresScenarioSelection
          ? '请选择最符合本次目标的方向，再生成候选方案'
          : '先确认系统缺少的信息，再生成候选方案'}
      />
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

      {response.structuredTask.clarification_questions.map((question) => question.key === 'outcome_mode' ? (
        <fieldset key={question.key} disabled={disabled} style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
          <legend style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: 13 }}>{question.question}</legend>
          <span style={{ display: 'block', marginBottom: 8, color: 'var(--text-faint)', fontSize: 12 }}>为什么要问：{question.rationale}</span>
          <div style={{ display: 'grid', gap: 8 }}>
            {[
              { value: 'plan', label: '研究方案', description: '告诉我后续如何开展研究' },
              { value: 'answer', label: '直接策略答案', description: '基于当前资料给出结论、策略与行动' },
            ].map((option) => (
              <label key={option.value} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', border: `1px solid ${answers[question.key] === option.value ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 8 }}>
                <input type="radio" name={`outcome-${response.task.id}`} value={option.value} checked={answers[question.key] === option.value} onChange={(event) => setAnswers((previous) => ({ ...previous, [question.key]: event.target.value }))} />
                <span><b>{option.label}</b><span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{option.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <label key={question.key} style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          <span style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>{question.question}</span>
          <span style={{ display: 'block', marginBottom: 5, color: 'var(--text-faint)', fontSize: 12 }}>为什么要问：{question.rationale}</span>
          <input
            className="clarification-field"
            value={answers[question.key] ?? ''}
            onChange={(event) => setAnswers((previous) => ({ ...previous, [question.key]: event.target.value }))}
            disabled={disabled}
            placeholder="请明确回答，系统建议不会自动代替你的回答"
            aria-label={question.question}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
      ))}

      {response.planningGuidance && (
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
          <legend style={{ marginBottom: 8, fontSize: 13, fontWeight: 600 }}>本次研究更接近哪个方向？</legend>
          <div style={{ display: 'grid', gap: 8 }}>
            {response.planningGuidance.options.map((option) => (
              <label
                key={option.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '10px 12px',
                  border: `1px solid ${selectedScenarioId === option.id ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 8,
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                <input
                  type="radio"
                  name={`scenario-${response.task.id}`}
                  value={option.id}
                  checked={selectedScenarioId === option.id}
                  onChange={(event) => setSelectedScenarioId(event.target.value)}
                />
                <span style={{ fontSize: 13 }}>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {response.structuredTask.assumptions.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>系统假设（可编辑）</b>
          {response.structuredTask.assumptions.map((assumption) => (
            <label key={assumption.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
              <span style={{ width: 100, color: 'var(--text-faint)' }}>{assumption.key}</span>
              <input
                className="clarification-field"
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
      {disabled && (
        <p role="status" aria-live="polite" style={{ margin: '0 0 10px', color: 'var(--text-dim)', fontSize: 13 }}>
          {requiresScenarioSelection
            ? '已确认研究方向，正在生成候选方案，通常需要几分钟，请稍候。'
            : '正在提交澄清内容，请稍候。'}
        </p>
      )}
      <button
        type="button"
        disabled={disabled || missing.length > 0 || scenarioSelectionMissing}
        aria-busy={disabled}
        onClick={() => onSubmit({
          expectedVersion: response.task.stateVersion,
          ...submission,
          ...(selectedScenarioId ? { selectedScenarioId } : {}),
        })}
      >
        {submitButtonLabel}
      </button>
    </section>
  );
}
