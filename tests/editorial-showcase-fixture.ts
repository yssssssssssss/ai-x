import {
  createEditorialMaterialUnitId,
  type EditorialMaterial,
  type EditorialMaterialUnit,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { buildEditorialHtmlSourcePacket } from '../apps/orchestrator-runtime/src/report/editorial-html-source-packet.ts';
import { loadEditorialPresentationBrief } from '../apps/orchestrator-runtime/src/report/editorial-presentation-brief.ts';

const PACKAGE_HASH = `sha256:${'a'.repeat(64)}` as const;
const DELIVERABLE_HASH = `sha256:${'b'.repeat(64)}` as const;
const EVIDENCE_HASH = `sha256:${'c'.repeat(64)}` as const;
const PACKAGE_ID = '44444444-4444-4444-8444-444444444444';
const DELIVERABLE_ID = '55555555-5555-4555-8555-555555555555';
const EVIDENCE_ARTIFACT_ID = '66666666-6666-4666-8666-666666666666';

function unit(input: {
  pointer: string;
  value: string | number;
  role: EditorialMaterialUnit['role'];
  groupId: string;
  epistemicStatus?: 'fact' | 'inference' | 'unknown';
  metricEligible?: boolean;
  unit?: string;
  basisUnitIds?: string[];
  evidenceIds?: string[];
  questionIds?: string[];
  requiredInBody?: boolean;
}): EditorialMaterialUnit {
  const base = {
    id: createEditorialMaterialUnitId({
      sourceArtifactId: DELIVERABLE_ID,
      sourceArtifactContentSha256: DELIVERABLE_HASH,
      sourceJsonPointer: input.pointer,
      role: input.role,
      value: input.value,
    }),
    groupId: input.groupId,
    value: input.value,
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    metricEligible: input.metricEligible ?? false,
    sourceRefs: [{ artifactId: DELIVERABLE_ID, jsonPointer: input.pointer }] as const,
    basisUnitIds: input.basisUnitIds ?? [],
    evidenceIds: input.evidenceIds ?? [],
    questionIds: input.questionIds ?? [],
    requiredInOutput: true,
    requiredInBody: input.requiredInBody ?? true,
  };
  if (input.role === 'claim') return { ...base, role: 'claim', epistemicStatus: input.epistemicStatus ?? 'inference' };
  if (input.role === 'recommendation') return { ...base, role: 'recommendation', epistemicStatus: 'inference' };
  if (input.role === 'risk' || input.role === 'validation') return { ...base, role: input.role, epistemicStatus: 'unknown' };
  return { ...base, role: input.role };
}

export function showcaseFixture() {
  const title = unit({ pointer: '/payload/title', value: '宠物食品心智设计表达研究', role: 'context', groupId: 'research-plan' });
  const goal = unit({ pointer: '/payload/researchGoal', value: '连接认知、种草、搜索与购买链路', role: 'context', groupId: 'research-plan' });
  const method = unit({ pointer: '/methodSummary', value: '基于公开资料与用户访谈', role: 'context', groupId: 'method' });
  const fact = unit({
    pointer: '/findingGraph/findings/0/statement', value: '<内容平台>会影响用户后续求证', role: 'claim',
    epistemicStatus: 'fact', groupId: 'finding:f1', evidenceIds: ['E1'], questionIds: ['Q1'],
  });
  const analysis = unit({
    pointer: '/findingGraph/analyses/0/statement', value: '跨场域表达需要保持一致', role: 'claim',
    epistemicStatus: 'inference', groupId: 'analysis:a1', basisUnitIds: [fact.id], questionIds: ['Q1'],
  });
  const action = unit({
    pointer: '/recommendations/0/statement', value: '建立跨平台信息承接', role: 'recommendation',
    groupId: 'recommendation:r1', basisUnitIds: [analysis.id], questionIds: ['Q1'],
  });
  const sampleLabel = unit({
    pointer: '/payload/competitorSampling/strategy', value: '分层目的抽样', role: 'audit',
    groupId: 'research-sampling', requiredInBody: false,
  });
  const metric = unit({
    pointer: '/payload/competitorSampling/targetCount', value: 8, role: 'context', groupId: 'research-sampling',
    metricEligible: true, unit: '个', basisUnitIds: [sampleLabel.id],
  });
  const scopeMarket = unit({
    pointer: '/payload/scope/market', value: '目标市场', role: 'context', groupId: 'research-scope',
  });
  const scopeSubject = unit({
    pointer: '/payload/scope/subjects/0', value: '目标用户', role: 'context', groupId: 'research-scope',
  });
  const deliverableOne = unit({
    pointer: '/payload/deliverables/0', value: '完整研究报告', role: 'context', groupId: 'research-deliverable:0',
  });
  const deliverableTwo = unit({
    pointer: '/payload/deliverables/1', value: '策略地图', role: 'context', groupId: 'research-deliverable:1',
  });
  const dimensionName = unit({
    pointer: '/payload/comparisonDimensions/0/name', value: '分析维度', role: 'audit',
    groupId: 'research-dimension:D1', requiredInBody: false,
  });
  const dimensionPurpose = unit({
    pointer: '/payload/comparisonDimensions/0/purpose', value: '覆盖关键分析目标', role: 'audit',
    groupId: 'research-dimension:D1', basisUnitIds: [dimensionName.id], requiredInBody: false,
  });
  const dimensionField = unit({
    pointer: '/payload/comparisonDimensions/0/collectionFields/0', value: '关键采集字段', role: 'audit',
    groupId: 'research-dimension:D1', basisUnitIds: [dimensionName.id], requiredInBody: false,
  });
  const methodOne = unit({
    pointer: '/payload/analysisMethods/0', value: '主题分析', role: 'audit',
    groupId: 'research-method:0', requiredInBody: false,
  });
  const methodTwo = unit({
    pointer: '/payload/analysisMethods/1', value: '旅程分析', role: 'audit',
    groupId: 'research-method:1', requiredInBody: false,
  });
  const questionOne = unit({
    pointer: '/payload/researchQuestions/0', value: '品牌心智如何贯穿四链路', role: 'context', groupId: 'research-question:0',
  });
  const questionTwo = unit({
    pointer: '/payload/researchQuestions/1', value: '猫狗品类表达如何形成差异', role: 'context', groupId: 'research-question:1',
  });
  const questionThree = unit({
    pointer: '/payload/researchQuestions/2', value: '不同场域如何承接用户决策', role: 'context', groupId: 'research-question:2',
  });
  const phaseOne = unit({ pointer: '/payload/executionPlan/0/phase', value: '桌面研究', role: 'context', groupId: 'research-phase:0' });
  const phaseOneAction = unit({
    pointer: '/payload/executionPlan/0/activities/0', value: '建立分析框架', role: 'recommendation',
    groupId: 'research-phase:0', basisUnitIds: [phaseOne.id],
  });
  const phaseOneDuration = unit({
    pointer: '/payload/executionPlan/0/duration', value: '第一阶段周期', role: 'audit',
    groupId: 'research-phase:0', basisUnitIds: [phaseOne.id], requiredInBody: false,
  });
  const phaseOneOutput = unit({
    pointer: '/payload/executionPlan/0/outputs/0', value: '分析框架产物', role: 'audit',
    groupId: 'research-phase:0', basisUnitIds: [phaseOne.id], requiredInBody: false,
  });
  const phaseTwo = unit({ pointer: '/payload/executionPlan/1/phase', value: '用户研究', role: 'context', groupId: 'research-phase:1' });
  const phaseTwoAction = unit({
    pointer: '/payload/executionPlan/1/activities/0', value: '完成访谈与任务回溯', role: 'recommendation',
    groupId: 'research-phase:1', basisUnitIds: [phaseTwo.id],
  });
  const phaseTwoDuration = unit({
    pointer: '/payload/executionPlan/1/duration', value: '第二阶段周期', role: 'audit',
    groupId: 'research-phase:1', basisUnitIds: [phaseTwo.id], requiredInBody: false,
  });
  const phaseTwoOutput = unit({
    pointer: '/payload/executionPlan/1/outputs/0', value: '访谈分析产物', role: 'audit',
    groupId: 'research-phase:1', basisUnitIds: [phaseTwo.id], requiredInBody: false,
  });
  const validationOne = unit({
    pointer: '/payload/qualityChecks/0', value: '结论必须绑定证据', role: 'validation', groupId: 'research-quality:0',
  });
  const validationTwo = unit({
    pointer: '/payload/qualityChecks/1', value: '风险必须明确披露', role: 'validation', groupId: 'research-quality:1',
  });
  const risk = unit({
    pointer: '/risksAndOpenIssues/0', value: '猫狗品类差异仍需验证', role: 'risk',
    groupId: 'risk:0', basisUnitIds: [fact.id], questionIds: ['Q1'],
  });
  const audit = unit({
    pointer: '/payload/sourcePlan/0/purpose', value: '记录完整来源审计', role: 'audit',
    groupId: 'research-source:0', requiredInBody: false,
  });
  const material: EditorialMaterial = {
    version: 'editorial-material-v1',
    taskId: '11111111-1111-4111-8111-111111111111',
    planVersionId: '22222222-2222-4222-8222-222222222222',
    attemptId: '33333333-3333-4333-8333-333333333333',
    deliverableType: 'research_plan',
    presentationMode: 'current_text',
    sourceReportPackage: {
      artifactId: PACKAGE_ID, kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: PACKAGE_HASH,
    },
    sourceArtifacts: [{
      artifactId: PACKAGE_ID, kind: 'report_package', schemaVersion: 'report-package-v1', contentSha256: PACKAGE_HASH,
    }, {
      artifactId: DELIVERABLE_ID, kind: 'deliverable', schemaVersion: 'research-deliverable-v1-review-gated', contentSha256: DELIVERABLE_HASH,
    }, {
      artifactId: EVIDENCE_ARTIFACT_ID, kind: 'tool_output', schemaVersion: 'tool-output-v1', contentSha256: EVIDENCE_HASH,
    }],
    materializationWarningCodes: [],
    titleUnitId: title.id,
    methodSummaryUnitId: method.id,
    units: [
      title, goal, method, fact, analysis, action, sampleLabel, metric, scopeMarket, scopeSubject,
      deliverableOne, deliverableTwo, dimensionName, dimensionPurpose, dimensionField, methodOne, methodTwo,
      questionOne, questionTwo, questionThree,
      phaseOne, phaseOneAction, phaseOneDuration, phaseOneOutput,
      phaseTwo, phaseTwoAction, phaseTwoDuration, phaseTwoOutput,
      validationOne, validationTwo, risk, audit,
    ],
    assets: [],
    evidence: [{
      id: 'E1', kind: 'tool_output', evidenceClass: 'public_source',
      artifactId: EVIDENCE_ARTIFACT_ID, artifactContentSha256: EVIDENCE_HASH,
      jsonPointer: '/results/0', sensitivity: 'public', redaction: 'none',
      toolId: 'tavily-web-search', toolTier: 'core',
      toolProof: { implementationId: 'tavily-real', executionMode: 'real', redactedOutputHash: `sha256:${'d'.repeat(64)}` },
      sourceUrl: 'https://example.com/report',
    }],
  };
  const sourcePacket = buildEditorialHtmlSourcePacket({
    material,
    presentationBrief: loadEditorialPresentationBrief().brief,
  }).packet;
  return {
    material,
    sourcePacket,
    ids: {
      title: title.id, goal: goal.id, method: method.id, fact: fact.id, analysis: analysis.id,
      action: action.id, sampleLabel: sampleLabel.id, metric: metric.id,
      scopeMarket: scopeMarket.id, scopeSubject: scopeSubject.id,
      deliverableOne: deliverableOne.id, deliverableTwo: deliverableTwo.id,
      dimensionName: dimensionName.id, dimensionPurpose: dimensionPurpose.id, dimensionField: dimensionField.id,
      methodOne: methodOne.id, methodTwo: methodTwo.id,
      questionOne: questionOne.id, questionTwo: questionTwo.id, questionThree: questionThree.id,
      phaseOne: phaseOne.id, phaseOneAction: phaseOneAction.id,
      phaseOneDuration: phaseOneDuration.id, phaseOneOutput: phaseOneOutput.id,
      phaseTwo: phaseTwo.id, phaseTwoAction: phaseTwoAction.id,
      phaseTwoDuration: phaseTwoDuration.id, phaseTwoOutput: phaseTwoOutput.id,
      validationOne: validationOne.id, validationTwo: validationTwo.id, risk: risk.id, audit: audit.id,
    },
  };
}
