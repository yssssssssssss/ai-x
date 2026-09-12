import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createEditorialMaterialUnitId,
  type EditorialMaterial,
  type EditorialMaterialUnit,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { loadEditorialPresentationBrief } from '../apps/orchestrator-runtime/src/report/editorial-presentation-brief.ts';
import { buildEditorialHtmlSourcePacket } from '../apps/orchestrator-runtime/src/report/editorial-html-source-packet.ts';

const PACKAGE_HASH = `sha256:${'a'.repeat(64)}` as const;
const DELIVERABLE_HASH = `sha256:${'b'.repeat(64)}` as const;
const PACKAGE_ID = '44444444-4444-4444-8444-444444444444';
const DELIVERABLE_ID = '55555555-5555-4555-8555-555555555555';

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

function richResearchPlanMaterial(): EditorialMaterial {
  const title = unit({ pointer: '/payload/title', value: '宠物食品研究计划', role: 'context', groupId: 'research-plan' });
  const method = unit({ pointer: '/methodSummary', value: '基于公开资料与用户访谈', role: 'context', groupId: 'method' });
  const fact = unit({
    pointer: '/findingGraph/findings/0/statement', value: '用户会跨平台继续求证', role: 'claim',
    epistemicStatus: 'fact', groupId: 'finding:f1', evidenceIds: ['E1'], questionIds: ['Q1'],
  });
  const action = unit({
    pointer: '/recommendations/0/statement', value: '建立跨平台信息承接', role: 'recommendation',
    groupId: 'recommendation:r1', basisUnitIds: [fact.id], questionIds: ['Q1'],
  });
  const risk = unit({
    pointer: '/risksAndOpenIssues/0', value: '猫狗差异仍需验证', role: 'risk', groupId: 'risk:0',
    basisUnitIds: [fact.id], questionIds: ['Q1'],
  });
  const samplingLabel = unit({
    pointer: '/payload/competitorSampling/strategy', value: '分层目的抽样', role: 'context',
    groupId: 'research-sampling', requiredInBody: false,
  });
  const target = unit({
    pointer: '/payload/competitorSampling/targetCount', value: 8, role: 'context', groupId: 'research-sampling',
    metricEligible: true, unit: '个', basisUnitIds: [samplingLabel.id],
  });
  const phaseOne = unit({
    pointer: '/payload/executionPlan/0/phase', value: '桌面研究', role: 'context', groupId: 'research-phase:0',
  });
  const phaseOneAction = unit({
    pointer: '/payload/executionPlan/0/activities/0', value: '建立分析框架', role: 'recommendation',
    groupId: 'research-phase:0', basisUnitIds: [phaseOne.id],
  });
  const phaseTwo = unit({
    pointer: '/payload/executionPlan/1/phase', value: '用户研究', role: 'context', groupId: 'research-phase:1',
  });
  const phaseTwoAction = unit({
    pointer: '/payload/executionPlan/1/activities/0', value: '完成访谈与任务回溯', role: 'recommendation',
    groupId: 'research-phase:1', basisUnitIds: [phaseTwo.id],
  });
  const qualityOne = unit({
    pointer: '/payload/qualityChecks/0', value: '结论必须绑定证据', role: 'validation', groupId: 'research-quality:0',
  });
  const qualityTwo = unit({
    pointer: '/payload/qualityChecks/1', value: '风险必须明确披露', role: 'validation', groupId: 'research-quality:1',
  });
  const audit = unit({
    pointer: '/payload/sourcePlan/0/purpose', value: '记录完整来源', role: 'audit',
    groupId: 'research-source:0', requiredInBody: false,
  });
  return {
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
      artifactId: '66666666-6666-4666-8666-666666666666', kind: 'tool_output', schemaVersion: 'tool-output-v1', contentSha256: `sha256:${'c'.repeat(64)}`,
    }],
    materializationWarningCodes: [],
    titleUnitId: title.id,
    methodSummaryUnitId: method.id,
    units: [title, method, fact, action, risk, samplingLabel, target, phaseOne, phaseOneAction, phaseTwo, phaseTwoAction, qualityOne, qualityTwo, audit],
    assets: [],
    evidence: [{
      id: 'E1', kind: 'tool_output', evidenceClass: 'public_source',
      artifactId: '66666666-6666-4666-8666-666666666666', artifactContentSha256: `sha256:${'c'.repeat(64)}`,
      jsonPointer: '/results/0', sensitivity: 'public', redaction: 'none', sourceUrl: 'https://example.com/report',
    }],
  };
}

test('builds a stable coherent Source Packet with explicit groups, relations, and eligible presentations', () => {
  const material = richResearchPlanMaterial();
  const presentationBrief = loadEditorialPresentationBrief().brief;
  const first = buildEditorialHtmlSourcePacket({ material, presentationBrief });
  const second = buildEditorialHtmlSourcePacket({ material, presentationBrief });

  assert.equal(first.packet.version, 'editorial-html-source-packet-v2');
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.packet, second.packet);
  assert.equal(first.packet.binding.sourceReportPackageId, PACKAGE_ID);
  assert.equal(first.packet.report.titleUnitId, material.titleUnitId);
  assert.deepEqual(first.packet.report.requiredQuestionIds, ['Q1']);
  assert.deepEqual(first.packet.deterministicAuditUnitIds, material.units.filter((item) => !item.requiredInBody).map(({ id }) => id));
  assert.ok(first.packet.groups.some(({ id, role, sequence }) => id === 'research-phase:0' && role === 'journey' && sequence === 0));
  assert.ok(first.packet.groups.some(({ id, role }) => id === 'recommendation:r1' && role === 'action'));
  assert.ok(first.packet.relations.some(({ fromGroupId, toGroupId, kind }) => (
    fromGroupId === 'finding:f1' && toGroupId === 'recommendation:r1' && kind === 'supports'
  )));
  assert.ok(first.packet.relations.some(({ fromGroupId, toGroupId, kind }) => (
    fromGroupId === 'research-phase:0' && toGroupId === 'research-phase:1' && kind === 'sequence'
  )));
  const kinds = new Set(first.packet.visualizationCandidates.map(({ kind }) => kind));
  for (const kind of ['metric-cards', 'truth-triad', 'journey-flow', 'roadmap', 'validation-gates', 'risk-register', 'mind-model']) {
    assert.ok(kinds.has(kind as never), kind);
  }
  assert.match(first.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(first.byteSize > 0 && first.byteSize <= 512 * 1024);
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('editorial-html-source-packet-v2', first.packet));
});
