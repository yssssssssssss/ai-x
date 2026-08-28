import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDITORIAL_MODEL_EGRESS_POLICY,
  NO_EDITORIAL_MODEL_PORT,
  canonicalEditorialJson,
  canonicalSha256,
  computeEligibleCompositionKinds,
  createEditorialGenerationId,
  createEditorialMaterialUnitId,
  createEditorialRequestKey,
  editorialCanonicalHash,
  evaluateEditorialModelEgress,
  formatEditorialRatio,
  hashBytes,
  hasEditorialSensitiveToken,
  normalizeEditorialScalar,
  parseEditorialBlueprint,
  parseEditorialDiagnostic,
  parseEditorialFidelityReview,
  parseEditorialFidelityReviewPlan,
  parseEditorialMaterial,
  parseEditorialReport,
  projectEditorialModelContext,
  buildDeterministicEditorialBlueprint,
  buildEditorialFidelityReview,
  enumerateEditorialParaphrases,
  validateEditorialBlueprint,
  validateEditorialRenderTrace,
  type EditorialBlueprint,
  type EditorialMaterial,
  type EditorialMaterialUnit,
  type EditorialRenderTrace,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';

const ZERO_HASH = `sha256:${'0'.repeat(64)}` as const;
const ONE_HASH = `sha256:${'1'.repeat(64)}` as const;
const TWO_HASH = `sha256:${'2'.repeat(64)}` as const;

function unit(input: Omit<EditorialMaterialUnit, 'id' | 'sourceRefs'> & {
  pointer: string;
  sourceArtifactId?: string;
}): EditorialMaterialUnit {
  const sourceArtifactId = input.sourceArtifactId ?? 'artifact-deliverable';
  const sourceRefs = [{ artifactId: sourceArtifactId, jsonPointer: input.pointer }] as const;
  const candidate = {
    ...input,
    sourceRefs,
  };
  delete (candidate as { pointer?: string }).pointer;
  delete (candidate as { sourceArtifactId?: string }).sourceArtifactId;
  return {
    ...candidate,
    id: createEditorialMaterialUnitId({
      sourceArtifactId,
      sourceArtifactContentSha256: ONE_HASH,
      sourceJsonPointer: input.pointer,
      role: input.role,
      value: input.value,
    }),
  } as EditorialMaterialUnit;
}

function materialFixture(): EditorialMaterial {
  const method = unit({
    pointer: '/methodSummary',
    value: '基于已封存材料',
    role: 'context',
    metricEligible: false,
    basisUnitIds: [],
    evidenceIds: [],
    questionIds: [],
    requiredInOutput: true,
    requiredInBody: true,
  });
  const claim = unit({
    pointer: '/findingGraph/findings/0/statement',
    value: '核心结论',
    role: 'claim',
    epistemicStatus: 'fact',
    metricEligible: false,
    basisUnitIds: [],
    evidenceIds: ['evidence-1'],
    questionIds: ['question-1'],
    requiredInOutput: true,
    requiredInBody: true,
  });
  const risk = unit({
    pointer: '/risksAndOpenIssues/0',
    value: '仍需验证',
    role: 'risk',
    epistemicStatus: 'unknown',
    metricEligible: false,
    basisUnitIds: [claim.id],
    evidenceIds: [],
    questionIds: ['question-1'],
    requiredInOutput: true,
    requiredInBody: true,
  });
  return {
    version: 'editorial-material-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    deliverableType: 'research_plan',
    presentationMode: 'current_text',
    sourceReportPackage: {
      artifactId: 'artifact-package',
      kind: 'report_package',
      schemaVersion: 'report-package-v1',
      contentSha256: ZERO_HASH,
    },
    sourceArtifacts: [
      {
        artifactId: 'artifact-package',
        kind: 'report_package',
        schemaVersion: 'report-package-v1',
        contentSha256: ZERO_HASH,
      },
      {
        artifactId: 'artifact-deliverable',
        kind: 'deliverable',
        schemaVersion: 'research-deliverable-v1-review-gated',
        contentSha256: ONE_HASH,
      },
      {
        artifactId: 'artifact-evidence',
        kind: 'knowledge_excerpt',
        schemaVersion: 'knowledge-excerpt-v1',
        contentSha256: TWO_HASH,
      },
    ],
    materializationWarningCodes: [],
    methodSummaryUnitId: method.id,
    units: [method, claim, risk],
    assets: [],
    evidence: [{
      id: 'evidence-1',
      kind: 'knowledge_excerpt',
      evidenceClass: 'knowledge',
      artifactId: 'artifact-evidence',
      artifactContentSha256: TWO_HASH,
      jsonPointer: '/excerpt',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  };
}

function compositionRichMaterialFixture(): EditorialMaterial {
  const material = materialFixture();
  material.deliverableType = 'competitive_analysis_report';
  const common = {
    metricEligible: false,
    evidenceIds: [] as string[],
    questionIds: [] as string[],
    requiredInOutput: true,
    requiredInBody: true,
  };
  const sampleA = unit({
    ...common,
    pointer: '/payload/competitorSamples/0/name',
    value: '样本 A',
    role: 'context',
    groupId: 'competitive-sample:a',
    basisUnitIds: [],
  });
  const sampleB = unit({
    ...common,
    pointer: '/payload/competitorSamples/1/name',
    value: '样本 B',
    role: 'context',
    groupId: 'competitive-sample:b',
    basisUnitIds: [],
  });
  const sampleRationaleA = unit({
    ...common,
    pointer: '/payload/competitorSamples/0/rationale',
    value: '覆盖主要场景',
    role: 'claim',
    epistemicStatus: 'inference',
    groupId: 'competitive-sample:a',
    basisUnitIds: [sampleA.id],
  });
  const sampleRationaleB = unit({
    ...common,
    pointer: '/payload/competitorSamples/1/rationale',
    value: '形成对照',
    role: 'claim',
    epistemicStatus: 'inference',
    groupId: 'competitive-sample:b',
    basisUnitIds: [sampleB.id],
  });
  const dimension = unit({
    ...common,
    pointer: '/payload/dimensionMatrix/0/dimension',
    value: '转化路径',
    role: 'context',
    groupId: 'competitive-dimension:0',
    basisUnitIds: [],
  });
  const cellA = unit({
    ...common,
    pointer: '/payload/dimensionMatrix/0/values/0/value',
    value: '路径清晰',
    role: 'claim',
    epistemicStatus: 'inference',
    groupId: 'competitive-cell:0:a',
    basisUnitIds: [dimension.id, sampleA.id],
  });
  const cellB = unit({
    ...common,
    pointer: '/payload/dimensionMatrix/0/values/1/value',
    value: '路径较长',
    role: 'claim',
    epistemicStatus: 'inference',
    groupId: 'competitive-cell:0:b',
    basisUnitIds: [dimension.id, sampleB.id],
  });
  const score = unit({
    ...common,
    pointer: '/payload/dimensionMatrix/0/values/0/score',
    value: 4,
    role: 'claim',
    epistemicStatus: 'inference',
    groupId: 'competitive-cell:0:a',
    unit: '/5',
    metricEligible: true,
    basisUnitIds: [dimension.id, sampleA.id, cellA.id],
  });
  const statement = unit({
    ...common,
    pointer: '/payload/roadmap/0/statement',
    value: '缩短关键路径',
    role: 'recommendation',
    epistemicStatus: 'inference',
    groupId: 'competitive-roadmap:0',
    basisUnitIds: [],
  });
  const priority = unit({
    ...common,
    pointer: '/payload/roadmap/0/priority',
    value: 'P0',
    role: 'recommendation',
    epistemicStatus: 'inference',
    groupId: 'competitive-roadmap:0',
    basisUnitIds: [statement.id],
  });
  const criterion = unit({
    ...common,
    pointer: '/payload/roadmap/0/metric',
    value: '任务完成率',
    role: 'validation',
    epistemicStatus: 'unknown',
    groupId: 'competitive-roadmap:0',
    basisUnitIds: [statement.id],
  });
  const method = unit({
    ...common,
    pointer: '/payload/roadmap/0/validationMethod',
    value: '可用性测试',
    role: 'validation',
    epistemicStatus: 'unknown',
    groupId: 'competitive-roadmap:0',
    basisUnitIds: [statement.id],
  });
  const userTestStep = unit({
    ...common,
    pointer: '/payload/userTestScript/0',
    value: '完成核心任务',
    role: 'validation',
    epistemicStatus: 'unknown',
    groupId: 'competitive-userTestScript:0',
    basisUnitIds: [],
  });
  const userTestStepTwo = unit({
    ...common,
    pointer: '/payload/userTestScript/1',
    value: '复核任务结果',
    role: 'validation',
    epistemicStatus: 'unknown',
    groupId: 'competitive-userTestScript:1',
    basisUnitIds: [],
  });
  const caption = unit({
    ...common,
    pointer: '/payload/visualEvidence/0/caption',
    value: '关键页面',
    role: 'context',
    groupId: 'competitive-visual:v1',
    basisUnitIds: [],
    requiredInBody: false,
  });
  const alt = unit({
    ...common,
    pointer: '/report/sections/0/blocks/0/altText',
    value: '关键页面截图',
    role: 'audit',
    groupId: 'visual:asset-main',
    basisUnitIds: [],
    requiredInBody: false,
  });
  material.units.push(
    sampleA,
    sampleB,
    sampleRationaleA,
    sampleRationaleB,
    dimension,
    cellA,
    cellB,
    score,
    statement,
    priority,
    criterion,
    method,
    userTestStep,
    userTestStepTwo,
    caption,
    alt,
  );
  material.sourceArtifacts.push({
    artifactId: 'asset-main',
    kind: 'visual_asset',
    schemaVersion: 'visual-asset-v1',
    contentSha256: `sha256:${'3'.repeat(64)}`,
  });
  material.assets.push({
    id: 'ema-asset-main',
    assetId: 'asset-main',
    manifestArtifactId: 'asset-manifest-main',
    visualRole: 'standalone',
    mediaType: 'image/png',
    byteSize: 128,
    width: 640,
    height: 480,
    exportPolicy: 'allow',
    captionUnitId: caption.id,
    altTextUnitId: alt.id,
    evidenceIds: [],
    sourceRefs: [{ artifactId: 'artifact-deliverable', jsonPointer: '/payload/visualEvidence/0' }],
  });
  return parseEditorialMaterial(material);
}

function copy(text: string, materialUnitIds: string[]) {
  return { text, mode: 'verbatim' as const, materialUnitIds };
}

function blueprintFixture(material = materialFixture()): EditorialBlueprint {
  const [method, claim, risk] = material.units;
  assert(method && claim && risk);
  return {
    version: 'editorial-blueprint-v1',
    taskId: material.taskId,
    planVersionId: material.planVersionId,
    attemptId: material.attemptId,
    requestKey: `erq_${'a'.repeat(64)}`,
    materialHash: editorialCanonicalHash(material),
    locale: 'zh-CN',
    deck: copy(String(method.value), [method.id]),
    sections: [
      {
        id: 'decision',
        role: 'decision',
        questionIds: ['question-1'],
        blocks: [{
          id: 'decision-cover',
          kind: 'decision-cover',
          summary: copy(String(claim.value), [claim.id]),
        }],
      },
      {
        id: 'risks',
        role: 'risk',
        questionIds: ['question-1'],
        blocks: [{
          id: 'risk-register',
          kind: 'risk-register',
          items: [{ risk: copy(String(risk.value), [risk.id]) }],
        }],
      },
      {
        id: 'audit',
        role: 'audit',
        questionIds: ['question-1'],
        blocks: [{
          id: 'audit-appendix',
          kind: 'audit-appendix',
          unitIds: material.units.map(({ id }) => id),
          evidenceIds: ['evidence-1'],
        }],
      },
    ],
  };
}

test('canonical JSON has exact number spellings and Unicode code-point key order', () => {
  assert.equal(
    canonicalEditorialJson({ '\u{10000}': 1e21, '\uE000': 1e20, tiny: 1e-7, threshold: 1e-6, minusZero: -0 }),
    '{"minusZero":0,"threshold":0.000001,"tiny":1e-7,"":100000000000000000000,"𐀀":1e+21}',
  );
  assert.throws(() => canonicalEditorialJson({ invalid: undefined }), /undefined/i);
  assert.throws(() => canonicalEditorialJson({ invalid: Number.POSITIVE_INFINITY }), /finite/i);
});

test('normalizes only line endings, NFC and negative zero', () => {
  assert.equal(normalizeEditorialScalar(' e\u0301\r\n x '), ' é\n x ');
  assert.equal(Object.is(normalizeEditorialScalar(-0), -0), false);
  assert.equal(normalizeEditorialScalar(false), false);
  assert.throws(() => normalizeEditorialScalar('x'.repeat(16_001)), /SOURCE_LEAF_TOO_LARGE/);
});

test('Unit ID matches the fixed 167-byte golden', () => {
  assert.equal(
    createEditorialMaterialUnitId({
      sourceArtifactId: 'artifact-01',
      sourceArtifactContentSha256: ZERO_HASH,
      sourceJsonPointer: '/payload/metrics/0/value',
      role: 'claim',
      value: 1e-7,
    }),
    'emu_e4144ce004a7f0c52b6e2b2350b6c4c0a7c021b14540a81acd1d9c4e907ef3a0',
  );
});

test('Material parser rejects unknown fields, duplicate IDs and invalid derived identities', () => {
  const material = materialFixture();
  assert.deepEqual(parseEditorialMaterial(material), material);

  assert.throws(
    () => parseEditorialMaterial({ ...material, unexpected: true }),
    /unknown field.*unexpected/i,
  );

  const duplicated = structuredClone(material);
  duplicated.units.push(structuredClone(duplicated.units[0]!));
  assert.throws(() => parseEditorialMaterial(duplicated), /duplicate.*Unit/i);

  const forged = structuredClone(material);
  forged.units[0]!.id = `emu_${'f'.repeat(64)}`;
  assert.throws(() => parseEditorialMaterial(forged), /Unit ID/i);

  assert.throws(
    () => parseEditorialMaterial({ ...material, materializationWarningCodes: ['VISUAL_BUDGET_OMITTED'] }),
    /materializationWarningCodes/u,
  );
});

test('Material parser accepts source URLs only for canonical public Evidence', () => {
  const valid = materialFixture();
  Object.assign(valid.evidence[0]!, {
    evidenceClass: 'public_source',
    sensitivity: 'public',
    sourceUrl: 'https://example.test/source?ref=report',
  });
  assert.equal(parseEditorialMaterial(valid).evidence[0]?.sourceUrl, 'https://example.test/source?ref=report');

  for (const evidence of [
    { evidenceClass: 'dataset', sensitivity: 'internal', sourceUrl: 'https://example.test/private' },
    { evidenceClass: 'public_source', sensitivity: 'public', sourceUrl: 'http://example.test/source' },
    { evidenceClass: 'public_source', sensitivity: 'public', sourceUrl: 'https://user:secret@example.test/source' },
    { evidenceClass: 'public_source', sensitivity: 'public', sourceUrl: 'https://EXAMPLE.test/source' },
  ]) {
    const candidate = materialFixture();
    Object.assign(candidate.evidence[0]!, evidence);
    assert.throws(() => parseEditorialMaterial(candidate), /REFERENCE_INTEGRITY/u);
  }
});

test('minimal Model Context has a stable hash and excludes source metadata', () => {
  const material = parseEditorialMaterial(materialFixture());
  const projected = projectEditorialModelContext(material);
  assert.equal(projected.context.version, 'editorial-model-context-v1');
  assert.equal(projected.context.materialHash, editorialCanonicalHash(material));
  assert.equal(projected.byteSize, projected.bytes.byteLength);
  assert.equal(projected.hash, editorialCanonicalHash(projected.context));
  const serialized = projected.bytes.toString('utf8');
  for (const forbidden of [
    'task-1',
    'plan-1',
    'attempt-1',
    'artifact-package',
    'artifact-deliverable',
    'artifact-evidence',
    '/findingGraph/findings/0/statement',
    'evidence-1',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('fixed egress policy defaults an unconfigured Phase 1 port to deny', () => {
  assert.deepEqual(NO_EDITORIAL_MODEL_PORT, { client: null, configuration: null });
  assert.equal(Object.isFrozen(EDITORIAL_MODEL_EGRESS_POLICY), true);
  const decision = evaluateEditorialModelEgress({
    sourcePolicyMetadata: [{
      artifactId: 'artifact-deliverable',
      contentSha256: ONE_HASH,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    }],
    modelPort: NO_EDITORIAL_MODEL_PORT,
  });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'EGRESS_MODEL_UNCONFIGURED');
  assert.equal(decision.evaluated.provider, null);
});

test('request and generation identities are deterministic and cover their complete inputs', () => {
  const material = parseEditorialMaterial(materialFixture());
  const modelContext = projectEditorialModelContext(material);
  const modelEgress = evaluateEditorialModelEgress({
    sourcePolicyMetadata: [{
      artifactId: 'artifact-deliverable',
      contentSha256: ONE_HASH,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    }],
    modelPort: NO_EDITORIAL_MODEL_PORT,
  });
  const requestInput = {
    sourceReportPackageId: material.sourceReportPackage.artifactId,
    sourceReportPackageHash: material.sourceReportPackage.contentSha256,
    materialHash: editorialCanonicalHash(material),
    modelContextHash: modelContext.hash,
    modelEgress,
    gatewayConfiguration: null,
  } as const;
  const requestKey = createEditorialRequestKey(requestInput);
  assert.match(requestKey, /^erq_[0-9a-f]{64}$/);
  assert.equal(createEditorialRequestKey(requestInput), requestKey);
  assert.notEqual(
    createEditorialRequestKey({
      ...requestInput,
      sourceReportPackageId: 'artifact-package-2',
    }),
    requestKey,
  );

  const generationInput = {
    requestKey,
    mode: 'deterministic_fallback' as const,
    materialHash: requestInput.materialHash,
    publishedBlueprintHash: ZERO_HASH,
    exportedAssetHashes: [
      { assetId: 'asset-1', contentSha256: ONE_HASH },
      { assetId: 'asset-2', contentSha256: TWO_HASH },
    ],
  };
  const generationId = createEditorialGenerationId(generationInput);
  assert.match(generationId, /^er_[0-9a-f]{64}$/);
  assert.notEqual(
    createEditorialGenerationId({
      ...generationInput,
      exportedAssetHashes: [...generationInput.exportedAssetHashes].reverse(),
    }),
    generationId,
  );
});

test('sensitive-token scanner conservatively catches numbers, money, ratios, Evidence IDs and prose URLs', () => {
  const evidenceIds = ['E-42'];
  for (const text of [
    '三位用户',
    '百分之三',
    '三成',
    '十万元',
    'CNY 10',
    '详见https://example.com/a?x=1。',
    '详见HTTPS://example.com/A。',
    '证据 E-42',
  ]) {
    assert.equal(hasEditorialSensitiveToken(text, evidenceIds), true, text);
  }
  assert.equal(hasEditorialSensitiveToken('这是不含敏感标记的改写', evidenceIds), false);
  assert.equal(hasEditorialSensitiveToken('依据可信材料形成报告', evidenceIds), false);
});

test('ratio rendering shifts the canonical decimal without floating-point rounding', () => {
  assert.deepEqual(
    [0, 1, 0.1, 0.29, 1e-7, -0].map(formatEditorialRatio),
    ['0%', '100%', '10%', '29%', '0.00001%', '0%'],
  );
});

test('fallback Blueprint validation enforces audit closure, body coverage, status and sensitive-token rules', () => {
  const material = parseEditorialMaterial(materialFixture());
  const blueprint = parseEditorialBlueprint(blueprintFixture(material));
  assert.deepEqual(
    validateEditorialBlueprint({ blueprint, material, mode: 'deterministic_fallback' }),
    blueprint,
  );

  const missingBody = structuredClone(blueprint);
  const riskSection = missingBody.sections.find(({ role }) => role === 'risk')!;
  riskSection.blocks = [{
    id: 'risk-narrative',
    kind: 'narrative',
    paragraphs: [copy(String(material.units[1]!.value), [material.units[1]!.id])],
  }];
  assert.throws(
    () => validateEditorialBlueprint({ blueprint: missingBody, material, mode: 'deterministic_fallback' }),
    /requiredInBody|risk-register/i,
  );

  const wrongStatus = structuredClone(blueprint);
  wrongStatus.sections[0]!.blocks.push({
    id: 'truth',
    kind: 'truth-triad',
    factIds: [],
    inferenceIds: [],
    unknownIds: [material.units[1]!.id],
  });
  assert.throws(
    () => validateEditorialBlueprint({ blueprint: wrongStatus, material, mode: 'deterministic_fallback' }),
    /epistemic|status/i,
  );

  const badAudit = structuredClone(blueprint);
  const appendix = badAudit.sections.at(-1)!.blocks[0];
  assert.equal(appendix?.kind, 'audit-appendix');
  if (appendix?.kind === 'audit-appendix') appendix.unitIds.pop();
  assert.throws(
    () => validateEditorialBlueprint({ blueprint: badAudit, material, mode: 'deterministic_fallback' }),
    /audit.*closure|requiredInOutput/i,
  );

  const paraphrase = structuredClone(blueprint);
  const cover = paraphrase.sections[0]!.blocks[0];
  assert.equal(cover?.kind, 'decision-cover');
  if (cover?.kind === 'decision-cover') {
    cover.summary = { text: '三位用户', mode: 'paraphrase', materialUnitIds: [material.units[1]!.id] };
  }
  assert.throws(
    () => validateEditorialBlueprint({ blueprint: paraphrase, material, mode: 'llm' }),
    /numeric_integrity|sensitive token/i,
  );
  assert.throws(
    () => validateEditorialBlueprint({ blueprint: paraphrase, material, mode: 'deterministic_fallback' }),
    /verbatim/i,
  );

  const ineligibleFlow = structuredClone(blueprint);
  ineligibleFlow.sections[0]!.blocks.push({
    id: 'invented-flow',
    kind: 'flow',
    steps: [{
      label: copy(String(material.units[1]!.value), [material.units[1]!.id]),
      body: copy(String(material.units[2]!.value), [material.units[2]!.id]),
    }],
  });
  assert.throws(
    () => validateEditorialBlueprint({ blueprint: ineligibleFlow, material, mode: 'deterministic_fallback' }),
    /eligible|composition/i,
  );
});

test('Blueprint parser rejects unknown fields and fallback arrays beyond their hard limit', () => {
  const blueprint = blueprintFixture();
  const extra = structuredClone(blueprint);
  (extra.sections[0]!.blocks[0] as unknown as Record<string, unknown>).style = 'display:none';
  assert.throws(() => parseEditorialBlueprint(extra), /unknown field.*style/i);

  const tooManyBlocks = structuredClone(blueprint);
  tooManyBlocks.sections[0]!.blocks = Array.from({ length: 49 }, (_, index) => ({
    id: `narrative-${index}`,
    kind: 'narrative' as const,
    paragraphs: [copy('核心结论', [blueprintFixture().sections[0]!.blocks[0]!.kind === 'decision-cover'
      ? materialFixture().units[1]!.id
      : 'unreachable'])],
  }));
  assert.throws(() => parseEditorialBlueprint(tooManyBlocks), /48|block/i);
});

test('final render trace cannot hide blocks or claim ineligible composition kinds', () => {
  const material = parseEditorialMaterial(materialFixture());
  const blueprint = validateEditorialBlueprint({
    blueprint: parseEditorialBlueprint(blueprintFixture(material)),
    material,
    mode: 'deterministic_fallback',
  });
  const trace: EditorialRenderTrace = {
    bodyUnitIds: material.units.filter(({ requiredInBody }) => requiredInBody).map(({ id }) => id),
    appendixUnitIds: material.units.map(({ id }) => id),
    assetIds: [],
    renderedBlocks: blueprint.sections.flatMap(({ blocks }) => blocks.map(({ id, kind }) => ({ blockId: id, kind }))),
    renderedBlockKinds: ['decision-cover', 'risk-register', 'audit-appendix'],
    eligibleCompositionKinds: computeEligibleCompositionKinds(material, []),
    renderedCompositionKinds: [],
  };
  assert.deepEqual(validateEditorialRenderTrace({ blueprint, material, trace, exportedAssets: [] }), trace);

  const hidden = structuredClone(trace);
  hidden.renderedBlocks.pop();
  assert.throws(
    () => validateEditorialRenderTrace({ blueprint, material, trace: hidden, exportedAssets: [] }),
    /render.*block|trace/i,
  );

  const injected = structuredClone(trace);
  injected.renderedCompositionKinds = ['flow'];
  assert.throws(
    () => validateEditorialRenderTrace({ blueprint, material, trace: injected, exportedAssets: [] }),
    /eligible|subset/i,
  );
});

test('deterministic Blueprint is a valid verbatim-only fallback with complete audit closure', () => {
  const material = parseEditorialMaterial(materialFixture());
  assert.deepEqual(computeEligibleCompositionKinds(material), ['truth-triad']);
  const blueprint = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'a'.repeat(64)}`,
  });
  assert.equal(blueprint.sections[0]!.blocks[0]!.kind, 'decision-cover');
  assert.equal(blueprint.sections.at(-1)!.role, 'audit');
  assert.equal(
    JSON.stringify(blueprint).includes('"mode":"paraphrase"'),
    false,
  );
  assert.doesNotThrow(() => validateEditorialBlueprint({
    blueprint,
    material,
    mode: 'deterministic_fallback',
  }));
});

test('fallback covers every body Unit when truth-triad is not eligible', () => {
  const material = materialFixture();
  const firstClaim = material.units[1]!;
  material.units.pop();
  material.units.push(unit({
    pointer: '/findingGraph/findings/1/statement',
    value: '补充事实',
    role: 'claim',
    epistemicStatus: 'fact',
    metricEligible: false,
    basisUnitIds: [firstClaim.id],
    evidenceIds: ['evidence-1'],
    questionIds: ['question-1'],
    requiredInOutput: true,
    requiredInBody: true,
  }));
  const parsed = parseEditorialMaterial(material);
  assert.deepEqual(computeEligibleCompositionKinds(parsed), []);
  const blueprint = buildDeterministicEditorialBlueprint({
    material: parsed,
    requestKey: `erq_${'c'.repeat(64)}`,
  });
  assert.equal(
    blueprint.sections.flatMap(({ blocks }) => blocks).some(({ kind }) => kind === 'truth-triad'),
    false,
  );
  assert.doesNotThrow(() => validateEditorialBlueprint({
    blueprint,
    material: parsed,
    mode: 'deterministic_fallback',
  }));
});

test('composition eligibility and deterministic fallback use only explicit source relations', () => {
  const material = compositionRichMaterialFixture();
  assert.deepEqual(computeEligibleCompositionKinds(material, []), [
    'metric-cards',
    'truth-triad',
    'card-grid',
    'flow',
    'strategy-matrix',
    'roadmap',
    'validation-gates',
  ]);
  assert.deepEqual(computeEligibleCompositionKinds(material, ['ema-asset-main']), [
    'metric-cards',
    'truth-triad',
    'card-grid',
    'flow',
    'strategy-matrix',
    'roadmap',
    'validation-gates',
    'visual-gallery',
  ]);

  const blueprint = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'b'.repeat(64)}`,
  });
  const renderedKinds = new Set(blueprint.sections.flatMap(({ blocks }) => blocks.map(({ kind }) => kind)));
  assert.equal([...renderedKinds].filter((kind) => (
    computeEligibleCompositionKinds(material).includes(kind as never)
  )).length >= 5, true);
  assert.doesNotThrow(() => validateEditorialBlueprint({
    blueprint,
    material,
    mode: 'deterministic_fallback',
  }));

  const crossedMatrix = structuredClone(blueprint);
  const matrix = crossedMatrix.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'strategy-matrix');
  if (!matrix || matrix.kind !== 'strategy-matrix') throw new Error('fixture strategy matrix is missing');
  matrix.rows[0]!.cells[0] = structuredClone(matrix.rows[0]!.cells[1]!);
  assert.throws(() => validateEditorialBlueprint({
    blueprint: crossedMatrix,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: matrix cell must directly bind its row and column Units/u);

  const duplicateColumnMatrix = structuredClone(blueprint);
  const duplicateMatrix = duplicateColumnMatrix.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'strategy-matrix');
  if (!duplicateMatrix || duplicateMatrix.kind !== 'strategy-matrix') {
    throw new Error('fixture strategy matrix is missing');
  }
  duplicateMatrix.columns[1] = structuredClone(duplicateMatrix.columns[0]!);
  duplicateMatrix.rows[0]!.cells[1] = structuredClone(duplicateMatrix.rows[0]!.cells[0]!);
  assert.throws(() => validateEditorialBlueprint({
    blueprint: duplicateColumnMatrix,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: matrix columns must exactly cover/u);

  const renderedKindSet = new Set(blueprint.sections.flatMap(({ blocks }) => blocks.map(({ kind }) => kind)));
  const trace: EditorialRenderTrace = {
    bodyUnitIds: material.units.filter(({ requiredInBody }) => requiredInBody).map(({ id }) => id),
    appendixUnitIds: material.units.filter(({ requiredInOutput }) => requiredInOutput).map(({ id }) => id),
    assetIds: ['ema-asset-main'],
    renderedBlocks: blueprint.sections.flatMap(({ blocks }) => blocks.map(({ id, kind }) => ({ blockId: id, kind }))),
    renderedBlockKinds: ([
      'narrative',
      'decision-cover',
      'metric-cards',
      'truth-triad',
      'card-grid',
      'flow',
      'strategy-matrix',
      'roadmap',
      'validation-gates',
      'risk-register',
      'visual-gallery',
      'audit-appendix',
    ] as const).filter((kind) => renderedKindSet.has(kind)),
    eligibleCompositionKinds: computeEligibleCompositionKinds(material, ['ema-asset-main']),
    renderedCompositionKinds: computeEligibleCompositionKinds(material, ['ema-asset-main']),
  };
  assert.deepEqual(validateEditorialRenderTrace({
    blueprint,
    material,
    trace,
    exportedAssets: [{ assetId: 'asset-main', contentSha256: `sha256:${'3'.repeat(64)}` }],
  }), trace);

  const forgedEligibility = structuredClone(trace);
  forgedEligibility.eligibleCompositionKinds.pop();
  assert.throws(() => validateEditorialRenderTrace({
    blueprint,
    material,
    trace: forgedEligibility,
    exportedAssets: [{ assetId: 'asset-main', contentSha256: `sha256:${'3'.repeat(64)}` }],
  }), /eligible|composition/i);

  assert.throws(() => validateEditorialRenderTrace({
    blueprint,
    material,
    trace,
    exportedAssets: [{ assetId: 'asset-main', contentSha256: TWO_HASH }],
  }), /hash|source/i);
});

test('flow steps preserve the complete source sequence', () => {
  const material = compositionRichMaterialFixture();
  const blueprint = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'d'.repeat(64)}`,
  });
  const reordered = structuredClone(blueprint);
  const flow = reordered.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'flow');
  if (!flow || flow.kind !== 'flow') throw new Error('fixture flow is missing');
  assert.deepEqual(flow.steps.map(({ label, body }) => [label.text, body.text]), [
    ['完成核心任务', '完成核心任务'],
    ['复核任务结果', '复核任务结果'],
  ]);
  flow.steps.reverse();

  assert.throws(() => validateEditorialBlueprint({
    blueprint: reordered,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: flow steps must exactly map the source sequence/u);

  const incomplete = structuredClone(blueprint);
  const incompleteSection = incomplete.sections.find(({ blocks }) => blocks.some(({ kind }) => kind === 'flow'))!;
  const incompleteFlow = incompleteSection.blocks.find(({ kind }) => kind === 'flow');
  if (!incompleteFlow || incompleteFlow.kind !== 'flow') throw new Error('fixture flow is missing');
  const omitted = incompleteFlow.steps.pop()!;
  incompleteSection.blocks.push({
    id: 'omitted-flow-step-coverage',
    kind: 'narrative',
    paragraphs: [structuredClone(omitted.body)],
  });
  assert.throws(() => validateEditorialBlueprint({
    blueprint: incomplete,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: flow steps must exactly map the source sequence/u);

  const duplicated = structuredClone(blueprint);
  const duplicatedSection = duplicated.sections.find(({ blocks }) => blocks.some(({ kind }) => kind === 'flow'))!;
  const duplicatedFlow = duplicatedSection.blocks.find(({ kind }) => kind === 'flow');
  if (!duplicatedFlow || duplicatedFlow.kind !== 'flow') throw new Error('fixture flow is missing');
  const displaced = structuredClone(duplicatedFlow.steps[1]!);
  duplicatedFlow.steps[1] = structuredClone(duplicatedFlow.steps[0]!);
  duplicatedSection.blocks.push({
    id: 'duplicate-flow-step-coverage',
    kind: 'narrative',
    paragraphs: [displaced.body],
  });
  assert.throws(() => validateEditorialBlueprint({
    blueprint: duplicated,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: flow steps must exactly map the source sequence/u);
});

test('roadmap lanes preserve their source-backed label and item semantics', () => {
  const material = compositionRichMaterialFixture();
  const validBlueprint = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'e'.repeat(64)}`,
  });
  const blueprint = structuredClone(validBlueprint);
  const roadmap = blueprint.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'roadmap');
  if (!roadmap || roadmap.kind !== 'roadmap') throw new Error('fixture roadmap is missing');
  assert.equal(roadmap.lanes[0]!.label.text, 'P0');
  assert.deepEqual(roadmap.lanes[0]!.items.map(({ text }) => text), ['缩短关键路径']);
  roadmap.lanes[0]!.label = structuredClone(roadmap.lanes[0]!.items[0]!);

  assert.throws(() => validateEditorialBlueprint({
    blueprint,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: roadmap lanes must use source-backed label and item semantics/u);

  const invalidItemBlueprint = structuredClone(validBlueprint);
  const invalidItemRoadmap = invalidItemBlueprint.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'roadmap');
  if (!invalidItemRoadmap || invalidItemRoadmap.kind !== 'roadmap') {
    throw new Error('fixture roadmap is missing');
  }
  invalidItemRoadmap.lanes[0]!.items[0] = structuredClone(invalidItemRoadmap.lanes[0]!.label);
  assert.throws(() => validateEditorialBlueprint({
    blueprint: invalidItemBlueprint,
    material,
    mode: 'deterministic_fallback',
  }), /COMPONENT_RELATION: roadmap lanes must use source-backed label and item semantics/u);
});

test('risk register rejects impact and response fields without V1 source semantics', () => {
  const material = parseEditorialMaterial(materialFixture());
  const validBlueprint = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'f'.repeat(64)}`,
  });
  for (const field of ['impact', 'response'] as const) {
    const blueprint = structuredClone(validBlueprint);
    const riskRegister = blueprint.sections
      .flatMap(({ blocks }) => blocks)
      .find(({ kind }) => kind === 'risk-register');
    if (!riskRegister || riskRegister.kind !== 'risk-register') {
      throw new Error('fixture risk register is missing');
    }
    riskRegister.items[0]![field] = structuredClone(riskRegister.items[0]!.risk);

    assert.throws(() => validateEditorialBlueprint({
      blueprint,
      material,
      mode: 'deterministic_fallback',
    }), /COMPONENT_RELATION: V1 risk register does not support impact or response fields/u);
  }
});

test('Fidelity Review Plan parser rejects an empty check set', () => {
  assert.throws(() => parseEditorialFidelityReviewPlan({
    version: 'editorial-fidelity-plan-v1',
    checks: [],
  }), /checks must contain between 1 and 240 entries/u);
});

test('final Fidelity Review parser cannot fold an empty check set to pass', () => {
  assert.throws(() => parseEditorialFidelityReview({
    version: 'editorial-fidelity-v1',
    materialHash: ONE_HASH,
    blueprintHash: TWO_HASH,
    verdict: 'pass',
    checks: [],
  }), /checks must contain between 1 and 240 entries/u);
});

test('Fidelity Review requires checks in canonical Blueprint order', () => {
  const material = materialFixture();
  const blueprint = buildDeterministicEditorialBlueprint({
    material,
    requestKey: `erq_${'f'.repeat(64)}`,
  });
  blueprint.deck = { ...blueprint.deck, mode: 'paraphrase' };
  const decisionCover = blueprint.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'decision-cover');
  assert.ok(decisionCover?.kind === 'decision-cover');
  decisionCover.summary = { ...decisionCover.summary, mode: 'paraphrase' };
  const materialHash = editorialCanonicalHash(material);
  const checks = enumerateEditorialParaphrases(blueprint).map(({ copyPointer, materialUnitIds }) => ({
    copyPointer,
    materialUnitIds,
    verdict: 'faithful' as const,
  }));
  assert.equal(checks.length, 2);

  assert.doesNotThrow(() => buildEditorialFidelityReview({
    plan: { version: 'editorial-fidelity-plan-v1', checks },
    materialHash,
    blueprint,
  }));
  assert.throws(() => buildEditorialFidelityReview({
    plan: { version: 'editorial-fidelity-plan-v1', checks: [...checks].reverse() },
    materialHash,
    blueprint,
  }), /canonical Blueprint order/u);
});

test('Diagnostic and manifest parsers reject unknown fields and inconsistent status modes', () => {
  const material = parseEditorialMaterial(materialFixture());
  const modelContext = projectEditorialModelContext(material);
  const modelEgress = evaluateEditorialModelEgress({
    sourcePolicyMetadata: [{
      artifactId: 'artifact-deliverable',
      contentSha256: ONE_HASH,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    }],
    modelPort: NO_EDITORIAL_MODEL_PORT,
  });
  const requestKey = createEditorialRequestKey({
    sourceReportPackageId: material.sourceReportPackage.artifactId,
    sourceReportPackageHash: material.sourceReportPackage.contentSha256,
    materialHash: modelContext.context.materialHash,
    modelContextHash: modelContext.hash,
    modelEgress,
    gatewayConfiguration: null,
  });
  const blueprint = buildDeterministicEditorialBlueprint({ material, requestKey });
  const blueprintHash = editorialCanonicalHash(blueprint);
  const htmlHash = hashBytes(Buffer.from('<!doctype html>', 'utf8'));
  const generationId = createEditorialGenerationId({
    requestKey,
    mode: 'deterministic_fallback',
    materialHash: modelContext.context.materialHash,
    publishedBlueprintHash: blueprintHash,
    exportedAssetHashes: [],
  });
  const checkIds = [
    'source_integrity', 'model_egress', 'model_identity', 'schema_integrity',
    'reference_integrity', 'component_relation', 'epistemic_integrity', 'numeric_integrity',
    'content_fidelity', 'content_coverage', 'composition_quality', 'visual_policy', 'html_safety',
  ] as const;
  const diagnostic = {
    version: 'editorial-diagnostic-v1',
    taskId: material.taskId,
    planVersionId: material.planVersionId,
    attemptId: material.attemptId,
    sourceReportPackage: material.sourceReportPackage,
    gatewayConfigurationHash: null,
    candidateAttempts: [],
    rejectedResponseHashes: [],
    checks: checkIds.map((id) => ({
      id,
      status: id === 'model_identity' || id === 'content_fidelity' ? 'not_run' : 'passed',
      method: id === 'content_fidelity' ? 'llm' : 'deterministic',
      issues: id === 'model_egress'
        ? [{ code: 'EGRESS_MODEL_UNCONFIGURED', severity: 'warning', message: 'Model is not configured' }]
        : [],
    })),
    issues: [],
    requestKey,
    materialHash: modelContext.context.materialHash,
    modelEgress,
    modelContextHash: modelContext.hash,
    modelContextByteSize: modelContext.byteSize,
    status: 'degraded',
    mode: 'deterministic_fallback',
    generationId,
    publishedBlueprintHash: blueprintHash,
    htmlHash,
  };
  assert.deepEqual(parseEditorialDiagnostic(diagnostic), diagnostic);
  assert.throws(() => parseEditorialDiagnostic({ ...diagnostic, extra: true }), /unknown field.*extra/i);
  assert.throws(() => parseEditorialDiagnostic({ ...diagnostic, status: 'ready' }), /status|mode/i);

  const acceptedWithoutFidelity = {
    ordinal: 1,
    blueprintHash,
    plannerCall: {
      stage: 'editorial_blueprint',
      ordinal: 1,
      gatewayConfigurationHash: ONE_HASH,
      modelContextHash: modelContext.hash,
      modelContextByteSize: modelContext.byteSize,
      promptVersion: 'editorial-copy-edit-prompt-v1',
      promptHash: `sha256:${'1'.repeat(16)}`,
      status: 'succeeded',
      provider: 'gateway',
      endpointHost: 'llm-gw.jd.local',
      requestedModel: 'editorial-model',
      expectedModel: 'editorial-model-v1',
      actualModel: 'editorial-model-v1',
      modelVersion: 'editorial-model-v1',
      traceId: 'trace-accepted-without-fidelity',
      responseHash: TWO_HASH,
    },
    outcome: 'accepted',
    issueCodes: [],
  };
  const readyWithoutFidelity = {
    ...diagnostic,
    gatewayConfigurationHash: ONE_HASH,
    candidateAttempts: [acceptedWithoutFidelity],
    checks: diagnostic.checks.map((check) => ({ ...check, status: 'passed', issues: [] })),
    modelEgress: {
      ...modelEgress,
      decision: 'allow',
      reasonCode: 'EGRESS_ALLOWED',
      evaluated: {
        ...modelEgress.evaluated,
        provider: 'gateway',
        mode: 'real',
        endpointHost: 'llm-gw.jd.local',
        endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
        redirectMode: 'error',
      },
    },
    status: 'pass',
    mode: 'llm',
  };
  assert.throws(
    () => parseEditorialDiagnostic(readyWithoutFidelity),
    /accepted candidate shape is invalid/u,
  );

  const jsonRef = (relativePath: string, contentSha256: string) => ({
    relativePath,
    contentSha256,
    byteSize: 2,
    mediaType: 'application/json',
  });
  const manifest = {
    version: 'editorial-report-v2',
    authority: 'derived',
    taskId: material.taskId,
    planVersionId: material.planVersionId,
    attemptId: material.attemptId,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    requestKey,
    generationId,
    status: 'degraded',
    sourceReportPackage: material.sourceReportPackage,
    pipeline: {
      materialVersion: 'editorial-material-v1',
      modelContextVersion: 'editorial-model-context-v1',
      modelContextHash: modelContext.hash,
      copyEditRequestVersion: 'editorial-copy-edit-request-v1',
      copyEditPlanVersion: 'editorial-copy-edit-plan-v1',
      blueprintVersion: 'editorial-blueprint-v1',
      copyEditPromptVersion: 'editorial-copy-edit-prompt-v1',
      fidelityPromptVersion: 'editorial-fidelity-prompt-v2',
      fallbackVersion: 'editorial-fallback-v1',
      rendererVersion: 'editorial-html-v1',
      storeVersion: 'editorial-store-v2',
      modelEgress,
      gatewayConfiguration: null,
    },
    modelCalls: [],
    exportedAssets: [],
    files: {
      material: jsonRef('editorial-material.json', modelContext.context.materialHash),
      blueprint: jsonRef('editorial-blueprint.json', blueprintHash),
      diagnostic: jsonRef('editorial-diagnostic.json', ZERO_HASH),
      html: {
        relativePath: 'editorial-report.html',
        contentSha256: htmlHash,
        byteSize: 15,
        mediaType: 'text/html',
        selfContained: true,
        printProfile: 'a4-portrait-v1',
      },
    },
    generatedAt: '2026-08-27T00:00:00.000Z',
  };
  assert.deepEqual(parseEditorialReport(manifest), manifest);
  assert.throws(
    () => parseEditorialReport({ ...manifest, version: 'editorial-report-v1' }),
    /version or authority is invalid/i,
  );
  const badManifest = structuredClone(manifest);
  (badManifest.pipeline as Record<string, unknown>).extra = true;
  assert.throws(() => parseEditorialReport(badManifest), /unknown field.*extra/i);
  assert.throws(() => parseEditorialReport({ ...manifest, status: 'ready' }), /status|modelCalls|gateway/i);
});
