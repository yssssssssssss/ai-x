import { useEffect, useMemo, useState } from 'react';
import {
  isClarificationQuestionRequired,
  type ResearchTaskV2,
} from '../../../../../packages/api-contract/plan.ts';
import type {
  ClarificationRequiredResponse,
  ClarifyControlTaskRequest,
  TaskMaterialResponse,
} from '../../api/client.ts';
import { buildClarificationSubmission, missingBlockingAnswers } from '../../current-flow-state.ts';
import { Header } from './Stage1Understand.tsx';

interface ClarificationChoice {
  value: string;
  label: string;
  description: string;
}

interface VisualPairDraft {
  label: string;
  primaryMaterialId: string;
  comparisonMaterialId: string;
}

const EMPTY_TASK_MATERIALS: TaskMaterialResponse[] = [];

function materialsForRequest(
  request: NonNullable<ResearchTaskV2['material_requests']>[number],
  materials: readonly TaskMaterialResponse[],
  bindings: ClarifyControlTaskRequest['materialBindings'],
): TaskMaterialResponse[] {
  const boundIds = bindings === undefined
    ? null
    : new Set(bindings.find((binding) => binding.requestId === request.id)?.materialIds ?? []);
  const matches = materials.filter((material) => (
    material.requestId === request.id
    && (boundIds === null || boundIds.has(material.materialId))
  ));
  return request.multiple ? matches : matches.slice(-1);
}

function reconcileVisualPairs(
  previous: readonly VisualPairDraft[],
  primary: readonly TaskMaterialResponse[],
  comparison: readonly TaskMaterialResponse[],
): VisualPairDraft[] {
  const rowCount = Math.max(primary.length, comparison.length);
  return Array.from({ length: rowCount }, (_, index) => {
    const existing = previous[index];
    const primaryMaterialId = existing
      && primary.some(({ materialId }) => materialId === existing.primaryMaterialId)
      ? existing.primaryMaterialId
      : primary[index]?.materialId ?? '';
    const comparisonMaterialId = existing
      && comparison.some(({ materialId }) => materialId === existing.comparisonMaterialId)
      ? existing.comparisonMaterialId
      : comparison[index]?.materialId ?? '';
    return {
      label: existing?.label.trim() ? existing.label : `对比项 ${index + 1}`,
      primaryMaterialId,
      comparisonMaterialId,
    };
  });
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
  materials,
  onUploadMaterial,
  onSubmit,
  disabled = false,
}: {
  response: ClarificationRequiredResponse;
  materials?: TaskMaterialResponse[];
  onUploadMaterial?: (
    requestId: string,
    role: string,
    file: File,
    multiple: boolean,
  ) => Promise<TaskMaterialResponse>;
  onSubmit: (request: Omit<ClarifyControlTaskRequest, 'idempotencyKey'>) => void;
  disabled?: boolean;
}) {
  const availableMaterials = materials ?? response.taskMaterials ?? EMPTY_TASK_MATERIALS;
  const materialRequests = response.structuredTask.material_requests ?? [];
  const storedComparison = response.materialComparison;
  const comparisonRequests = useMemo(() => {
    if (!response.structuredTask.expected_deliverables.includes('competitive_analysis_report')) return null;
    const multipleVisualRequests = materialRequests.filter((request) => request.multiple);
    if (storedComparison) {
      const primary = multipleVisualRequests.find(({ id }) => id === storedComparison.primaryRequestId);
      const comparison = multipleVisualRequests.find(({ id }) => id === storedComparison.comparisonRequestId);
      if (primary && comparison && primary.id !== comparison.id) return [primary, comparison] as const;
    }
    return multipleVisualRequests.length === 2
      ? multipleVisualRequests as [typeof multipleVisualRequests[number], typeof multipleVisualRequests[number]]
      : null;
  }, [materialRequests, response.structuredTask.expected_deliverables, storedComparison]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [selectedMaterials, setSelectedMaterials] = useState<Record<string, TaskMaterialResponse[]>>(() => (
    Object.fromEntries((response.structuredTask.material_requests ?? []).map((request) => [
      request.id,
      materialsForRequest(request, availableMaterials, response.materialBindings),
    ]))
  ));
  const [comparisonMode, setComparisonMode] = useState<'grouped' | 'paired'>(
    storedComparison?.mode ?? 'grouped',
  );
  const [visualPairs, setVisualPairs] = useState<VisualPairDraft[]>(
    storedComparison?.pairs.map((pair) => ({ ...pair })) ?? [],
  );
  const [materialErrors, setMaterialErrors] = useState<Record<string, string | undefined>>({});
  const [uploadingRequestId, setUploadingRequestId] = useState<string | null>(null);
  const [assumptionEdits, setAssumptionEdits] = useState<Record<string, string>>(
    Object.fromEntries(response.structuredTask.assumptions.map((assumption) => [assumption.key, assumption.value])),
  );
  useEffect(() => {
    setAnswers({});
    setMaterialErrors({});
    setUploadingRequestId(null);
    setComparisonMode(response.materialComparison?.mode ?? 'grouped');
    setVisualPairs(response.materialComparison?.pairs.map((pair) => ({ ...pair })) ?? []);
    setAssumptionEdits(Object.fromEntries(
      response.structuredTask.assumptions.map((assumption) => [assumption.key, assumption.value]),
    ));
  }, [response.task.id, response.task.stateVersion]);
  useEffect(() => {
    setSelectedMaterials(Object.fromEntries((response.structuredTask.material_requests ?? []).map((request) => [
      request.id,
      materialsForRequest(request, availableMaterials, response.materialBindings),
    ])));
  }, [response.task.id, response.task.stateVersion, availableMaterials, response.materialBindings]);
  const primaryMaterials = comparisonRequests
    ? selectedMaterials[comparisonRequests[0].id] ?? []
    : EMPTY_TASK_MATERIALS;
  const comparisonMaterials = comparisonRequests
    ? selectedMaterials[comparisonRequests[1].id] ?? []
    : EMPTY_TASK_MATERIALS;
  const primaryMaterialIds = primaryMaterials.map(({ materialId }) => materialId).join('|');
  const comparisonMaterialIds = comparisonMaterials.map(({ materialId }) => materialId).join('|');
  useEffect(() => {
    if (comparisonMode !== 'paired' || !comparisonRequests) return;
    setVisualPairs((previous) => reconcileVisualPairs(
      previous,
      selectedMaterials[comparisonRequests[0].id] ?? EMPTY_TASK_MATERIALS,
      selectedMaterials[comparisonRequests[1].id] ?? EMPTY_TASK_MATERIALS,
    ));
  }, [comparisonMode, comparisonRequests, primaryMaterialIds, comparisonMaterialIds, selectedMaterials]);
  const pairingIssue = useMemo(() => {
    if (comparisonMode !== 'paired' || !comparisonRequests) return null;
    const pairedPrimary = visualPairs.map(({ primaryMaterialId }) => primaryMaterialId);
    const pairedComparison = visualPairs.map(({ comparisonMaterialId }) => comparisonMaterialId);
    if (
      visualPairs.length === 0
      || visualPairs.some((pair) => !pair.label.trim() || !pair.primaryMaterialId || !pair.comparisonMaterialId)
    ) return '请为每个对比项选择两侧图片并填写场景名称';
    if (
      new Set(pairedPrimary).size !== pairedPrimary.length
      || new Set(pairedComparison).size !== pairedComparison.length
    ) return '同一张图片不能重复出现在多个对比项中';
    if (
      pairedPrimary.length !== primaryMaterials.length
      || pairedComparison.length !== comparisonMaterials.length
      || primaryMaterials.some(({ materialId }) => !pairedPrimary.includes(materialId))
      || comparisonMaterials.some(({ materialId }) => !pairedComparison.includes(materialId))
    ) return '一一配对必须完整覆盖两侧全部已选图片；数量不一致时请使用分组对比';
    return null;
  }, [comparisonMode, comparisonRequests, visualPairs, primaryMaterials, comparisonMaterials]);
  const missing = useMemo(
    () => missingBlockingAnswers(response.structuredTask, answers),
    [answers, response.structuredTask],
  );
  const missingMaterials = materialRequests.filter((request) => (
    request.required && (selectedMaterials[request.id]?.length ?? 0) === 0
  ));

  async function pickMaterial(
    request: NonNullable<ResearchTaskV2['material_requests']>[number],
    files: File[],
  ): Promise<void> {
    if (!onUploadMaterial || files.length === 0) return;
    const selected = request.multiple ? files : files.slice(0, 1);
    setUploadingRequestId(request.id);
    setMaterialErrors((previous) => ({ ...previous, [request.id]: undefined }));
    try {
      const uploaded: TaskMaterialResponse[] = [];
      for (const file of selected) {
        uploaded.push(await onUploadMaterial(request.id, request.role, file, request.multiple));
      }
      setSelectedMaterials((previous) => ({
        ...previous,
        [request.id]: request.multiple
          ? [...(previous[request.id] ?? []), ...uploaded]
          : uploaded.slice(-1),
      }));
    } catch (error) {
      setMaterialErrors((previous) => ({
        ...previous,
        [request.id]: error instanceof Error ? error.message : '图片上传失败',
      }));
    } finally {
      setUploadingRequestId(null);
    }
  }

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
                  aria-label={question.question}
                  aria-required={required}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </>
            )}
          </div>
        );
      })}

      {materialRequests.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>所需材料</b>
          <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
            {materialRequests.map((request) => {
              const selected = selectedMaterials[request.id] ?? [];
              return (
                <div key={request.id} style={{ display: 'grid', gap: 6, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                    <span><b>{request.label}</b> · {request.required ? '必需' : '可选'}</span>
                    <span style={{ color: selected.length > 0 ? 'var(--ok)' : 'var(--text-faint)' }}>
                      {selected.length > 0 ? '已提供' : '等待上传'}
                    </span>
                  </div>
                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{request.reason}</span>
                  {selected.map((material) => (
                    <div key={material.materialId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                      <span>{material.fileName}</span>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={disabled || uploadingRequestId === request.id}
                        onClick={() => setSelectedMaterials((previous) => ({
                          ...previous,
                          [request.id]: (previous[request.id] ?? []).filter(({ materialId }) => materialId !== material.materialId),
                        }))}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple={request.multiple}
                    disabled={disabled || uploadingRequestId === request.id || !onUploadMaterial}
                    aria-label={request.label}
                    onChange={(event) => {
                      void pickMaterial(request, Array.from(event.currentTarget.files ?? []));
                      event.currentTarget.value = '';
                    }}
                  />
                  {uploadingRequestId === request.id ? (
                    <span role="status" style={{ color: 'var(--text-dim)', fontSize: 12 }}>上传中…</span>
                  ) : null}
                  {materialErrors[request.id] ? (
                    <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{materialErrors[request.id]}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {comparisonRequests && (primaryMaterials.length > 0 || comparisonMaterials.length > 0) && (
            <div style={{ display: 'grid', gap: 10, marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
              <b style={{ fontSize: 13 }}>图片对比方式</b>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="radio"
                  name={`visual-comparison-mode-${response.task.id}`}
                  value="grouped"
                  checked={comparisonMode === 'grouped'}
                  disabled={disabled}
                  onChange={() => {
                    setComparisonMode('grouped');
                    setVisualPairs([]);
                  }}
                />
                <span><b>分组对比</b><small style={{ display: 'block', color: 'var(--text-faint)' }}>分别完整展示两组实际上传的图片，不推断一一对应关系。</small></span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="radio"
                  name={`visual-comparison-mode-${response.task.id}`}
                  value="paired"
                  checked={comparisonMode === 'paired'}
                  disabled={disabled}
                  onChange={() => {
                    setComparisonMode('paired');
                    setVisualPairs(reconcileVisualPairs([], primaryMaterials, comparisonMaterials));
                  }}
                />
                <span><b>一一配对</b><small style={{ display: 'block', color: 'var(--text-faint)' }}>每个对比项明确选择两侧各一张图片；文件名和上传顺序只用于预填。</small></span>
              </label>
              {comparisonMode === 'paired' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  {visualPairs.map((pair, index) => (
                    <div key={`visual-pair-${index + 1}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                      <input
                        className="clarification-field"
                        aria-label={`对比项 ${index + 1} 场景名称`}
                        value={pair.label}
                        disabled={disabled}
                        onChange={(event) => setVisualPairs((previous) => previous.map((item, itemIndex) => (
                          itemIndex === index ? { ...item, label: event.target.value } : item
                        )))}
                      />
                      <select
                        className="clarification-field"
                        aria-label={`对比项 ${index + 1} ${comparisonRequests[0].label}`}
                        value={pair.primaryMaterialId}
                        disabled={disabled}
                        onChange={(event) => setVisualPairs((previous) => previous.map((item, itemIndex) => (
                          itemIndex === index ? { ...item, primaryMaterialId: event.target.value } : item
                        )))}
                      >
                        <option value="">选择{comparisonRequests[0].label}</option>
                        {primaryMaterials.map((material) => <option key={material.materialId} value={material.materialId}>{material.fileName}</option>)}
                      </select>
                      <select
                        className="clarification-field"
                        aria-label={`对比项 ${index + 1} ${comparisonRequests[1].label}`}
                        value={pair.comparisonMaterialId}
                        disabled={disabled}
                        onChange={(event) => setVisualPairs((previous) => previous.map((item, itemIndex) => (
                          itemIndex === index ? { ...item, comparisonMaterialId: event.target.value } : item
                        )))}
                      >
                        <option value="">选择{comparisonRequests[1].label}</option>
                        {comparisonMaterials.map((material) => <option key={material.materialId} value={material.materialId}>{material.fileName}</option>)}
                      </select>
                    </div>
                  ))}
                  {pairingIssue && <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{pairingIssue}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

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
        disabled={disabled || missing.length > 0 || missingMaterials.length > 0 || pairingIssue !== null || scenarioSelectionMissing || uploadingRequestId !== null}
        aria-busy={disabled || uploadingRequestId !== null}
        onClick={() => onSubmit({
          expectedVersion: response.task.stateVersion,
          ...submission,
          ...(selectedScenarioId ? { selectedScenarioId } : {}),
          ...(materialRequests.length > 0
            ? {
                materialBindings: materialRequests.flatMap((request) => {
                  const selected = selectedMaterials[request.id] ?? [];
                  return selected.length > 0
                    ? [{ requestId: request.id, materialIds: selected.map(({ materialId }) => materialId) }]
                    : [];
                }),
              }
            : {}),
          ...(comparisonRequests && (primaryMaterials.length > 0 || comparisonMaterials.length > 0)
            ? {
                materialComparison: {
                  mode: comparisonMode,
                  primaryRequestId: comparisonRequests[0].id,
                  comparisonRequestId: comparisonRequests[1].id,
                  pairs: comparisonMode === 'paired'
                    ? visualPairs.map((pair) => ({ ...pair, label: pair.label.trim() }))
                    : [],
                },
              }
            : {}),
        })}
      >
        {missingMaterials.length > 0 ? `请先提供所需材料（还缺 ${missingMaterials.length} 项）` : submitButtonLabel}
      </button>
    </section>
  );
}
