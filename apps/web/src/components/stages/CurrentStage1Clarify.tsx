import { useEffect, useMemo, useState } from 'react';
import { isClarificationQuestionRequired } from '../../../../../packages/api-contract/plan.ts';
import type { ClarificationRequiredResponse, ClarifyControlTaskRequest } from '../../api/client.ts';
import { buildClarificationSubmission, missingBlockingAnswers } from '../../current-flow-state.ts';
import { Header } from './Stage1Understand.tsx';

interface ClarificationChoice {
  value: string;
  label: string;
  description: string;
}

const TASK_TYPE_LABELS: Readonly<Record<string, string>> = {
  competitive_research: '竞品研究',
  user_research_planning: '用户研究规划',
  research_synthesis: '研究综合',
  voc_diagnosis: '用户声音诊断',
  design_audit: '设计体验诊断',
  a11y_audit: '无障碍诊断',
  industry_market_analysis: '行业市场分析',
};

function userFacingClarificationOption(option: string): string {
  return /上传.*(?:截图|图片)|(?:截图|图片).*上传/u.test(option)
    ? option.replace(/我(?:现在|先)?上传/u, '我可以在下一步上传')
    : option;
}

function clarificationChoices(key: string): ClarificationChoice[] | null {
  if (key === 'outcome_mode') {
    return [
      { value: 'plan', label: '研究方案', description: '告诉我后续如何开展研究' },
      { value: 'answer', label: '直接策略答案', description: '基于当前资料给出结论、策略与行动' },
    ];
  }
  if (key === 'deliverable_intent') {
    return [
      { value: 'competitive_analysis_report', label: '竞品分析报告', description: '聚焦品牌或产品对比、差异和机会点' },
      { value: 'research_strategy_report', label: '综合策略报告', description: '综合多类研究证据形成策略与行动建议' },
    ];
  }
  return null;
}

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
          {response.structuredTask.business_domain} · {TASK_TYPE_LABELS[response.structuredTask.task_type] ?? '专业分析'}
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
        const choices = clarificationChoices(question.key);
        return (
          <div key={question.key} className="clarification-question">
            <div className="clarification-question-heading">
              <span>{question.question}</span>
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
            {choices ? (
              <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
                  {question.question}
                </legend>
                <div style={{ display: 'grid', gap: 8 }}>
                  {choices.map((option) => (
                    <label key={option.value} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', border: `1px solid ${answer === option.value ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 8 }}>
                      <input
                        type="radio"
                        name={`${question.key}-${response.task.id}`}
                        value={option.value}
                        checked={answer === option.value}
                        onChange={(event) => setAnswers((previous) => ({ ...previous, [question.key]: event.target.value }))}
                      />
                      <span><b>{option.label}</b><span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{option.description}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <>
                {question.options && question.options.length > 0 && (
                  <>
                    <div className="clarification-options" aria-label={`${question.question}快捷选项`}>
                      {question.options.map((option) => {
                        const displayOption = userFacingClarificationOption(option);
                        return (
                          <button
                            key={option}
                            type="button"
                            className="clarification-option"
                            aria-pressed={answer === displayOption}
                            onClick={() => setAnswers((previous) => ({ ...previous, [question.key]: displayOption }))}
                            disabled={disabled}
                          >
                            {displayOption}
                          </button>
                        );
                      })}
                    </div>
                    {question.options.some((option) => /上传.*(?:截图|图片)|(?:截图|图片).*上传/u.test(option)) ? (
                      <small style={{ color: 'var(--text-faint)' }}>
                        选择后，图片选择按钮会在下一步的计划确认页出现；此处不会立即上传文件。
                      </small>
                    ) : null}
                  </>
                )}
                <input
                  id={inputId}
                  className="clarification-field"
                  value={answer}
                  onChange={(event) => setAnswers((previous) => ({ ...previous, [question.key]: event.target.value }))}
                  disabled={disabled}
                  placeholder={required ? '请输入答案，或采用上方建议' : '可选，可直接跳过'}
                  aria-label={question.question}
                  aria-required={required}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </>
            )}
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
          {response.structuredTask.assumptions.map((assumption, index) => (
            <label key={assumption.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
              <span style={{ width: 100, color: 'var(--text-faint)' }}>补充条件 {index + 1}</span>
              <input
                className="clarification-field"
                value={assumptionEdits[assumption.key] ?? assumption.value}
                disabled={disabled || !assumption.editable}
                onChange={(event) => setAssumptionEdits((previous) => ({ ...previous, [assumption.key]: event.target.value }))}
                aria-label={`编辑补充条件 ${index + 1}`}
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
