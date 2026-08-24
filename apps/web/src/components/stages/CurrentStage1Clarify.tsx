import { useEffect, useMemo, useState } from 'react';
import { isClarificationQuestionRequired } from '../../../../../packages/api-contract/plan.ts';
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
  useEffect(() => {
    setAnswers({});
    setAssumptionEdits(Object.fromEntries(
      response.structuredTask.assumptions.map((assumption) => [assumption.key, assumption.value]),
    ));
  }, [response.task.id, response.task.stateVersion]);
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

      {response.structuredTask.clarification_questions.map((question, index) => {
        const required = isClarificationQuestionRequired(response.structuredTask, question);
        const answer = answers[question.key] ?? '';
        const inputId = `clarification-answer-${index}`;
        return (
          <div key={question.key} className="clarification-question">
            <div className="clarification-question-heading">
              <label htmlFor={inputId}>{question.question}</label>
              <span className={`clarification-requirement ${required ? 'is-required' : 'is-optional'}`}>
                {required ? '必答' : '可选'}
              </span>
            </div>
            <span className="clarification-rationale">为什么要问：{question.rationale}</span>
            {question.suggestion && (
              <div className="clarification-suggestion">
                <span>系统建议：{question.suggestion}</span>
                <button
                  type="button"
                  className="clarification-suggestion-action"
                  onClick={() => setAnswers((previous) => ({ ...previous, [question.key]: question.suggestion! }))}
                  disabled={disabled}
                >
                  采用建议
                </button>
                <small>不会自动提交</small>
              </div>
            )}
            {question.options && question.options.length > 0 && (
              <div className="clarification-options" aria-label={`${question.question}快捷选项`}>
                {question.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="clarification-option"
                    aria-pressed={answer === option}
                    onClick={() => setAnswers((previous) => ({ ...previous, [question.key]: option }))}
                    disabled={disabled}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <input
              id={inputId}
              className="clarification-field"
              value={answer}
              onChange={(event) => setAnswers((previous) => ({ ...previous, [question.key]: event.target.value }))}
              disabled={disabled}
              placeholder={required ? '请输入答案，或采用上方建议' : '可选，可直接跳过'}
              aria-required={required}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        );
      })}

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
