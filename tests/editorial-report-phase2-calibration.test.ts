import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  EDITORIAL_MODEL_EGRESS_POLICY,
  canonicalEditorialJson,
  canonicalSha256,
  type EditorialModelPort,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';

import {
  buildEditorialCalibrationResult,
  computeEditorialCalibrationResultHash,
  assertEditorialCalibrationBaseMainAncestor,
  type EditorialCalibrationCollection,
  EditorialCalibrationError,
  evaluateEditorialCalibrationGate,
  finalizeEditorialCalibrationRun,
  parseEditorialCalibrationArgs,
  parseEditorialCalibrationCorpus,
  parseEditorialFidelityGoldenFixture,
  runEditorialFidelityGolden,
  runEditorialCalibrationCli,
  verifyEditorialCalibrationRun,
} from '../scripts/editorial-report-phase2-calibration.ts';

test('calibration CLI accepts exactly one strict workflow mode', () => {
  assert.deepEqual(parseEditorialCalibrationArgs([
    '--collect',
    '--corpus', '/secure/corpus.json',
    '--run-dir', '/secure/run.abc123',
  ]), {
    mode: 'collect',
    corpusPath: '/secure/corpus.json',
    runDirectory: '/secure/run.abc123',
  });
  assert.deepEqual(parseEditorialCalibrationArgs([
    '--finalize',
    '--draft', '/secure/run.abc123/phase2-calibration.draft.json',
    '--reference-rubric', '/secure/run.abc123/reference-rubric.json',
    '--output', '/secure/run.abc123/phase2-calibration.json',
  ]), {
    mode: 'finalize',
    draftPath: '/secure/run.abc123/phase2-calibration.draft.json',
    referenceRubricPath: '/secure/run.abc123/reference-rubric.json',
    outputPath: '/secure/run.abc123/phase2-calibration.json',
  });
  assert.deepEqual(parseEditorialCalibrationArgs([
    '--verify', '/secure/run.abc123/phase2-calibration.json',
  ]), {
    mode: 'verify',
    resultPath: '/secure/run.abc123/phase2-calibration.json',
  });

  for (const args of [
    [],
    ['--collect', '--corpus', '/a', '--run-dir', '/b', '--verify', '/c'],
    ['--collect', '--run-dir', '/b', '--corpus', '/a'],
    ['--verify', '/a', '--extra'],
    ['--finalize', '--draft', '/a', '--reference-rubric', '/b'],
    ['--', '--collect', '--corpus', '/a', '--run-dir', '/b', '--unknown'],
  ]) {
    assert.throws(
      () => parseEditorialCalibrationArgs(args),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_ARGUMENT_INVALID',
    );
  }
});

test('calibration repository fence requires the Phase 1 main commit as an ancestor', () => {
  const head = '1'.repeat(40);
  let observed: [string, string] | undefined;
  assert.doesNotThrow(() => assertEditorialCalibrationBaseMainAncestor(
    head,
    (base, candidate) => {
      observed = [base, candidate];
      return true;
    },
  ));
  assert.deepEqual(observed, ['49e4b7fda5f7ce2eeb525fab0dd9daae97226cea', head]);
  assert.throws(
    () => assertEditorialCalibrationBaseMainAncestor(head, () => false),
    (error: unknown) => error instanceof EditorialCalibrationError
      && error.code === 'EDITORIAL_CALIBRATION_BASE_MAIN_MISMATCH',
  );
});

const GOLDEN_VERDICTS = [
  'faithful',
  'narrower',
  'unsupported',
  'certainty_upgraded',
  'numeric_drift',
  'qualification_lost',
] as const;

test('committed Fidelity golden fixture is strict, anonymous, and balanced 10 per verdict', () => {
  const fixture = parseEditorialFidelityGoldenFixture(JSON.parse(readFileSync(
    new URL('./fixtures/editorial-fidelity-golden.json', import.meta.url),
    'utf8',
  )));
  assert.equal(fixture.cases.length, 60);
  assert.equal(new Set(fixture.cases.map(({ caseId }) => caseId)).size, 60);
  assert.deepEqual(Object.fromEntries(GOLDEN_VERDICTS.map((verdict) => [
    verdict,
    fixture.cases.filter(({ expected }) => expected === verdict).length,
  ])), Object.fromEntries(GOLDEN_VERDICTS.map((verdict) => [verdict, 10])));
});

test('Fidelity golden parser rejects shape, distribution, and Unit binding drift', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('./fixtures/editorial-fidelity-golden.json', import.meta.url),
    'utf8',
  )) as { cases: Array<Record<string, unknown>> };
  const invalid = [
    { ...fixture, extra: true },
    { ...fixture, cases: fixture.cases.slice(0, 59) },
    {
      ...fixture,
      cases: fixture.cases.map((candidate, index) => index === 10
        ? { ...candidate, expected: 'faithful' }
        : candidate),
    },
    {
      ...fixture,
      cases: fixture.cases.map((candidate, index) => index === 0
        ? {
            ...candidate,
            paraphrase: {
              ...(candidate.paraphrase as Record<string, unknown>),
              materialUnitIds: [`emu_${'f'.repeat(64)}`],
            },
          }
        : candidate),
    },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => parseEditorialFidelityGoldenFixture(candidate),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_GOLDEN_INVALID',
    );
  }
});

test('Fidelity golden rejects a non-allowlisted endpoint before any model call', async () => {
  const fixtureBytes = readFileSync(
    new URL('./fixtures/editorial-fidelity-golden.json', import.meta.url),
  );
  const fixture = parseEditorialFidelityGoldenFixture(JSON.parse(fixtureBytes.toString('utf8')));
  const identity = {
    provider: 'gateway',
    endpointHost: 'attacker.invalid',
    endpointUrl: 'https://attacker.invalid/v1/chat/completions',
    mode: 'real' as const,
    eligibleAsReal: true,
    routes: [{
      requestedModel: 'editorial-model',
      expectedActualModel: 'editorial-model-v1',
      expectedActualModelExplicit: true as const,
    }],
  };
  const limits = {
    overallTimeoutMs: 90_000,
    maxHttpAttempts: 3,
    maxRetryAfterMs: 5_000,
    maxResponseBytes: 1_048_576,
    maxOutputTokens: 8_000,
  } as const;
  const configurationBody = { ...identity, redirectMode: 'error' as const, limits };
  let modelCalls = 0;
  const modelPort = {
    client: {
      configurationIdentity: identity,
      async generateStructured<T>(): Promise<never> {
        modelCalls += 1;
        throw new Error('model call must be fenced');
      },
    },
    configuration: {
      ...configurationBody,
      gatewayConfigurationHash: canonicalSha256(configurationBody),
    },
  } satisfies Extract<EditorialModelPort, { client: object }>;

  await assert.rejects(
    runEditorialFidelityGolden({
      fixture,
      fixtureHash: contentHash(fixtureBytes),
      schema: {},
      modelPort,
    }),
    (error: unknown) => error instanceof EditorialCalibrationError
      && error.code === 'EDITORIAL_CALIBRATION_MODEL_EGRESS_DENIED',
  );
  assert.equal(modelCalls, 0);
});

function passingGateInput() {
  const fixture = parseEditorialFidelityGoldenFixture(JSON.parse(readFileSync(
    new URL('./fixtures/editorial-fidelity-golden.json', import.meta.url),
    'utf8',
  )));
  const goldenCases = fixture.cases.map(({ caseId, expected }) => ({
    expected,
    actual: expected,
    requestedModel: 'editorial-model',
    actualModel: 'editorial-model',
    caseId,
  }));
  const deliverableTypes = [
    'research_plan',
    'competitive_analysis_report',
    'voc_diagnosis_report',
    'design_audit_report',
    'accessibility_audit_report',
  ];
  const samples = Array.from({ length: 10 }, (_, index) => ({
    sampleKey: `sha256:${String(index + 1).padStart(64, '0')}`,
    deliverableType: deliverableTypes[index % deliverableTypes.length]!,
    presentationMode: index < 2 ? 'multimodal' as const : 'current_text' as const,
    hasExportableRaster: index === 1,
    egressDecision: index < 5 ? 'allow' as const : 'deny' as const,
    status: index < 4 ? 'ready' as const : 'degraded' as const,
    cacheHit: false as const,
    actualOutboundCallCount: index < 4 ? 2 : 0,
    modelIdentities: index < 4 ? [
      {
        requestedModel: 'editorial-model',
        expectedModel: 'editorial-model',
        actualModel: 'editorial-model',
      },
      {
        requestedModel: 'editorial-model',
        expectedModel: 'editorial-model',
        actualModel: 'editorial-model',
      },
    ] : [],
    paraphraseCount: index < 4 ? 1 : 0,
    fidelityPassed: index < 4,
    ...(index === 4 ? {
      reasonCodes: ['CONTENT_FIDELITY', 'MATERIAL_BUDGET_EXCEEDED'],
    } : index >= 5 ? { reasonCodes: ['EGRESS_POLICY_DENIED'] } : {}),
    ...(index < 4 ? {
      generationId: `er_${String(index + 1).padStart(64, '0')}`,
      htmlHash: `sha256:${String(index + 11).padStart(64, '0')}`,
    } : {}),
    renderedCompositionKinds: index === 0
      ? ['metric-cards', 'truth-triad', 'card-grid', 'flow', 'roadmap']
      : [],
    hasRiskSection: index === 0,
    hasRiskRegister: index === 0,
  }));
  return {
    golden: { cases: goldenCases },
    corpus: { samples },
    reference: { sampleKey: samples[0]!.sampleKey, allRubricItemsPassed: true },
  };
}

test('gate uses exact ready and budget floors at N_allow=5', () => {
  const passing = passingGateInput();
  assert.deepEqual(evaluateEditorialCalibrationGate(passing), { passed: true, failedCodes: [] });

  const readyBelowFloor = structuredClone(passing);
  readyBelowFloor.corpus.samples[3]!.status = 'degraded';
  readyBelowFloor.corpus.samples[3]!.reasonCodes = ['CONTENT_FIDELITY'];
  assert.deepEqual(
    evaluateEditorialCalibrationGate(readyBelowFloor).failedCodes,
    ['CORPUS_READY_RATE_BELOW_MINIMUM'],
  );

  const budgetAboveFloor = structuredClone(passing);
  budgetAboveFloor.corpus.samples[3]!.status = 'degraded';
  budgetAboveFloor.corpus.samples[3]!.reasonCodes = [
    'CONTENT_FIDELITY',
    'MATERIAL_BUDGET_EXCEEDED',
  ];
  assert.deepEqual(
    evaluateEditorialCalibrationGate(budgetAboveFloor).failedCodes,
    ['CORPUS_READY_RATE_BELOW_MINIMUM', 'CORPUS_BUDGET_DEGRADED_RATE_EXCEEDED'],
  );
});

function evidenceFromDraft(draft: {
  fixtureHash: string;
  gatewayConfigurationHash: string;
  golden: unknown;
  corpus: unknown;
  reference: unknown;
}): Record<string, unknown> {
  return {
    version: 'editorial-phase2-calibration-evidence-v1',
    fixtureHash: draft.fixtureHash,
    gatewayConfigurationHash: draft.gatewayConfigurationHash,
    golden: draft.golden,
    corpus: draft.corpus,
    reference: draft.reference,
  };
}

function passingDraftAndRubric() {
  const evidence = passingGateInput();
  const samples = evidence.corpus.samples.map((sample, index) => ({
    ...sample,
    ...((sample.status === 'ready' || sample.status === 'degraded') && sample.generationId === undefined
      ? {
          generationId: `er_${String(index + 31).padStart(64, '0')}`,
          htmlHash: `sha256:${String(index + 41).padStart(64, '0')}`,
        }
      : {}),
    metrics: {
      unitCount: index + 1,
      normalizedTextCodePoints: (index + 1) * 10,
      modelContextBytes: (index + 1) * 100,
      htmlBytes: (index + 1) * 1_000,
      exportedAssetCount: index === 1 ? 1 : 0,
    },
  }));
  const referenceSample = samples[0]!;
  const captures = {
    desktopPngHash: `sha256:${'a'.repeat(64)}`,
    mobilePngHash: `sha256:${'b'.repeat(64)}`,
    a4PdfHash: `sha256:${'c'.repeat(64)}`,
  };
  const draft = {
    version: 'editorial-phase2-calibration-draft-v1' as const,
    evidenceHash: `sha256:${'0'.repeat(64)}`,
    baseMainCommit: '49e4b7fda5f7ce2eeb525fab0dd9daae97226cea',
    implementationCommit: '1'.repeat(40),
    pipelineVersion: 'editorial-report-pipeline-v2',
    copyEditPromptVersion: 'editorial-copy-edit-prompt-v1',
    fidelityPromptVersion: 'editorial-fidelity-prompt-v2',
    fixtureHash: contentHash(readFileSync(
      new URL('./fixtures/editorial-fidelity-golden.json', import.meta.url),
    )),
    gatewayConfigurationHash: `sha256:${'e'.repeat(64)}`,
    runId: `run_${'f'.repeat(32)}`,
    golden: evidence.golden,
    corpus: { samples },
    reference: {
      sampleKey: referenceSample.sampleKey,
      generationId: referenceSample.generationId!,
      htmlHash: referenceSample.htmlHash!,
      manifestHash: `sha256:${'9'.repeat(64)}`,
      captures,
    },
  };
  draft.evidenceHash = canonicalSha256(evidenceFromDraft(draft));
  const rubric = {
    version: 'editorial-reference-rubric-v1' as const,
    evidenceHash: draft.evidenceHash,
    draftHash: canonicalSha256(draft),
    sampleKey: draft.reference.sampleKey,
    generationId: draft.reference.generationId,
    htmlHash: draft.reference.htmlHash,
    captures,
    reviewer: 'human-reviewer',
    reviewedAt: '2026-08-27T12:00:00.000Z',
    items: {
      desktopHierarchyAndSpacing: true as const,
      mobileNoOverflowOrOcclusion: true as const,
      a4NoClippingAndReadableStates: true as const,
      offlineContentComplete: true as const,
      keyboardHeadingsAndAltUsable: true as const,
      professionalDiverseAndEvidenceBound: true as const,
    },
  };
  return { draft, rubric };
}

test('final result is derived from bound rubric, exact distributions, and a self-excluding hash', () => {
  const { draft, rubric } = passingDraftAndRubric();

  const result = buildEditorialCalibrationResult(draft, rubric);
  assert.deepEqual(result.gate, { passed: true, failedCodes: [] });
  assert.equal(result.corpus.budgetDegradedCount, 1);
  assert.deepEqual(result.corpus.degradedByReason, {
    CONTENT_FIDELITY: 1,
    EGRESS_POLICY_DENIED: 5,
    MATERIAL_BUDGET_EXCEEDED: 1,
  });
  assert.deepEqual(result.corpus.distributions.unitCount, { min: 1, p50: 5, p95: 10, max: 10 });
  assert.equal(result.reference.rubricHash.startsWith('sha256:'), true);
  assert.equal(result.resultHash, computeEditorialCalibrationResultHash(result));
  assert.equal(JSON.stringify(result).includes('a1111111-b222-4333-8444-'), false);

  assert.throws(
    () => buildEditorialCalibrationResult(draft, { ...rubric, generationId: `er_${'0'.repeat(64)}` }),
    (error: unknown) => error instanceof EditorialCalibrationError
      && error.code === 'EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID',
  );
});

function contentHash(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function referenceManifest(input: {
  taskId: string;
  generationId: string;
  htmlBytes: Buffer;
}): Record<string, unknown> {
  const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;
  const configurationBody = {
    provider: 'gateway',
    endpointHost: 'llm-gw.jd.local',
    endpointUrl: 'http://llm-gw.jd.local/v1/chat/completions',
    mode: 'real',
    eligibleAsReal: true,
    redirectMode: 'error',
    routes: [{
      requestedModel: 'editorial-model',
      expectedActualModel: 'editorial-model',
      expectedActualModelExplicit: true,
    }],
    limits: {
      overallTimeoutMs: 90_000,
      maxHttpAttempts: 3,
      maxRetryAfterMs: 5_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 8_000,
    },
  } as const;
  const gatewayConfigurationHash = canonicalSha256(configurationBody);
  const derived = (relativePath: string, mediaType: 'application/json' | 'text/html', byteSize = 2) => ({
    relativePath,
    contentSha256: relativePath === 'editorial-report.html' ? contentHash(input.htmlBytes) : hash('7'),
    byteSize,
    mediaType,
  });
  return {
    version: 'editorial-report-v2',
    authority: 'derived',
    taskId: input.taskId,
    planVersionId: '155a2658-8b6c-4bd7-9078-43636feb9df7',
    attemptId: '255a2658-8b6c-4bd7-9078-43636feb9df7',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    requestKey: `erq_${'3'.repeat(64)}`,
    generationId: input.generationId,
    status: 'ready',
    sourceReportPackage: {
      artifactId: 'report-package-artifact',
      kind: 'report_package',
      schemaVersion: 'v1',
      contentSha256: hash('4'),
    },
    pipeline: {
      materialVersion: 'editorial-material-v1',
      modelContextVersion: 'editorial-model-context-v1',
      modelContextHash: hash('5'),
      copyEditRequestVersion: 'editorial-copy-edit-request-v1',
      copyEditPlanVersion: 'editorial-copy-edit-plan-v1',
      blueprintVersion: 'editorial-blueprint-v1',
      copyEditPromptVersion: 'editorial-copy-edit-prompt-v1',
      fidelityPromptVersion: 'editorial-fidelity-prompt-v2',
      fallbackVersion: 'editorial-fallback-v1',
      rendererVersion: 'editorial-html-v1',
      storeVersion: 'editorial-store-v2',
      modelEgress: {
        policyVersion: 'editorial-model-egress-v1',
        policyHash: EDITORIAL_MODEL_EGRESS_POLICY.policyHash,
        decision: 'allow',
        reasonCode: 'EGRESS_ALLOWED',
        evaluated: {
          sourcePolicySetHash: hash('6'),
          contributingSourceCount: 1,
          sensitivities: ['internal'],
          redactionPolicyVersions: ['v1'],
          provider: 'gateway',
          mode: 'real',
          endpointHost: configurationBody.endpointHost,
          endpointUrl: configurationBody.endpointUrl,
          redirectMode: 'error',
        },
      },
      gatewayConfiguration: { ...configurationBody, gatewayConfigurationHash },
    },
    modelCalls: [{
      stage: 'editorial_blueprint',
      ordinal: 1,
      gatewayConfigurationHash,
      modelContextHash: hash('5'),
      modelContextByteSize: 1,
      promptVersion: 'editorial-copy-edit-prompt-v1',
      promptHash: `sha256:${'8'.repeat(16)}`,
      status: 'succeeded',
      provider: 'gateway',
      endpointHost: configurationBody.endpointHost,
      requestedModel: 'editorial-model',
      expectedModel: 'editorial-model',
      actualModel: 'editorial-model',
      modelVersion: 'editorial-model',
      traceId: 'trace-1',
      responseHash: hash('9'),
    }, {
      stage: 'editorial_fidelity_review',
      ordinal: 1,
      gatewayConfigurationHash,
      modelContextHash: hash('5'),
      modelContextByteSize: 1,
      promptVersion: 'editorial-fidelity-prompt-v2',
      promptHash: `sha256:${'a'.repeat(16)}`,
      status: 'succeeded',
      provider: 'gateway',
      endpointHost: configurationBody.endpointHost,
      requestedModel: 'editorial-model',
      expectedModel: 'editorial-model',
      actualModel: 'editorial-model',
      modelVersion: 'editorial-model',
      traceId: 'trace-2',
      responseHash: hash('a'),
    }],
    exportedAssets: [],
    files: {
      material: derived('editorial-material.json', 'application/json'),
      blueprint: derived('editorial-blueprint.json', 'application/json'),
      diagnostic: derived('editorial-diagnostic.json', 'application/json'),
      html: {
        ...derived('editorial-report.html', 'text/html', input.htmlBytes.byteLength),
        selfContained: true,
        printProfile: 'a4-portrait-v1',
      },
    },
    generatedAt: '2026-08-27T12:00:00.000Z',
  };
}

test('finalize and verify re-read bound reference files and enforce result hash and HEAD fences', async () => {
  const runDirectory = mkdtempSync(join(tmpdir(), 'editorial-calibration-finalize-'));
  try {
    chmodSync(runDirectory, 0o700);
    const { draft, rubric } = passingDraftAndRubric();
    const taskId = 'a1111111-b222-4333-8444-555555555555';
    const htmlBytes = Buffer.from('<!doctype html><title>Reference</title>', 'utf8');
    const captures = {
      desktopPngHash: contentHash('desktop-png'),
      mobilePngHash: contentHash('mobile-png'),
      a4PdfHash: contentHash('a4-pdf'),
    };
    const sampleKey = contentHash(taskId);
    draft.corpus.samples[0]!.sampleKey = sampleKey;
    draft.corpus.samples[0]!.htmlHash = contentHash(htmlBytes);
    draft.reference.sampleKey = sampleKey;
    draft.reference.htmlHash = contentHash(htmlBytes);
    draft.reference.captures = captures;
    rubric.sampleKey = sampleKey;
    rubric.htmlHash = contentHash(htmlBytes);
    rubric.captures = captures;
    const manifest = referenceManifest({
      taskId,
      generationId: draft.reference.generationId,
      htmlBytes,
    });
    draft.gatewayConfigurationHash = (
      ((manifest.pipeline as Record<string, unknown>).gatewayConfiguration as Record<string, unknown>)
        .gatewayConfigurationHash as `sha256:${string}`
    );
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    draft.reference.manifestHash = contentHash(manifestBytes);
    const evidenceBytes = Buffer.from(canonicalEditorialJson(evidenceFromDraft(draft)), 'utf8');
    draft.evidenceHash = contentHash(evidenceBytes);
    rubric.evidenceHash = draft.evidenceHash;
    rubric.draftHash = canonicalSha256(draft);

    const secureWrite = (name: string, value: string | Buffer): void => {
      const path = join(runDirectory, name);
      writeFileSync(path, value, { mode: 0o600 });
      chmodSync(path, 0o600);
    };
    secureWrite('reference-manifest.json', manifestBytes);
    secureWrite('reference-report.html', htmlBytes);
    secureWrite('desktop.png', 'desktop-png');
    secureWrite('mobile.png', 'mobile-png');
    secureWrite('report.pdf', 'a4-pdf');
    secureWrite('phase2-calibration.evidence.json', evidenceBytes);
    secureWrite('phase2-calibration.draft.json', canonicalEditorialJson(draft));
    secureWrite('reference-rubric.json', JSON.stringify(rubric));

    const outputPath = join(runDirectory, 'phase2-calibration.json');
    const result = await finalizeEditorialCalibrationRun({
      draftPath: join(runDirectory, 'phase2-calibration.draft.json'),
      referenceRubricPath: join(runDirectory, 'reference-rubric.json'),
      outputPath,
      currentCommit: draft.implementationCommit,
    });
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.deepEqual(await verifyEditorialCalibrationRun({
      resultPath: outputPath,
      currentCommit: draft.implementationCommit,
    }), result);
    await assert.rejects(
      finalizeEditorialCalibrationRun({
        draftPath: join(runDirectory, 'phase2-calibration.draft.json'),
        referenceRubricPath: join(runDirectory, 'reference-rubric.json'),
        outputPath,
        currentCommit: draft.implementationCommit,
      }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_WRITE_FAILED',
    );
    await assert.rejects(
      verifyEditorialCalibrationRun({ resultPath: outputPath, currentCommit: '2'.repeat(40) }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_COMMIT_MISMATCH',
    );

    writeFileSync(join(runDirectory, 'mobile.png'), 'stale-mobile-png');
    await assert.rejects(
      verifyEditorialCalibrationRun({ resultPath: outputPath, currentCommit: draft.implementationCommit }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID',
    );
    writeFileSync(join(runDirectory, 'mobile.png'), 'mobile-png');

    const originalDraftText = readFileSync(
      join(runDirectory, 'phase2-calibration.draft.json'),
      'utf8',
    );
    const originalRubricText = readFileSync(join(runDirectory, 'reference-rubric.json'), 'utf8');
    const originalEvidenceText = readFileSync(
      join(runDirectory, 'phase2-calibration.evidence.json'),
      'utf8',
    );
    const tamperedDraft = JSON.parse(originalDraftText) as {
      golden: { cases: Array<{ actual: string }> };
    };
    tamperedDraft.golden.cases[20]!.actual = 'faithful';
    const tamperedRubric = JSON.parse(originalRubricText) as { draftHash: string };
    tamperedRubric.draftHash = canonicalSha256(tamperedDraft);
    writeFileSync(
      join(runDirectory, 'phase2-calibration.draft.json'),
      canonicalEditorialJson(tamperedDraft),
    );
    writeFileSync(join(runDirectory, 'reference-rubric.json'), JSON.stringify(tamperedRubric));
    await assert.rejects(
      verifyEditorialCalibrationRun({ resultPath: outputPath, currentCommit: draft.implementationCommit }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_EVIDENCE_INVALID',
    );
    writeFileSync(join(runDirectory, 'phase2-calibration.draft.json'), originalDraftText);
    writeFileSync(join(runDirectory, 'reference-rubric.json'), originalRubricText);

    const tamperedCorpusDraft = JSON.parse(originalDraftText) as {
      corpus: { samples: Array<{ metrics: { unitCount: number } }> };
    };
    tamperedCorpusDraft.corpus.samples[1]!.metrics.unitCount += 1;
    const tamperedCorpusRubric = JSON.parse(originalRubricText) as { draftHash: string };
    tamperedCorpusRubric.draftHash = canonicalSha256(tamperedCorpusDraft);
    writeFileSync(
      join(runDirectory, 'phase2-calibration.draft.json'),
      canonicalEditorialJson(tamperedCorpusDraft),
    );
    writeFileSync(
      join(runDirectory, 'reference-rubric.json'),
      JSON.stringify(tamperedCorpusRubric),
    );
    await assert.rejects(
      verifyEditorialCalibrationRun({ resultPath: outputPath, currentCommit: draft.implementationCommit }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_EVIDENCE_INVALID',
    );
    writeFileSync(join(runDirectory, 'phase2-calibration.draft.json'), originalDraftText);
    writeFileSync(join(runDirectory, 'reference-rubric.json'), originalRubricText);

    const reboundDraft = JSON.parse(originalDraftText) as {
      evidenceHash: string;
      fixtureHash: string;
      gatewayConfigurationHash: string;
      golden: { cases: Array<{ caseId: string }> };
      corpus: unknown;
      reference: unknown;
    };
    reboundDraft.golden.cases[0]!.caseId = 'forged-case';
    const reboundEvidenceText = canonicalEditorialJson(evidenceFromDraft(reboundDraft));
    reboundDraft.evidenceHash = contentHash(reboundEvidenceText);
    const reboundRubric = JSON.parse(originalRubricText) as {
      draftHash: string;
      evidenceHash: string;
    };
    reboundRubric.evidenceHash = reboundDraft.evidenceHash;
    reboundRubric.draftHash = canonicalSha256(reboundDraft);
    writeFileSync(
      join(runDirectory, 'phase2-calibration.draft.json'),
      canonicalEditorialJson(reboundDraft),
    );
    writeFileSync(join(runDirectory, 'phase2-calibration.evidence.json'), reboundEvidenceText);
    writeFileSync(join(runDirectory, 'reference-rubric.json'), JSON.stringify(reboundRubric));
    await assert.rejects(
      verifyEditorialCalibrationRun({ resultPath: outputPath, currentCommit: draft.implementationCommit }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_GOLDEN_INVALID',
    );
    writeFileSync(join(runDirectory, 'phase2-calibration.draft.json'), originalDraftText);
    writeFileSync(join(runDirectory, 'phase2-calibration.evidence.json'), originalEvidenceText);
    writeFileSync(join(runDirectory, 'reference-rubric.json'), originalRubricText);

    const tampered = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    (tampered.corpus as Record<string, unknown>).readyCount = 0;
    writeFileSync(outputPath, JSON.stringify(tampered));
    await assert.rejects(
      verifyEditorialCalibrationRun({ resultPath: outputPath, currentCommit: draft.implementationCommit }),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_RESULT_HASH_INVALID',
    );
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

function corpusSamples(referenceIndexes: number[] = [0]): Array<{ taskId: string; referenceCase: boolean }> {
  return Array.from({ length: 10 }, (_, index) => ({
    taskId: `a1111111-b222-4333-8444-${String(index + 1).padStart(12, '0')}`,
    referenceCase: referenceIndexes.includes(index),
  }));
}

test('corpus parser rejects unknown fields, duplicates, undersized sets, and non-unique reference cases', () => {
  const valid = {
    version: 'editorial-calibration-corpus-v1',
    samples: corpusSamples(),
  };
  assert.deepEqual(parseEditorialCalibrationCorpus(valid), valid);

  const invalid: unknown[] = [
    { ...valid, extra: true },
    { ...valid, samples: valid.samples.map((sample, index) => index === 1 ? valid.samples[0] : sample) },
    { ...valid, samples: valid.samples.slice(0, 9) },
    { ...valid, samples: corpusSamples([]) },
    { ...valid, samples: corpusSamples([0, 1]) },
    { ...valid, samples: valid.samples.map((sample, index) => index === 0 ? { ...sample, extra: true } : sample) },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => parseEditorialCalibrationCorpus(candidate),
      (error: unknown) => error instanceof EditorialCalibrationError
        && error.code === 'EDITORIAL_CALIBRATION_CORPUS_INVALID',
    );
  }
});

test('collect rejects a non-owner-only or non-empty run directory before collection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editorial-calibration-'));
  try {
    chmodSync(root, 0o700);
    const corpusPath = join(root, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify({
      version: 'editorial-calibration-corpus-v1',
      samples: [{ taskId: 'a1111111-b222-4333-8444-555555555555', referenceCase: true }],
    }), { mode: 0o600 });
    chmodSync(corpusPath, 0o600);

    const insecureRun = join(root, 'run.insecure');
    mkdirSync(insecureRun, { mode: 0o755 });
    chmodSync(insecureRun, 0o755);
    const errors: string[] = [];
    let collectCalls = 0;
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', insecureRun,
    ], {
      calibrationRoot: root,
      currentCommit: () => '1'.repeat(40),
      collect: async () => {
        collectCalls += 1;
        throw new Error('must not run');
      },
      close: async () => undefined,
      writeStderr: (line) => errors.push(line),
    }), 1);
    assert.deepEqual(errors, ['EDITORIAL_CALIBRATION_DIRECTORY_PERMISSION_INVALID']);
    assert.equal(collectCalls, 0);

    const dirtyRun = join(root, 'run.dirty');
    mkdirSync(dirtyRun, { mode: 0o700 });
    chmodSync(dirtyRun, 0o700);
    writeFileSync(join(dirtyRun, 'old-ready.json'), '{}', { mode: 0o600 });
    errors.length = 0;
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', dirtyRun,
    ], {
      calibrationRoot: root,
      currentCommit: () => '1'.repeat(40),
      collect: async () => {
        collectCalls += 1;
        throw new Error('must not run');
      },
      close: async () => undefined,
      writeStderr: (line) => errors.push(line),
    }), 1);
    assert.deepEqual(errors, ['EDITORIAL_CALIBRATION_RUN_NOT_EMPTY']);
    assert.equal(collectCalls, 0);

    const secureRun = join(root, 'run.secure');
    mkdirSync(secureRun, { mode: 0o700 });
    chmodSync(secureRun, 0o700);
    chmodSync(corpusPath, 0o644);
    errors.length = 0;
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', secureRun,
    ], {
      calibrationRoot: root,
      currentCommit: () => '1'.repeat(40),
      collect: async () => {
        collectCalls += 1;
        throw new Error('must not run');
      },
      close: async () => undefined,
      writeStderr: (line) => errors.push(line),
    }), 1);
    assert.deepEqual(errors, ['EDITORIAL_CALIBRATION_FILE_PERMISSION_INVALID']);
    assert.equal(collectCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collect accepts only the fixed calibration corpus and a direct run.* child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editorial-calibration-paths-'));
  try {
    chmodSync(root, 0o700);
    const corpus = JSON.stringify({
      version: 'editorial-calibration-corpus-v1',
      samples: corpusSamples(),
    });
    const corpusPath = join(root, 'corpus.json');
    const wrongCorpusPath = join(root, 'other.json');
    writeFileSync(corpusPath, corpus, { mode: 0o600 });
    writeFileSync(wrongCorpusPath, corpus, { mode: 0o600 });
    chmodSync(corpusPath, 0o600);
    chmodSync(wrongCorpusPath, 0o600);
    const directRun = join(root, 'run.direct');
    mkdirSync(directRun, { mode: 0o700 });
    chmodSync(directRun, 0o700);
    const nestedRoot = join(root, 'nested');
    const nestedRun = join(nestedRoot, 'run.nested');
    mkdirSync(nestedRoot, { mode: 0o700 });
    mkdirSync(nestedRun, { mode: 0o700 });
    chmodSync(nestedRoot, 0o700);
    chmodSync(nestedRun, 0o700);
    let collectCalls = 0;
    const errors: string[] = [];
    const dependencies = {
      calibrationRoot: root,
      currentCommit: () => '1'.repeat(40),
      collect: async (): Promise<EditorialCalibrationCollection> => {
        collectCalls += 1;
        throw new Error('must not run');
      },
      close: async () => undefined,
      writeStderr: (line: string) => errors.push(line),
    };

    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', wrongCorpusPath, '--run-dir', directRun,
    ], dependencies), 1);
    assert.deepEqual(errors, ['EDITORIAL_CALIBRATION_PATH_INVALID']);
    errors.length = 0;
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', nestedRun,
    ], dependencies), 1);
    assert.deepEqual(errors, ['EDITORIAL_CALIBRATION_PATH_INVALID']);
    assert.equal(collectCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collect persists an anonymous owner-only draft, empty store, captures, and bound rubric template', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editorial-calibration-collect-'));
  try {
    chmodSync(root, 0o700);
    const corpus = {
      version: 'editorial-calibration-corpus-v1' as const,
      samples: corpusSamples(),
    };
    const corpusPath = join(root, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify(corpus), { mode: 0o600 });
    chmodSync(corpusPath, 0o600);
    const runDirectory = join(root, 'run.secure');
    mkdirSync(runDirectory, { mode: 0o700 });
    chmodSync(runDirectory, 0o700);
    const { draft } = passingDraftAndRubric();
    draft.corpus.samples.forEach((sample, index) => {
      sample.sampleKey = contentHash(corpus.samples[index]!.taskId);
    });
    const referenceSample = draft.corpus.samples[0]!;
    const htmlBytes = Buffer.from('<!doctype html><title>Collected reference</title>', 'utf8');
    referenceSample.htmlHash = contentHash(htmlBytes);
    draft.reference.sampleKey = referenceSample.sampleKey;
    draft.reference.htmlHash = referenceSample.htmlHash;
    const manifest = referenceManifest({
      taskId: corpus.samples[0]!.taskId,
      generationId: referenceSample.generationId!,
      htmlBytes,
    });
    draft.gatewayConfigurationHash = (
      ((manifest.pipeline as Record<string, unknown>).gatewayConfiguration as Record<string, unknown>)
        .gatewayConfigurationHash as `sha256:${string}`
    );
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const makeCollection = (
      golden: EditorialCalibrationCollection['golden'] = draft.golden,
    ): EditorialCalibrationCollection => ({
      fixtureHash: draft.fixtureHash,
      gatewayConfigurationHash: draft.gatewayConfigurationHash as `sha256:${string}`,
      golden,
      corpus: draft.corpus,
      reference: {
        sampleKey: referenceSample.sampleKey as `sha256:${string}`,
        generationId: referenceSample.generationId!,
        htmlHash: referenceSample.htmlHash! as `sha256:${string}`,
        manifestBytes,
        htmlBytes,
        desktopPngBytes: Buffer.from('desktop-png'),
        mobilePngBytes: Buffer.from('mobile-png'),
        a4PdfBytes: Buffer.from('a4-pdf'),
      },
    });
    const stdout: string[] = [];
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', runDirectory,
    ], {
      calibrationRoot: root,
      currentCommit: () => draft.implementationCommit,
      collect: async ({ corpus: parsedCorpus, storeDirectory }) => {
        assert.deepEqual(parsedCorpus, corpus);
        assert.equal(statSync(storeDirectory).mode & 0o777, 0o700);
        assert.deepEqual(readdirSync(storeDirectory), []);
        return makeCollection();
      },
      close: async () => undefined,
      writeStdout: (line) => stdout.push(line),
    }), 0);
    assert.equal(stdout.length, 1);
    assert.deepEqual((JSON.parse(stdout[0]!) as { gate: unknown }).gate, {
      passed: true,
      failedCodes: [],
    });

    for (const name of [
      'phase2-calibration.evidence.json',
      'phase2-calibration.draft.json',
      'reference-rubric.json',
      'reference-manifest.json',
      'reference-report.html',
      'desktop.png',
      'mobile.png',
      'report.pdf',
    ]) assert.equal(statSync(join(runDirectory, name)).mode & 0o777, 0o600, name);
    assert.equal(statSync(join(runDirectory, 'store')).mode & 0o777, 0o700);
    const draftText = readFileSync(join(runDirectory, 'phase2-calibration.draft.json'), 'utf8');
    assert.equal(draftText.includes(corpus.samples[0]!.taskId), false);
    const rubric = JSON.parse(readFileSync(join(runDirectory, 'reference-rubric.json'), 'utf8')) as {
      evidenceHash: string;
      draftHash: string;
      reviewer: string;
      reviewedAt: string;
      items: Record<string, boolean>;
    };
    const evidenceText = readFileSync(
      join(runDirectory, 'phase2-calibration.evidence.json'),
      'utf8',
    );
    assert.equal(rubric.evidenceHash, contentHash(evidenceText));
    assert.equal(rubric.draftHash, contentHash(draftText));
    assert.equal(rubric.reviewer, '');
    assert.equal(rubric.reviewedAt, '');
    assert.equal(Object.values(rubric.items).every((value) => value === false), true);

    const failedRun = join(root, 'run.failed-gate');
    mkdirSync(failedRun, { mode: 0o700 });
    chmodSync(failedRun, 0o700);
    const failedGolden = structuredClone(draft.golden);
    failedGolden.cases.find(({ expected }) => expected === 'unsupported')!.actual = 'faithful';
    const failedStdout: string[] = [];
    const failedStderr: string[] = [];
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', failedRun,
    ], {
      calibrationRoot: root,
      currentCommit: () => draft.implementationCommit,
      collect: async () => makeCollection(failedGolden),
      close: async () => undefined,
      writeStdout: (line) => failedStdout.push(line),
      writeStderr: (line) => failedStderr.push(line),
    }), 1);
    assert.deepEqual(failedStderr, ['EDITORIAL_CALIBRATION_GATE_FAILED']);
    assert.deepEqual((JSON.parse(failedStdout[0]!) as { gate: unknown }).gate, {
      passed: false,
      failedCodes: ['GOLDEN_FALSE_ALLOW_THRESHOLD_EXCEEDED'],
    });
    assert.equal(
      readdirSync(failedRun).includes('phase2-calibration.draft.json'),
      true,
    );

    const permissionRun = join(root, 'run.permission-change');
    mkdirSync(permissionRun, { mode: 0o700 });
    chmodSync(permissionRun, 0o700);
    const permissionErrors: string[] = [];
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', permissionRun,
    ], {
      calibrationRoot: root,
      currentCommit: () => draft.implementationCommit,
      collect: async ({ storeDirectory }) => {
        chmodSync(storeDirectory, 0o755);
        return makeCollection();
      },
      close: async () => undefined,
      writeStderr: (line) => permissionErrors.push(line),
    }), 1);
    assert.deepEqual(permissionErrors, ['EDITORIAL_CALIBRATION_DIRECTORY_PERMISSION_INVALID']);
    assert.equal(readdirSync(permissionRun).includes('phase2-calibration.draft.json'), false);

    const commitRun = join(root, 'run.commit-change');
    mkdirSync(commitRun, { mode: 0o700 });
    chmodSync(commitRun, 0o700);
    let commitReads = 0;
    const commitErrors: string[] = [];
    assert.equal(await runEditorialCalibrationCli([
      '--collect', '--corpus', corpusPath, '--run-dir', commitRun,
    ], {
      calibrationRoot: root,
      currentCommit: () => (++commitReads === 1 ? draft.implementationCommit : '2'.repeat(40)),
      collect: async () => makeCollection(),
      close: async () => undefined,
      writeStderr: (line) => commitErrors.push(line),
    }), 1);
    assert.deepEqual(commitErrors, ['EDITORIAL_CALIBRATION_COMMIT_MISMATCH']);
    assert.equal(readdirSync(commitRun).includes('phase2-calibration.draft.json'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
