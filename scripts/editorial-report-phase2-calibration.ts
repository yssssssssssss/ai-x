import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { createEditorialModelPort } from '../apps/orchestrator-runtime/src/editorial-report.ts';

import {
  EDITORIAL_BLUEPRINT_PROMPT_VERSION,
  EDITORIAL_FIDELITY_PROMPT_VERSION,
  canonicalEditorialJson,
  canonicalSha256,
  enumerateEditorialParaphrases,
  evaluateEditorialModelEgress,
  hashBytes,
  parseEditorialBlueprint,
  parseEditorialDiagnostic,
  parseEditorialFidelityReviewPlan,
  parseEditorialMaterial,
  parseEditorialModelContext,
  parseEditorialReport,
  type EditorialArtifactReader,
  type EditorialModelContext,
  type EditorialModelPort,
  type EditorialStructuredModelClient,
  type EditorialTaskReader,
  type Sha256,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { materializeEditorialReport } from '../apps/orchestrator-runtime/src/report/editorial-report-materializer.ts';
import {
  EDITORIAL_FIDELITY_PROMPT,
  EDITORIAL_MODEL_SYSTEM_PROMPT,
  EditorialReportPipeline,
} from '../apps/orchestrator-runtime/src/report/editorial-report-pipeline.ts';
import { renderEditorialReport } from '../apps/orchestrator-runtime/src/report/editorial-report-renderer.ts';
import { EditorialSourceReader } from '../apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts';
import { EditorialReportStore } from '../apps/orchestrator-runtime/src/report/editorial-report-store.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { hashPrompt, LLMInvocationError, type LLMResult } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { loadSchemaText, resolveSchema } from '../apps/orchestrator-runtime/src/runtime/schema-registry.ts';
import { closePool, pool } from '../database/db.ts';
import { ControlPlaneRepository } from '../database/control-plane.ts';

const ARGUMENT_FAILURE_CODE = 'EDITORIAL_CALIBRATION_ARGUMENT_INVALID' as const;
const BASE_MAIN_COMMIT = '49e4b7fda5f7ce2eeb525fab0dd9daae97226cea';
const MAX_CALIBRATION_JSON_BYTES = 8 * 1024 * 1024;
const REFERENCE_MANIFEST_FILE = 'reference-manifest.json';
const REFERENCE_HTML_FILE = 'reference-report.html';
const DESKTOP_CAPTURE_FILE = 'desktop.png';
const MOBILE_CAPTURE_FILE = 'mobile.png';
const PDF_CAPTURE_FILE = 'report.pdf';
const EVIDENCE_FILE = 'phase2-calibration.evidence.json';
const DRAFT_FILE = 'phase2-calibration.draft.json';
const RUBRIC_FILE = 'reference-rubric.json';
const RESULT_FILE = 'phase2-calibration.json';
const CALIBRATION_PIPELINE_VERSION = 'editorial-report-pipeline-v2';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface EditorialCalibrationCorpus {
  version: 'editorial-calibration-corpus-v1';
  samples: Array<{ taskId: string; referenceCase: boolean }>;
}

export type EditorialCalibrationFidelityVerdict =
  | 'faithful'
  | 'narrower'
  | 'unsupported'
  | 'certainty_upgraded'
  | 'numeric_drift'
  | 'qualification_lost';

export interface EditorialCalibrationGoldenCaseResult {
  caseId: string;
  expected: EditorialCalibrationFidelityVerdict;
  actual: EditorialCalibrationFidelityVerdict | 'call_failed' | 'schema_invalid';
  requestedModel: string;
  actualModel?: string;
}

export interface EditorialFidelityGoldenCase {
  caseId: string;
  expected: EditorialCalibrationFidelityVerdict;
  modelContext: EditorialModelContext;
  paraphrase: {
    copyPointer: string;
    text: string;
    materialUnitIds: string[];
  };
}

export interface EditorialFidelityGoldenFixture {
  version: 'editorial-fidelity-golden-v1';
  cases: EditorialFidelityGoldenCase[];
}

export interface EditorialCalibrationSampleResult {
  sampleKey: string;
  deliverableType: string;
  presentationMode: 'current_text' | 'multimodal';
  hasExportableRaster: boolean;
  egressDecision: 'allow' | 'deny';
  status: 'ready' | 'degraded' | 'fail';
  cacheHit: false;
  actualOutboundCallCount: number;
  modelIdentities: Array<{
    requestedModel: string;
    expectedModel: string;
    actualModel: string;
  }>;
  paraphraseCount: number;
  fidelityPassed: boolean;
  reasonCodes?: string[];
  generationId?: string;
  htmlHash?: string;
  renderedCompositionKinds: string[];
  hasRiskSection: boolean;
  hasRiskRegister: boolean;
}

const METRIC_NAMES = [
  'unitCount',
  'normalizedTextCodePoints',
  'modelContextBytes',
  'htmlBytes',
  'exportedAssetCount',
] as const;
type EditorialCalibrationMetricName = typeof METRIC_NAMES[number];
type EditorialCalibrationMetrics = Record<EditorialCalibrationMetricName, number>;

export interface EditorialCalibrationSampleEvidence extends EditorialCalibrationSampleResult {
  metrics: EditorialCalibrationMetrics;
}

export interface EditorialCalibrationDraft {
  version: 'editorial-phase2-calibration-draft-v1';
  evidenceHash: Sha256;
  baseMainCommit: string;
  implementationCommit: string;
  pipelineVersion: string;
  blueprintPromptVersion: string;
  fidelityPromptVersion: string;
  fixtureHash: Sha256;
  gatewayConfigurationHash: Sha256;
  runId: string;
  golden: { cases: EditorialCalibrationGoldenCaseResult[] };
  corpus: { samples: EditorialCalibrationSampleEvidence[] };
  reference: {
    sampleKey: Sha256;
    generationId: string;
    htmlHash: Sha256;
    manifestHash: Sha256;
    captures: EditorialReferenceCaptureHashes;
  };
}

export interface EditorialReferenceCaptureHashes {
  desktopPngHash: Sha256;
  mobilePngHash: Sha256;
  a4PdfHash: Sha256;
}

export interface EditorialReferenceRubric {
  version: 'editorial-reference-rubric-v1';
  evidenceHash: Sha256;
  draftHash: Sha256;
  sampleKey: Sha256;
  generationId: string;
  htmlHash: Sha256;
  captures: EditorialReferenceCaptureHashes;
  reviewer: string;
  reviewedAt: string;
  items: {
    desktopHierarchyAndSpacing: boolean;
    mobileNoOverflowOrOcclusion: boolean;
    a4NoClippingAndReadableStates: boolean;
    offlineContentComplete: boolean;
    keyboardHeadingsAndAltUsable: boolean;
    professionalDiverseAndEvidenceBound: boolean;
  };
}

export interface EditorialCalibrationCollection {
  fixtureHash: Sha256;
  gatewayConfigurationHash: Sha256;
  golden: { cases: EditorialCalibrationGoldenCaseResult[] };
  corpus: { samples: EditorialCalibrationSampleEvidence[] };
  reference: {
    sampleKey: Sha256;
    generationId: string;
    htmlHash: Sha256;
    manifestBytes: Uint8Array;
    htmlBytes: Uint8Array;
    desktopPngBytes: Uint8Array;
    mobilePngBytes: Uint8Array;
    a4PdfBytes: Uint8Array;
  };
}

interface EditorialCalibrationEvidence {
  version: 'editorial-phase2-calibration-evidence-v1';
  fixtureHash: Sha256;
  gatewayConfigurationHash: Sha256;
  golden: EditorialCalibrationDraft['golden'];
  corpus: EditorialCalibrationDraft['corpus'];
  reference: EditorialCalibrationDraft['reference'];
}

interface EditorialMetricDistribution {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface EditorialPhase2CalibrationResult {
  version: 'editorial-phase2-calibration-v1';
  evidenceHash: Sha256;
  baseMainCommit: string;
  implementationCommit: string;
  pipelineVersion: string;
  blueprintPromptVersion: string;
  fidelityPromptVersion: string;
  fixtureHash: Sha256;
  gatewayConfigurationHash: Sha256;
  runId: string;
  golden: {
    total: 60;
    cases: EditorialCalibrationGoldenCaseResult[];
    falseAllows: number;
    falseBlocks: number;
  };
  corpus: {
    total: number;
    allowCount: number;
    readyCount: number;
    hardFailCount: number;
    budgetDegradedCount: number;
    degradedByReason: Record<string, number>;
    distributions: Record<EditorialCalibrationMetricName, EditorialMetricDistribution>;
    samples: EditorialCalibrationSampleResult[];
  };
  reference: {
    sampleKey: Sha256;
    generationId: string;
    htmlHash: Sha256;
    captures: EditorialReferenceCaptureHashes;
    rubricHash: Sha256;
    allRubricItemsPassed: boolean;
  };
  gate: EditorialCalibrationGate;
  resultHash: Sha256;
}

export interface EditorialCalibrationGateInput {
  golden: { cases: EditorialCalibrationGoldenCaseResult[] };
  corpus: { samples: EditorialCalibrationSampleResult[] };
  reference: { sampleKey: string; allRubricItemsPassed: boolean };
}

export interface EditorialCalibrationGate {
  passed: boolean;
  failedCodes: string[];
}

const FIDELITY_VERDICTS: readonly EditorialCalibrationFidelityVerdict[] = [
  'faithful',
  'narrower',
  'unsupported',
  'certainty_upgraded',
  'numeric_drift',
  'qualification_lost',
];
const SAFE_FIDELITY_VERDICTS = new Set<EditorialCalibrationFidelityVerdict>(['faithful', 'narrower']);
const REQUIRED_DELIVERABLE_TYPES = [
  'research_plan',
  'competitive_analysis_report',
  'voc_diagnosis_report',
  'design_audit_report',
  'accessibility_audit_report',
] as const;
const GATE_CODE_ORDER = [
  'GOLDEN_FIXTURE_INVALID',
  'GOLDEN_FALSE_ALLOW_THRESHOLD_EXCEEDED',
  'GOLDEN_FALSE_BLOCK_THRESHOLD_EXCEEDED',
  'CORPUS_SAMPLE_COUNT_BELOW_MINIMUM',
  'CORPUS_DELIVERABLE_COVERAGE_INCOMPLETE',
  'CORPUS_MULTIMODAL_COUNT_BELOW_MINIMUM',
  'CORPUS_RASTER_COVERAGE_MISSING',
  'CORPUS_ALLOW_COUNT_BELOW_MINIMUM',
  'CORPUS_HARD_FAIL_PRESENT',
  'CORPUS_READY_RATE_BELOW_MINIMUM',
  'CORPUS_BUDGET_DEGRADED_RATE_EXCEEDED',
  'CORPUS_CACHE_EVIDENCE_INVALID',
  'EGRESS_DENY_ZERO_CALL_EVIDENCE_MISSING',
  'MODEL_IDENTITY_EVIDENCE_INVALID',
  'REFERENCE_READY_REQUIRED',
  'REFERENCE_OUTBOUND_EVIDENCE_MISSING',
  'REFERENCE_PARAPHRASE_REQUIRED',
  'REFERENCE_FIDELITY_REQUIRED',
  'REFERENCE_COMPOSITION_DIVERSITY_REQUIRED',
  'REFERENCE_RISK_SECTION_REQUIRED',
  'REFERENCE_RISK_REGISTER_REQUIRED',
  'REFERENCE_RUBRIC_FAILED',
] as const;

function isBudgetDegraded(sample: EditorialCalibrationSampleResult): boolean {
  return sample.egressDecision === 'allow'
    && sample.status === 'degraded'
    && sample.reasonCodes?.some((code) => code.includes('BUDGET')) === true;
}

export function evaluateEditorialCalibrationGate(
  input: EditorialCalibrationGateInput,
): EditorialCalibrationGate {
  const failed = new Set<string>();
  const counts = new Map<EditorialCalibrationFidelityVerdict, number>(
    FIDELITY_VERDICTS.map((verdict) => [verdict, 0]),
  );
  let falseAllows = 0;
  let falseBlocks = 0;
  for (const candidate of input.golden.cases) {
    counts.set(candidate.expected, (counts.get(candidate.expected) ?? 0) + 1);
    const expectedSafe = SAFE_FIDELITY_VERDICTS.has(candidate.expected);
    const actualSafe = candidate.actual === 'faithful' || candidate.actual === 'narrower';
    if (!expectedSafe && actualSafe) falseAllows += 1;
    if (expectedSafe && !actualSafe) falseBlocks += 1;
  }
  if (
    input.golden.cases.length !== 60
    || FIDELITY_VERDICTS.some((verdict) => counts.get(verdict) !== 10)
  ) failed.add('GOLDEN_FIXTURE_INVALID');
  if (falseAllows > 0) failed.add('GOLDEN_FALSE_ALLOW_THRESHOLD_EXCEEDED');
  if (falseBlocks > 1) failed.add('GOLDEN_FALSE_BLOCK_THRESHOLD_EXCEEDED');

  const samples = input.corpus.samples;
  if (samples.length < 10) failed.add('CORPUS_SAMPLE_COUNT_BELOW_MINIMUM');
  const deliverables = new Set(samples.map(({ deliverableType }) => deliverableType));
  if (REQUIRED_DELIVERABLE_TYPES.some((type) => !deliverables.has(type))) {
    failed.add('CORPUS_DELIVERABLE_COVERAGE_INCOMPLETE');
  }
  if (samples.filter(({ presentationMode }) => presentationMode === 'multimodal').length < 2) {
    failed.add('CORPUS_MULTIMODAL_COUNT_BELOW_MINIMUM');
  }
  if (!samples.some(({ hasExportableRaster }) => hasExportableRaster)) {
    failed.add('CORPUS_RASTER_COVERAGE_MISSING');
  }
  const allowSamples = samples.filter(({ egressDecision }) => egressDecision === 'allow');
  if (allowSamples.length < 5) failed.add('CORPUS_ALLOW_COUNT_BELOW_MINIMUM');
  if (samples.some(({ status }) => status === 'fail')) failed.add('CORPUS_HARD_FAIL_PRESENT');
  const allowReadyCount = allowSamples.filter(({ status }) => status === 'ready').length;
  if (allowReadyCount < Math.ceil(allowSamples.length * 0.8)) {
    failed.add('CORPUS_READY_RATE_BELOW_MINIMUM');
  }
  if (allowSamples.filter(isBudgetDegraded).length > Math.floor(allowSamples.length * 0.2)) {
    failed.add('CORPUS_BUDGET_DEGRADED_RATE_EXCEEDED');
  }
  if (samples.some(({ cacheHit }) => cacheHit !== false)) {
    failed.add('CORPUS_CACHE_EVIDENCE_INVALID');
  }
  const denySamples = samples.filter(({ egressDecision }) => egressDecision === 'deny');
  if (
    denySamples.length === 0
    || denySamples.some(({ actualOutboundCallCount }) => actualOutboundCallCount !== 0)
  ) failed.add('EGRESS_DENY_ZERO_CALL_EVIDENCE_MISSING');
  const readyWithInvalidIdentity = allowSamples.some((sample) => sample.status === 'ready' && (
    sample.modelIdentities.length === 0
    || sample.modelIdentities.some((identity) => (
      !identity.requestedModel
      || !identity.expectedModel
      || identity.actualModel !== identity.expectedModel
    ))
  ));
  if (readyWithInvalidIdentity) failed.add('MODEL_IDENTITY_EVIDENCE_INVALID');

  const reference = samples.find(({ sampleKey }) => sampleKey === input.reference.sampleKey);
  if (!reference || reference.status !== 'ready' || reference.egressDecision !== 'allow') {
    failed.add('REFERENCE_READY_REQUIRED');
  }
  if (!reference || reference.actualOutboundCallCount < 2) {
    failed.add('REFERENCE_OUTBOUND_EVIDENCE_MISSING');
  }
  if (!reference || reference.paraphraseCount < 1) failed.add('REFERENCE_PARAPHRASE_REQUIRED');
  if (!reference?.fidelityPassed) failed.add('REFERENCE_FIDELITY_REQUIRED');
  if (!reference || new Set(reference.renderedCompositionKinds).size < 5) {
    failed.add('REFERENCE_COMPOSITION_DIVERSITY_REQUIRED');
  }
  if (!reference?.hasRiskSection) failed.add('REFERENCE_RISK_SECTION_REQUIRED');
  if (!reference?.hasRiskRegister) failed.add('REFERENCE_RISK_REGISTER_REQUIRED');
  if (!input.reference.allRubricItemsPassed) failed.add('REFERENCE_RUBRIC_FAILED');

  const failedCodes = GATE_CODE_ORDER.filter((code) => failed.has(code));
  return { passed: failedCodes.length === 0, failedCodes };
}

function fidelityConfusion(cases: readonly EditorialCalibrationGoldenCaseResult[]): {
  falseAllows: number;
  falseBlocks: number;
} {
  let falseAllows = 0;
  let falseBlocks = 0;
  for (const candidate of cases) {
    const expectedSafe = SAFE_FIDELITY_VERDICTS.has(candidate.expected);
    const actualSafe = candidate.actual === 'faithful' || candidate.actual === 'narrower';
    if (!expectedSafe && actualSafe) falseAllows += 1;
    if (expectedSafe && !actualSafe) falseBlocks += 1;
  }
  return { falseAllows, falseBlocks };
}

function metricDistribution(values: readonly number[]): EditorialMetricDistribution {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
  const ordered = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number): number => (
    ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)]!
  );
  return {
    min: ordered[0]!,
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    max: ordered.at(-1)!,
  };
}

function calibrationResultBody(
  draft: EditorialCalibrationDraft,
  rubric: EditorialReferenceRubric,
): Omit<EditorialPhase2CalibrationResult, 'resultHash'> {
  const expectedBinding = canonicalEditorialJson({
    evidenceHash: draft.evidenceHash,
    draftHash: canonicalSha256(draft),
    sampleKey: draft.reference.sampleKey,
    generationId: draft.reference.generationId,
    htmlHash: draft.reference.htmlHash,
    captures: draft.reference.captures,
  });
  const rubricBinding = canonicalEditorialJson({
    evidenceHash: rubric.evidenceHash,
    draftHash: rubric.draftHash,
    sampleKey: rubric.sampleKey,
    generationId: rubric.generationId,
    htmlHash: rubric.htmlHash,
    captures: rubric.captures,
  });
  if (expectedBinding !== rubricBinding) {
    calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  }
  const allRubricItemsPassed = Object.values(rubric.items).every((value) => value === true);
  const samples = draft.corpus.samples.map(({ metrics: _metrics, ...sample }) => sample);
  const allowCount = samples.filter(({ egressDecision }) => egressDecision === 'allow').length;
  const readyCount = samples.filter(({ status }) => status === 'ready').length;
  const hardFailCount = samples.filter(({ status }) => status === 'fail').length;
  const budgetDegradedCount = samples.filter(isBudgetDegraded).length;
  const reasonCounts = new Map<string, number>();
  for (const sample of samples) {
    if (sample.status !== 'degraded') continue;
    const reasons = sample.reasonCodes ?? ['DEGRADED_REASON_UNSPECIFIED'];
    for (const reason of reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const degradedByReason = Object.fromEntries(
    [...reasonCounts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  const distributions = Object.fromEntries(METRIC_NAMES.map((name) => [
    name,
    metricDistribution(draft.corpus.samples.map(({ metrics }) => metrics[name])),
  ])) as Record<EditorialCalibrationMetricName, EditorialMetricDistribution>;
  const gate = evaluateEditorialCalibrationGate({
    golden: draft.golden,
    corpus: { samples },
    reference: { sampleKey: draft.reference.sampleKey, allRubricItemsPassed },
  });
  const confusion = fidelityConfusion(draft.golden.cases);
  return {
    version: 'editorial-phase2-calibration-v1',
    evidenceHash: draft.evidenceHash,
    baseMainCommit: draft.baseMainCommit,
    implementationCommit: draft.implementationCommit,
    pipelineVersion: draft.pipelineVersion,
    blueprintPromptVersion: draft.blueprintPromptVersion,
    fidelityPromptVersion: draft.fidelityPromptVersion,
    fixtureHash: draft.fixtureHash,
    gatewayConfigurationHash: draft.gatewayConfigurationHash,
    runId: draft.runId,
    golden: {
      total: 60,
      cases: draft.golden.cases,
      ...confusion,
    },
    corpus: {
      total: samples.length,
      allowCount,
      readyCount,
      hardFailCount,
      budgetDegradedCount,
      degradedByReason,
      distributions,
      samples,
    },
    reference: {
      sampleKey: draft.reference.sampleKey,
      generationId: draft.reference.generationId,
      htmlHash: draft.reference.htmlHash,
      captures: draft.reference.captures,
      rubricHash: canonicalSha256(rubric),
      allRubricItemsPassed,
    },
    gate,
  };
}

export function computeEditorialCalibrationResultHash(
  result: EditorialPhase2CalibrationResult,
): Sha256 {
  const { resultHash: _resultHash, ...body } = result;
  return canonicalSha256(body);
}

function assertAnonymousResult(result: EditorialPhase2CalibrationResult): void {
  const serialized = canonicalEditorialJson(result);
  if (
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(serialized)
    || /(?:https?|file):\/\//iu.test(serialized)
    || /(?:owner[_-]?token|api[_-]?key|authorization|bearer\s)/iu.test(serialized)
  ) calibrationFailure('EDITORIAL_CALIBRATION_SENSITIVE_OUTPUT');
}

export function buildEditorialCalibrationResult(
  draftValue: unknown,
  rubricValue: unknown,
): EditorialPhase2CalibrationResult {
  const draft = parseEditorialCalibrationDraft(draftValue);
  const rubric = parseEditorialReferenceRubric(rubricValue);
  const body = calibrationResultBody(draft, rubric);
  const result = {
    ...body,
    resultHash: canonicalSha256(body),
  } satisfies EditorialPhase2CalibrationResult;
  assertAnonymousResult(result);
  return result;
}

async function readSecureFile(path: string, maximumBytes: number): Promise<Buffer> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_FILE_INVALID');
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600
    || stat.size > maximumBytes
  ) calibrationFailure('EDITORIAL_CALIBRATION_FILE_PERMISSION_INVALID');
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const pinned = await handle.stat();
    if (
      !pinned.isFile()
      || pinned.dev !== stat.dev
      || pinned.ino !== stat.ino
      || pinned.nlink !== 1
      || (pinned.mode & 0o777) !== 0o600
      || pinned.size !== stat.size
      || pinned.size > maximumBytes
    ) calibrationFailure('EDITORIAL_CALIBRATION_FILE_INVALID');
    const bytes = Buffer.alloc(pinned.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) calibrationFailure('EDITORIAL_CALIBRATION_FILE_INVALID');
      offset += bytesRead;
    }
    const trailing = Buffer.alloc(1);
    const { bytesRead: trailingBytes } = await handle.read(trailing, 0, 1, bytes.length);
    const after = await handle.stat();
    if (
      trailingBytes !== 0
      || !after.isFile()
      || after.dev !== pinned.dev
      || after.ino !== pinned.ino
      || after.nlink !== 1
      || (after.mode & 0o777) !== 0o600
      || after.size !== pinned.size
      || after.mtimeMs !== pinned.mtimeMs
      || after.ctimeMs !== pinned.ctimeMs
    ) calibrationFailure('EDITORIAL_CALIBRATION_FILE_INVALID');
    return bytes;
  } catch (error) {
    if (error instanceof EditorialCalibrationError) throw error;
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_FILE_INVALID');
  } finally {
    await handle?.close();
  }
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
}

async function writeSecureFile(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const pinned = await handle.stat();
    if (
      !pinned.isFile()
      || pinned.nlink !== 1
      || (pinned.mode & 0o777) !== 0o600
      || pinned.size !== bytes.byteLength
    ) calibrationFailure('EDITORIAL_CALIBRATION_WRITE_FAILED');
  } catch (error) {
    if (error instanceof EditorialCalibrationError) throw error;
    calibrationFailure('EDITORIAL_CALIBRATION_WRITE_FAILED');
  } finally {
    await handle?.close();
  }
  const persisted = await readSecureFile(path, bytes.byteLength);
  if (!persisted.equals(Buffer.from(bytes))) {
    calibrationFailure('EDITORIAL_CALIBRATION_WRITE_FAILED');
  }
}

async function writeSecureJson(path: string, value: unknown): Promise<void> {
  await writeSecureFile(path, Buffer.from(canonicalEditorialJson(value), 'utf8'));
}

function rubricTemplate(input: {
  evidenceHash: Sha256;
  draftHash: Sha256;
  sampleKey: Sha256;
  generationId: string;
  htmlHash: Sha256;
  captures: EditorialReferenceCaptureHashes;
}): EditorialReferenceRubric {
  return {
    version: 'editorial-reference-rubric-v1',
    evidenceHash: input.evidenceHash,
    draftHash: input.draftHash,
    sampleKey: input.sampleKey,
    generationId: input.generationId,
    htmlHash: input.htmlHash,
    captures: input.captures,
    reviewer: '',
    reviewedAt: '',
    items: {
      desktopHierarchyAndSpacing: false,
      mobileNoOverflowOrOcclusion: false,
      a4NoClippingAndReadableStates: false,
      offlineContentComplete: false,
      keyboardHeadingsAndAltUsable: false,
      professionalDiverseAndEvidenceBound: false,
    },
  };
}

async function persistCalibrationCollection(input: {
  collection: EditorialCalibrationCollection;
  corpus: EditorialCalibrationCorpus;
  runDirectory: string;
  implementationCommit: string;
}): Promise<EditorialCalibrationDraft> {
  const referenceCorpusEntry = input.corpus.samples.find(({ referenceCase }) => referenceCase)!;
  const expectedSampleKeys = input.corpus.samples.map(({ taskId }) => hashBytes(taskId));
  if (
    input.collection.corpus.samples.length !== expectedSampleKeys.length
    || input.collection.corpus.samples.some(({ sampleKey }, index) => sampleKey !== expectedSampleKeys[index])
    || input.collection.reference.sampleKey !== hashBytes(referenceCorpusEntry.taskId)
  ) calibrationFailure('EDITORIAL_CALIBRATION_COLLECTION_INVALID');
  const manifestBytes = Buffer.from(input.collection.reference.manifestBytes);
  const htmlBytes = Buffer.from(input.collection.reference.htmlBytes);
  const desktopBytes = Buffer.from(input.collection.reference.desktopPngBytes);
  const mobileBytes = Buffer.from(input.collection.reference.mobilePngBytes);
  const pdfBytes = Buffer.from(input.collection.reference.a4PdfBytes);
  if (
    manifestBytes.byteLength === 0
    || manifestBytes.byteLength > 256 * 1024
    || htmlBytes.byteLength === 0
    || htmlBytes.byteLength > MAX_CALIBRATION_JSON_BYTES
    || desktopBytes.byteLength === 0
    || desktopBytes.byteLength > 32 * 1024 * 1024
    || mobileBytes.byteLength === 0
    || mobileBytes.byteLength > 32 * 1024 * 1024
    || pdfBytes.byteLength === 0
    || pdfBytes.byteLength > 64 * 1024 * 1024
  ) calibrationFailure('EDITORIAL_CALIBRATION_COLLECTION_INVALID');
  const htmlHash = hashBytes(htmlBytes);
  const manifest = parseReferenceManifestSummary(parseJsonBytes(manifestBytes));
  if (
    hashBytes(manifest.taskId) !== input.collection.reference.sampleKey
    || manifest.generationId !== input.collection.reference.generationId
    || manifest.htmlHash !== htmlHash
    || manifest.htmlByteSize !== htmlBytes.byteLength
    || input.collection.reference.htmlHash !== htmlHash
  ) calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  const captures: EditorialReferenceCaptureHashes = {
    desktopPngHash: hashBytes(desktopBytes),
    mobilePngHash: hashBytes(mobileBytes),
    a4PdfHash: hashBytes(pdfBytes),
  };
  const reference = {
    sampleKey: input.collection.reference.sampleKey,
    generationId: input.collection.reference.generationId,
    htmlHash,
    manifestHash: hashBytes(manifestBytes),
    captures,
  };
  const evidence = parseEditorialCalibrationEvidence({
    version: 'editorial-phase2-calibration-evidence-v1',
    fixtureHash: input.collection.fixtureHash,
    gatewayConfigurationHash: input.collection.gatewayConfigurationHash,
    golden: input.collection.golden,
    corpus: input.collection.corpus,
    reference,
  });
  const evidenceBytes = Buffer.from(canonicalEditorialJson(evidence), 'utf8');
  const draft = parseEditorialCalibrationDraft({
    version: 'editorial-phase2-calibration-draft-v1',
    evidenceHash: hashBytes(evidenceBytes),
    baseMainCommit: BASE_MAIN_COMMIT,
    implementationCommit: input.implementationCommit,
    pipelineVersion: CALIBRATION_PIPELINE_VERSION,
    blueprintPromptVersion: EDITORIAL_BLUEPRINT_PROMPT_VERSION,
    fidelityPromptVersion: EDITORIAL_FIDELITY_PROMPT_VERSION,
    fixtureHash: input.collection.fixtureHash,
    gatewayConfigurationHash: input.collection.gatewayConfigurationHash,
    runId: `run_${randomBytes(16).toString('hex')}`,
    golden: input.collection.golden,
    corpus: input.collection.corpus,
    reference,
  });
  const draftText = canonicalEditorialJson(draft);
  const draftBytes = Buffer.from(draftText, 'utf8');
  if (
    input.corpus.samples.some(({ taskId }) => draftText.includes(taskId))
    || /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(draftText)
    || /(?:https?|file):\/\//iu.test(draftText)
    || /(?:owner[_-]?token|api[_-]?key|authorization|bearer\s)/iu.test(draftText)
  ) calibrationFailure('EDITORIAL_CALIBRATION_SENSITIVE_OUTPUT');
  await verifyFixture(draft);
  await writeSecureFile(join(input.runDirectory, REFERENCE_MANIFEST_FILE), manifestBytes);
  await writeSecureFile(join(input.runDirectory, REFERENCE_HTML_FILE), htmlBytes);
  await writeSecureFile(join(input.runDirectory, DESKTOP_CAPTURE_FILE), desktopBytes);
  await writeSecureFile(join(input.runDirectory, MOBILE_CAPTURE_FILE), mobileBytes);
  await writeSecureFile(join(input.runDirectory, PDF_CAPTURE_FILE), pdfBytes);
  await writeSecureFile(join(input.runDirectory, EVIDENCE_FILE), evidenceBytes);
  await writeSecureJson(join(input.runDirectory, RUBRIC_FILE), rubricTemplate({
    evidenceHash: draft.evidenceHash,
    draftHash: hashBytes(draftBytes),
    sampleKey: draft.reference.sampleKey,
    generationId: draft.reference.generationId,
    htmlHash: draft.reference.htmlHash,
    captures: draft.reference.captures,
  }));
  await writeSecureFile(join(input.runDirectory, DRAFT_FILE), draftBytes);
  return draft;
}

interface OwnerDirectoryIdentity {
  dev: number;
  ino: number;
}

async function assertOwnerDirectory(
  path: string,
  expected?: OwnerDirectoryIdentity,
): Promise<OwnerDirectoryIdentity> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_RUN_DIRECTORY_INVALID');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    calibrationFailure('EDITORIAL_CALIBRATION_DIRECTORY_PERMISSION_INVALID');
  }
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    calibrationFailure('EDITORIAL_CALIBRATION_RUN_DIRECTORY_INVALID');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertWorkflowPaths(input: {
  draftPath: string;
  referenceRubricPath: string;
  outputPath: string;
}): string {
  const draftPath = resolve(input.draftPath);
  const rubricPath = resolve(input.referenceRubricPath);
  const outputPath = resolve(input.outputPath);
  const directory = dirname(draftPath);
  if (
    dirname(rubricPath) !== directory
    || dirname(outputPath) !== directory
    || basename(draftPath) !== DRAFT_FILE
    || basename(rubricPath) !== RUBRIC_FILE
    || basename(outputPath) !== RESULT_FILE
  ) calibrationFailure('EDITORIAL_CALIBRATION_PATH_INVALID');
  return directory;
}

function parseReferenceManifestSummary(value: unknown): {
  taskId: string;
  generationId: string;
  status: string;
  htmlHash: Sha256;
  htmlByteSize: number;
  gatewayConfigurationHash: Sha256;
  manifest: ReturnType<typeof parseEditorialReport>;
} {
  try {
    const manifest = parseEditorialReport(value);
    if (
      manifest.status !== 'ready'
      || !UUID_PATTERN.test(manifest.taskId)
      || manifest.pipeline.gatewayConfiguration === null
    ) {
      calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
    }
    return {
      taskId: manifest.taskId,
      generationId: manifest.generationId,
      status: manifest.status,
      htmlHash: manifest.files.html.contentSha256,
      htmlByteSize: manifest.files.html.byteSize,
      gatewayConfigurationHash: manifest.pipeline.gatewayConfiguration.gatewayConfigurationHash,
      manifest,
    };
  } catch (error) {
    if (error instanceof EditorialCalibrationError) throw error;
    calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  }
}

async function verifyFixture(draft: EditorialCalibrationDraft): Promise<void> {
  const fixturePath = fileURLToPath(new URL('../tests/fixtures/editorial-fidelity-golden.json', import.meta.url));
  let fixtureBytes: Buffer;
  try {
    fixtureBytes = await readFile(fixturePath);
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_GOLDEN_INVALID');
  }
  if (
    fixtureBytes.byteLength > 512 * 1024
    || hashBytes(fixtureBytes) !== draft.fixtureHash
  ) calibrationFailure('EDITORIAL_CALIBRATION_GOLDEN_INVALID');
  const fixture = parseEditorialFidelityGoldenFixture(parseJsonBytes(fixtureBytes));
  if (
    draft.golden.cases.length !== fixture.cases.length
    || draft.golden.cases.some((candidate, index) => {
      const expected = fixture.cases[index];
      return !expected
        || candidate.caseId !== expected.caseId
        || candidate.expected !== expected.expected;
    })
  ) calibrationFailure('EDITORIAL_CALIBRATION_GOLDEN_INVALID');
}

async function verifyReferenceFiles(
  directory: string,
  draft: EditorialCalibrationDraft,
): Promise<void> {
  const [manifestBytes, htmlBytes, desktopBytes, mobileBytes, pdfBytes] = await Promise.all([
    readSecureFile(join(directory, REFERENCE_MANIFEST_FILE), 256 * 1024),
    readSecureFile(join(directory, REFERENCE_HTML_FILE), MAX_CALIBRATION_JSON_BYTES),
    readSecureFile(join(directory, DESKTOP_CAPTURE_FILE), 32 * 1024 * 1024),
    readSecureFile(join(directory, MOBILE_CAPTURE_FILE), 32 * 1024 * 1024),
    readSecureFile(join(directory, PDF_CAPTURE_FILE), 64 * 1024 * 1024),
  ]);
  if (
    manifestBytes.length === 0
    || htmlBytes.length === 0
    || desktopBytes.length === 0
    || mobileBytes.length === 0
    || pdfBytes.length === 0
    || hashBytes(manifestBytes) !== draft.reference.manifestHash
    || hashBytes(htmlBytes) !== draft.reference.htmlHash
    || hashBytes(desktopBytes) !== draft.reference.captures.desktopPngHash
    || hashBytes(mobileBytes) !== draft.reference.captures.mobilePngHash
    || hashBytes(pdfBytes) !== draft.reference.captures.a4PdfHash
  ) calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  const manifest = parseReferenceManifestSummary(parseJsonBytes(manifestBytes));
  const referenceSample = draft.corpus.samples.find(
    ({ sampleKey }) => sampleKey === draft.reference.sampleKey,
  );
  const manifestIdentities = manifest.manifest.modelCalls.flatMap((call) => (
    call.status === 'succeeded'
      ? [{
          requestedModel: call.requestedModel,
          expectedModel: call.expectedModel,
          actualModel: call.actualModel,
        }]
      : []
  ));
  if (
    !referenceSample
    || hashBytes(manifest.taskId) !== draft.reference.sampleKey
    || manifest.generationId !== draft.reference.generationId
    || manifest.htmlHash !== draft.reference.htmlHash
    || manifest.htmlByteSize !== htmlBytes.byteLength
    || manifest.gatewayConfigurationHash !== draft.gatewayConfigurationHash
    || referenceSample.status !== manifest.manifest.status
    || referenceSample.egressDecision !== manifest.manifest.pipeline.modelEgress.decision
    || referenceSample.actualOutboundCallCount !== manifest.manifest.modelCalls.length
    || canonicalEditorialJson(referenceSample.modelIdentities) !== canonicalEditorialJson(manifestIdentities)
    || referenceSample.hasExportableRaster !== (manifest.manifest.exportedAssets.length > 0)
  ) calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
}

export async function finalizeEditorialCalibrationRun(input: {
  draftPath: string;
  referenceRubricPath: string;
  outputPath: string;
  currentCommit: string;
  commitFence?: () => void;
}): Promise<EditorialPhase2CalibrationResult> {
  const directory = assertWorkflowPaths(input);
  const directoryIdentity = await assertOwnerDirectory(directory);
  const [draftBytes, rubricBytes, evidenceBytes] = await Promise.all([
    readSecureFile(resolve(input.draftPath), MAX_CALIBRATION_JSON_BYTES),
    readSecureFile(resolve(input.referenceRubricPath), 64 * 1024),
    readSecureFile(join(directory, EVIDENCE_FILE), MAX_CALIBRATION_JSON_BYTES),
  ]);
  const draft = parseEditorialCalibrationDraft(parseJsonBytes(draftBytes));
  if (draft.implementationCommit !== commitHash(input.currentCommit)) {
    calibrationFailure('EDITORIAL_CALIBRATION_COMMIT_MISMATCH');
  }
  const rubric = parseEditorialReferenceRubric(parseJsonBytes(rubricBytes));
  if (hashBytes(draftBytes) !== rubric.draftHash) {
    calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  }
  const evidence = parseEditorialCalibrationEvidence(parseJsonBytes(evidenceBytes));
  assertCalibrationEvidenceBinding(draft, rubric, evidence, evidenceBytes);
  await verifyFixture(draft);
  await verifyReferenceFiles(directory, draft);
  const result = buildEditorialCalibrationResult(draft, rubric);
  await assertOwnerDirectory(directory, directoryIdentity);
  input.commitFence?.();
  await writeSecureJson(resolve(input.outputPath), result);
  await assertOwnerDirectory(directory, directoryIdentity);
  input.commitFence?.();
  return result;
}

export async function verifyEditorialCalibrationRun(input: {
  resultPath: string;
  currentCommit: string;
  commitFence?: () => void;
}): Promise<EditorialPhase2CalibrationResult> {
  const resultPath = resolve(input.resultPath);
  if (basename(resultPath) !== RESULT_FILE) calibrationFailure('EDITORIAL_CALIBRATION_PATH_INVALID');
  const directory = dirname(resultPath);
  const directoryIdentity = await assertOwnerDirectory(directory);
  const [resultBytes, draftBytes, rubricBytes, evidenceBytes] = await Promise.all([
    readSecureFile(resultPath, MAX_CALIBRATION_JSON_BYTES),
    readSecureFile(join(directory, DRAFT_FILE), MAX_CALIBRATION_JSON_BYTES),
    readSecureFile(join(directory, RUBRIC_FILE), 64 * 1024),
    readSecureFile(join(directory, EVIDENCE_FILE), MAX_CALIBRATION_JSON_BYTES),
  ]);
  const resultValue = parseJsonBytes(resultBytes);
  if (!isRecord(resultValue) || typeof resultValue.resultHash !== 'string') {
    calibrationFailure('EDITORIAL_CALIBRATION_RESULT_HASH_INVALID');
  }
  let recomputedHash: Sha256;
  try {
    const { resultHash: _resultHash, ...body } = resultValue;
    recomputedHash = canonicalSha256(body);
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_RESULT_HASH_INVALID');
  }
  if (resultValue.resultHash !== recomputedHash) {
    calibrationFailure('EDITORIAL_CALIBRATION_RESULT_HASH_INVALID');
  }
  const draft = parseEditorialCalibrationDraft(parseJsonBytes(draftBytes));
  if (
    draft.implementationCommit !== commitHash(input.currentCommit)
    || resultValue.implementationCommit !== input.currentCommit
  ) calibrationFailure('EDITORIAL_CALIBRATION_COMMIT_MISMATCH');
  const rubric = parseEditorialReferenceRubric(parseJsonBytes(rubricBytes));
  if (hashBytes(draftBytes) !== rubric.draftHash) {
    calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  }
  const evidence = parseEditorialCalibrationEvidence(parseJsonBytes(evidenceBytes));
  assertCalibrationEvidenceBinding(draft, rubric, evidence, evidenceBytes);
  await verifyFixture(draft);
  await verifyReferenceFiles(directory, draft);
  const expected = buildEditorialCalibrationResult(draft, rubric);
  if (canonicalEditorialJson(resultValue) !== canonicalEditorialJson(expected)) {
    calibrationFailure('EDITORIAL_CALIBRATION_RESULT_INVALID');
  }
  await assertOwnerDirectory(directory, directoryIdentity);
  input.commitFence?.();
  return expected;
}

export type EditorialCalibrationCommand =
  | { mode: 'collect'; corpusPath: string; runDirectory: string }
  | {
      mode: 'finalize';
      draftPath: string;
      referenceRubricPath: string;
      outputPath: string;
    }
  | { mode: 'verify'; resultPath: string };

export class EditorialCalibrationError extends Error {
  readonly name = 'EditorialCalibrationError';

  constructor(readonly code: string) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function calibrationFailure(code: string): never {
  throw new EditorialCalibrationError(code);
}

function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  code = 'EDITORIAL_CALIBRATION_JSON_INVALID',
): Record<string, unknown> {
  if (!isRecord(value)) calibrationFailure(code);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) calibrationFailure(code);
  return value;
}

function boundedString(value: unknown, maximum = 256): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  return value;
}

function sha256(value: unknown): Sha256 {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  return value as Sha256;
}

function commitHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  return value as number;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  return value;
}

function fidelityVerdict(value: unknown): EditorialCalibrationFidelityVerdict {
  if (!FIDELITY_VERDICTS.includes(value as EditorialCalibrationFidelityVerdict)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  return value as EditorialCalibrationFidelityVerdict;
}

const GOLDEN_INVALID = 'EDITORIAL_CALIBRATION_GOLDEN_INVALID';
const GOLDEN_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/u;

export function parseEditorialFidelityGoldenFixture(
  value: unknown,
): EditorialFidelityGoldenFixture {
  try {
    const candidate = strictRecord(value, ['version', 'cases'], [], GOLDEN_INVALID);
    if (candidate.version !== 'editorial-fidelity-golden-v1' || !Array.isArray(candidate.cases)) {
      calibrationFailure(GOLDEN_INVALID);
    }
    const cases = candidate.cases.map((item): EditorialFidelityGoldenCase => {
      const parsed = strictRecord(
        item,
        ['caseId', 'expected', 'modelContext', 'paraphrase'],
        [],
        GOLDEN_INVALID,
      );
      const caseId = boundedString(parsed.caseId, 128);
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(caseId)) calibrationFailure(GOLDEN_INVALID);
      const modelContext = parseEditorialModelContext(parsed.modelContext);
      if (canonicalEditorialJson(modelContext) !== canonicalEditorialJson(parsed.modelContext)) {
        calibrationFailure(GOLDEN_INVALID);
      }
      const contextUnitIds = new Set(modelContext.units.map(({ id }) => id));
      if ([...contextUnitIds].some((id) => !/^emu_[0-9a-f]{64}$/u.test(id))) {
        calibrationFailure(GOLDEN_INVALID);
      }
      const paraphrase = strictRecord(
        parsed.paraphrase,
        ['copyPointer', 'text', 'materialUnitIds'],
        [],
        GOLDEN_INVALID,
      );
      const copyPointer = boundedString(paraphrase.copyPointer, 256);
      if (!GOLDEN_POINTER_PATTERN.test(copyPointer) || !/^[\x20-\x7e]+$/u.test(copyPointer)) {
        calibrationFailure(GOLDEN_INVALID);
      }
      const text = boundedString(paraphrase.text, 64 * 1024);
      if (Array.from(text).length > 600 || text.normalize('NFC') !== text) {
        calibrationFailure(GOLDEN_INVALID);
      }
      if (!Array.isArray(paraphrase.materialUnitIds)) calibrationFailure(GOLDEN_INVALID);
      const materialUnitIds = paraphrase.materialUnitIds.map((id) => boundedString(id));
      if (
        materialUnitIds.length < 1
        || materialUnitIds.length > 16
        || new Set(materialUnitIds).size !== materialUnitIds.length
        || materialUnitIds.some((id) => !/^emu_[0-9a-f]{64}$/u.test(id) || !contextUnitIds.has(id))
      ) calibrationFailure(GOLDEN_INVALID);
      return {
        caseId,
        expected: fidelityVerdict(parsed.expected),
        modelContext,
        paraphrase: { copyPointer, text, materialUnitIds },
      };
    });
    const distribution = new Map<EditorialCalibrationFidelityVerdict, number>(
      FIDELITY_VERDICTS.map((verdict) => [verdict, 0]),
    );
    for (const item of cases) {
      distribution.set(item.expected, distribution.get(item.expected)! + 1);
    }
    if (
      cases.length !== 60
      || new Set(cases.map(({ caseId }) => caseId)).size !== cases.length
      || FIDELITY_VERDICTS.some((verdict) => distribution.get(verdict) !== 10)
    ) calibrationFailure(GOLDEN_INVALID);
    const fixture = {
      version: 'editorial-fidelity-golden-v1',
      cases,
    } satisfies EditorialFidelityGoldenFixture;
    const serialized = canonicalEditorialJson(fixture);
    if (
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(serialized)
      || /(?:https?|file):\/\//iu.test(serialized)
      || /(?:owner[_-]?token|api[_-]?key|authorization|bearer\s)/iu.test(serialized)
    ) calibrationFailure(GOLDEN_INVALID);
    return fixture;
  } catch (error) {
    if (error instanceof EditorialCalibrationError && error.code === GOLDEN_INVALID) throw error;
    throw new EditorialCalibrationError(GOLDEN_INVALID);
  }
}

function parseGoldenCase(value: unknown): EditorialCalibrationGoldenCaseResult {
  const candidate = strictRecord(
    value,
    ['caseId', 'expected', 'actual', 'requestedModel'],
    ['actualModel'],
  );
  const actual = candidate.actual === 'call_failed' || candidate.actual === 'schema_invalid'
    ? candidate.actual
    : fidelityVerdict(candidate.actual);
  return {
    caseId: boundedString(candidate.caseId, 128),
    expected: fidelityVerdict(candidate.expected),
    actual,
    requestedModel: boundedString(candidate.requestedModel),
    ...(candidate.actualModel === undefined
      ? {}
      : { actualModel: boundedString(candidate.actualModel) }),
  };
}

const COMPOSITION_KINDS = [
  'metric-cards',
  'truth-triad',
  'card-grid',
  'flow',
  'strategy-matrix',
  'roadmap',
  'validation-gates',
  'visual-gallery',
] as const;

function parseSample(value: unknown): EditorialCalibrationSampleEvidence {
  const required = [
    'sampleKey', 'deliverableType', 'presentationMode', 'hasExportableRaster',
    'egressDecision', 'status', 'cacheHit', 'actualOutboundCallCount', 'modelIdentities',
    'paraphraseCount', 'fidelityPassed', 'renderedCompositionKinds', 'hasRiskSection',
    'hasRiskRegister', 'metrics',
  ];
  const candidate = strictRecord(value, required, ['reasonCodes', 'generationId', 'htmlHash']);
  if (!REQUIRED_DELIVERABLE_TYPES.includes(candidate.deliverableType as typeof REQUIRED_DELIVERABLE_TYPES[number])) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  if (candidate.presentationMode !== 'current_text' && candidate.presentationMode !== 'multimodal') {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  if (candidate.egressDecision !== 'allow' && candidate.egressDecision !== 'deny') {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  if (candidate.status !== 'ready' && candidate.status !== 'degraded' && candidate.status !== 'fail') {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  if (
    candidate.cacheHit !== false
    || !Array.isArray(candidate.modelIdentities)
    || candidate.modelIdentities.length > 4
  ) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const identities = candidate.modelIdentities.map((identity) => {
    const parsed = strictRecord(identity, ['requestedModel', 'expectedModel', 'actualModel']);
    return {
      requestedModel: boundedString(parsed.requestedModel),
      expectedModel: boundedString(parsed.expectedModel),
      actualModel: boundedString(parsed.actualModel),
    };
  });
  if (!Array.isArray(candidate.renderedCompositionKinds)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const renderedCompositionKinds = candidate.renderedCompositionKinds.map((kind) => {
    if (!COMPOSITION_KINDS.includes(kind as typeof COMPOSITION_KINDS[number])) {
      calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
    }
    return kind as typeof COMPOSITION_KINDS[number];
  });
  if (new Set(renderedCompositionKinds).size !== renderedCompositionKinds.length) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const canonicalCompositionKinds = COMPOSITION_KINDS.filter((kind) => (
    renderedCompositionKinds.includes(kind)
  ));
  if (canonicalEditorialJson(renderedCompositionKinds) !== canonicalEditorialJson(canonicalCompositionKinds)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const metricsRecord = strictRecord(candidate.metrics, METRIC_NAMES);
  const metrics = Object.fromEntries(
    METRIC_NAMES.map((name) => [name, nonNegativeInteger(metricsRecord[name])]),
  ) as unknown as EditorialCalibrationMetrics;
  const generationId = candidate.generationId === undefined
    ? undefined
    : boundedString(candidate.generationId);
  const htmlHash = candidate.htmlHash === undefined ? undefined : sha256(candidate.htmlHash);
  if (
    (candidate.status === 'fail' && (generationId !== undefined || htmlHash !== undefined))
    || (candidate.status !== 'fail' && (generationId === undefined || htmlHash === undefined))
    || (generationId !== undefined && !/^er_[0-9a-f]{64}$/u.test(generationId))
    || (candidate.status === 'ready' && candidate.reasonCodes !== undefined)
  ) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const hasExportableRaster = booleanValue(candidate.hasExportableRaster);
  if (hasExportableRaster !== (metrics.exportedAssetCount > 0)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const reasonCodes = candidate.reasonCodes === undefined ? undefined : (() => {
    if (!Array.isArray(candidate.reasonCodes) || candidate.reasonCodes.length > 64) {
      calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
    }
    const codes = candidate.reasonCodes.map((value) => boundedString(value, 64));
    if (
      codes.length === 0
      || codes.some((code) => !/^[A-Z][A-Z0-9_]{0,63}$/u.test(code))
      || new Set(codes).size !== codes.length
      || canonicalEditorialJson(codes) !== canonicalEditorialJson([...codes].sort())
    ) calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
    return codes;
  })();
  return {
    sampleKey: sha256(candidate.sampleKey),
    deliverableType: candidate.deliverableType as typeof REQUIRED_DELIVERABLE_TYPES[number],
    presentationMode: candidate.presentationMode,
    hasExportableRaster,
    egressDecision: candidate.egressDecision,
    status: candidate.status,
    cacheHit: false,
    actualOutboundCallCount: (() => {
      const count = nonNegativeInteger(candidate.actualOutboundCallCount);
      if (count > 4) calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
      return count;
    })(),
    modelIdentities: identities,
    paraphraseCount: nonNegativeInteger(candidate.paraphraseCount),
    fidelityPassed: booleanValue(candidate.fidelityPassed),
    ...(reasonCodes === undefined ? {} : { reasonCodes }),
    ...(generationId === undefined ? {} : { generationId }),
    ...(htmlHash === undefined ? {} : { htmlHash }),
    renderedCompositionKinds,
    hasRiskSection: booleanValue(candidate.hasRiskSection),
    hasRiskRegister: booleanValue(candidate.hasRiskRegister),
    metrics,
  };
}

function parseCaptureHashes(value: unknown): EditorialReferenceCaptureHashes {
  const candidate = strictRecord(value, ['desktopPngHash', 'mobilePngHash', 'a4PdfHash']);
  return {
    desktopPngHash: sha256(candidate.desktopPngHash),
    mobilePngHash: sha256(candidate.mobilePngHash),
    a4PdfHash: sha256(candidate.a4PdfHash),
  };
}

export function parseEditorialCalibrationDraft(value: unknown): EditorialCalibrationDraft {
  const candidate = strictRecord(value, [
    'version', 'evidenceHash', 'baseMainCommit', 'implementationCommit', 'pipelineVersion',
    'blueprintPromptVersion', 'fidelityPromptVersion', 'fixtureHash',
    'gatewayConfigurationHash', 'runId', 'golden', 'corpus', 'reference',
  ]);
  if (candidate.version !== 'editorial-phase2-calibration-draft-v1') {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  if (candidate.baseMainCommit !== BASE_MAIN_COMMIT) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  if (
    candidate.pipelineVersion !== CALIBRATION_PIPELINE_VERSION
    || candidate.blueprintPromptVersion !== EDITORIAL_BLUEPRINT_PROMPT_VERSION
    || candidate.fidelityPromptVersion !== EDITORIAL_FIDELITY_PROMPT_VERSION
    || typeof candidate.runId !== 'string'
    || !/^run_[0-9a-f]{32}$/u.test(candidate.runId)
  ) calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  const golden = strictRecord(candidate.golden, ['cases']);
  const corpus = strictRecord(candidate.corpus, ['samples']);
  if (!Array.isArray(golden.cases) || !Array.isArray(corpus.samples)) {
    calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  }
  const goldenCases = golden.cases.map(parseGoldenCase);
  const samples = corpus.samples.map(parseSample);
  if (
    new Set(goldenCases.map(({ caseId }) => caseId)).size !== goldenCases.length
    || new Set(samples.map(({ sampleKey }) => sampleKey)).size !== samples.length
  ) calibrationFailure('EDITORIAL_CALIBRATION_JSON_INVALID');
  const reference = strictRecord(
    candidate.reference,
    ['sampleKey', 'generationId', 'htmlHash', 'manifestHash', 'captures'],
  );
  const parsedReference = {
    sampleKey: sha256(reference.sampleKey),
    generationId: boundedString(reference.generationId),
    htmlHash: sha256(reference.htmlHash),
    manifestHash: sha256(reference.manifestHash),
    captures: parseCaptureHashes(reference.captures),
  };
  const referenceSample = samples.find(({ sampleKey }) => sampleKey === parsedReference.sampleKey);
  if (
    !referenceSample
    || referenceSample.generationId !== parsedReference.generationId
    || referenceSample.htmlHash !== parsedReference.htmlHash
  ) calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_BINDING_INVALID');
  return {
    version: 'editorial-phase2-calibration-draft-v1',
    evidenceHash: sha256(candidate.evidenceHash),
    baseMainCommit: commitHash(candidate.baseMainCommit),
    implementationCommit: commitHash(candidate.implementationCommit),
    pipelineVersion: boundedString(candidate.pipelineVersion),
    blueprintPromptVersion: boundedString(candidate.blueprintPromptVersion),
    fidelityPromptVersion: boundedString(candidate.fidelityPromptVersion),
    fixtureHash: sha256(candidate.fixtureHash),
    gatewayConfigurationHash: sha256(candidate.gatewayConfigurationHash),
    runId: boundedString(candidate.runId, 128),
    golden: { cases: goldenCases },
    corpus: { samples },
    reference: parsedReference,
  };
}

function parseEditorialCalibrationEvidence(value: unknown): EditorialCalibrationEvidence {
  const candidate = strictRecord(value, [
    'version', 'fixtureHash', 'gatewayConfigurationHash', 'golden', 'corpus', 'reference',
  ]);
  if (candidate.version !== 'editorial-phase2-calibration-evidence-v1') {
    calibrationFailure('EDITORIAL_CALIBRATION_EVIDENCE_INVALID');
  }
  let parsed: EditorialCalibrationDraft;
  try {
    parsed = parseEditorialCalibrationDraft({
      version: 'editorial-phase2-calibration-draft-v1',
      evidenceHash: `sha256:${'0'.repeat(64)}`,
      baseMainCommit: BASE_MAIN_COMMIT,
      implementationCommit: '0'.repeat(40),
      pipelineVersion: CALIBRATION_PIPELINE_VERSION,
      blueprintPromptVersion: EDITORIAL_BLUEPRINT_PROMPT_VERSION,
      fidelityPromptVersion: EDITORIAL_FIDELITY_PROMPT_VERSION,
      fixtureHash: candidate.fixtureHash,
      gatewayConfigurationHash: candidate.gatewayConfigurationHash,
      runId: `run_${'0'.repeat(32)}`,
      golden: candidate.golden,
      corpus: candidate.corpus,
      reference: candidate.reference,
    });
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_EVIDENCE_INVALID');
  }
  return {
    version: 'editorial-phase2-calibration-evidence-v1',
    fixtureHash: parsed.fixtureHash,
    gatewayConfigurationHash: parsed.gatewayConfigurationHash,
    golden: parsed.golden,
    corpus: parsed.corpus,
    reference: parsed.reference,
  };
}

function calibrationEvidenceFromDraft(
  draft: EditorialCalibrationDraft,
): EditorialCalibrationEvidence {
  return {
    version: 'editorial-phase2-calibration-evidence-v1',
    fixtureHash: draft.fixtureHash,
    gatewayConfigurationHash: draft.gatewayConfigurationHash,
    golden: draft.golden,
    corpus: draft.corpus,
    reference: draft.reference,
  };
}

function assertCalibrationEvidenceBinding(
  draft: EditorialCalibrationDraft,
  rubric: EditorialReferenceRubric,
  evidence: EditorialCalibrationEvidence,
  evidenceBytes: Uint8Array,
): void {
  const canonicalBytes = Buffer.from(canonicalEditorialJson(evidence), 'utf8');
  if (
    !canonicalBytes.equals(Buffer.from(evidenceBytes))
    || hashBytes(evidenceBytes) !== draft.evidenceHash
    || rubric.evidenceHash !== draft.evidenceHash
    || canonicalEditorialJson(evidence) !== canonicalEditorialJson(calibrationEvidenceFromDraft(draft))
  ) calibrationFailure('EDITORIAL_CALIBRATION_EVIDENCE_INVALID');
}

export function parseEditorialReferenceRubric(value: unknown): EditorialReferenceRubric {
  const candidate = strictRecord(value, [
    'version', 'evidenceHash', 'draftHash', 'sampleKey', 'generationId', 'htmlHash', 'captures',
    'reviewer', 'reviewedAt', 'items',
  ]);
  if (candidate.version !== 'editorial-reference-rubric-v1') {
    calibrationFailure('EDITORIAL_CALIBRATION_RUBRIC_INVALID');
  }
  const itemNames = [
    'desktopHierarchyAndSpacing',
    'mobileNoOverflowOrOcclusion',
    'a4NoClippingAndReadableStates',
    'offlineContentComplete',
    'keyboardHeadingsAndAltUsable',
    'professionalDiverseAndEvidenceBound',
  ] as const;
  const items = strictRecord(candidate.items, itemNames, [], 'EDITORIAL_CALIBRATION_RUBRIC_INVALID');
  let reviewer: string;
  let reviewedAt: string;
  try {
    reviewer = boundedString(candidate.reviewer, 128);
    reviewedAt = boundedString(candidate.reviewedAt, 64);
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_RUBRIC_INVALID');
  }
  const reviewedAtMs = Date.parse(reviewedAt);
  if (!Number.isFinite(reviewedAtMs) || new Date(reviewedAtMs).toISOString() !== reviewedAt) {
    calibrationFailure('EDITORIAL_CALIBRATION_RUBRIC_INVALID');
  }
  return {
    version: 'editorial-reference-rubric-v1',
    evidenceHash: sha256(candidate.evidenceHash),
    draftHash: sha256(candidate.draftHash),
    sampleKey: sha256(candidate.sampleKey),
    generationId: boundedString(candidate.generationId),
    htmlHash: sha256(candidate.htmlHash),
    captures: parseCaptureHashes(candidate.captures),
    reviewer,
    reviewedAt,
    items: Object.fromEntries(itemNames.map((name) => {
      if (typeof items[name] !== 'boolean') calibrationFailure('EDITORIAL_CALIBRATION_RUBRIC_INVALID');
      return [name, items[name]];
    })) as unknown as EditorialReferenceRubric['items'],
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function parseEditorialCalibrationCorpus(value: unknown): EditorialCalibrationCorpus {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['version', 'samples'])
    || value.version !== 'editorial-calibration-corpus-v1'
    || !Array.isArray(value.samples)
    || value.samples.length < 10
    || value.samples.length > 100
  ) {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_CORPUS_INVALID');
  }
  const samples: EditorialCalibrationCorpus['samples'] = [];
  const taskIds = new Set<string>();
  let referenceCount = 0;
  for (const item of value.samples) {
    if (
      !isRecord(item)
      || !hasExactKeys(item, ['taskId', 'referenceCase'])
      || typeof item.taskId !== 'string'
      || !UUID_PATTERN.test(item.taskId)
      || typeof item.referenceCase !== 'boolean'
      || taskIds.has(item.taskId)
    ) {
      throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_CORPUS_INVALID');
    }
    taskIds.add(item.taskId);
    if (item.referenceCase) referenceCount += 1;
    samples.push({ taskId: item.taskId, referenceCase: item.referenceCase });
  }
  if (referenceCount !== 1) {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_CORPUS_INVALID');
  }
  return { version: 'editorial-calibration-corpus-v1', samples };
}

interface CalibrationModelObservation {
  schemaName: 'editorial-report-blueprint' | 'editorial-report-fidelity';
  response?: {
    provider?: string;
    endpointHost?: string;
    requestedModel?: string;
    expectedModel?: string;
    actualModel: string;
  };
}

function trackedEditorialModelPort(): {
  modelPort: Extract<EditorialModelPort, { client: object }>;
  observations: CalibrationModelObservation[];
} {
  const configured = createEditorialModelPort();
  if (configured.client === null || configured.configuration === null) {
    calibrationFailure('EDITORIAL_CALIBRATION_GATEWAY_REQUIRED');
  }
  const baseClient = configured.client;
  const observations: CalibrationModelObservation[] = [];
  const client: EditorialStructuredModelClient = Object.freeze({
    configurationIdentity: baseClient.configurationIdentity,
    async generateStructured<T>(options: Parameters<EditorialStructuredModelClient['generateStructured']>[0]) {
      const observation: CalibrationModelObservation = { schemaName: options.schemaName };
      observations.push(observation);
      const result = await baseClient.generateStructured<T>(options);
      observation.response = {
        provider: result.providerIdentity?.provider,
        endpointHost: result.providerIdentity?.endpointHost,
        requestedModel: result.providerIdentity?.requestedModel,
        expectedModel: result.expectedModel,
        actualModel: result.modelName,
      };
      return result;
    },
  });
  return {
    modelPort: Object.freeze({ client, configuration: configured.configuration }),
    observations,
  };
}

function assertGoldenModelIdentity(
  result: Omit<LLMResult<unknown>, 'receiptId'>,
  modelPort: Extract<EditorialModelPort, { client: object }>,
  expectedPromptHash: string,
): { requestedModel: string; actualModel: string } {
  if ('receiptId' in result) calibrationFailure('EDITORIAL_CALIBRATION_MODEL_IDENTITY_INVALID');
  const identity = result.providerIdentity;
  const route = modelPort.configuration.routes.find(
    ({ requestedModel }) => requestedModel === identity?.requestedModel,
  );
  if (
    !identity
    || identity.provider !== modelPort.configuration.provider
    || identity.endpointHost !== modelPort.configuration.endpointHost
    || identity.mode !== 'real'
    || identity.eligibleAsReal !== true
    || !route
    || result.expectedModel !== route.expectedActualModel
    || result.modelName !== route.expectedActualModel
    || result.promptHash !== expectedPromptHash
  ) calibrationFailure('EDITORIAL_CALIBRATION_MODEL_IDENTITY_INVALID');
  return { requestedModel: identity.requestedModel, actualModel: result.modelName };
}

export async function runEditorialFidelityGolden(input: {
  fixture: EditorialFidelityGoldenFixture;
  fixtureHash: Sha256;
  schema: object;
  modelPort: Extract<EditorialModelPort, { client: object }>;
}): Promise<{ cases: EditorialCalibrationGoldenCaseResult[] }> {
  const fixtureHash = sha256(input.fixtureHash);
  const egress = evaluateEditorialModelEgress({
    sourcePolicyMetadata: [{
      artifactId: 'editorial-fidelity-golden-v1',
      contentSha256: fixtureHash,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    }],
    modelPort: input.modelPort,
  });
  if (egress.decision !== 'allow') {
    calibrationFailure('EDITORIAL_CALIBRATION_MODEL_EGRESS_DENIED');
  }
  const validator = new SchemaValidator();
  const cases: EditorialCalibrationGoldenCaseResult[] = [];
  for (const golden of input.fixture.cases) {
    const context = { modelContext: golden.modelContext, paraphrases: [golden.paraphrase] };
    const promptHash = hashPrompt(
      EDITORIAL_FIDELITY_PROMPT,
      context,
      'editorial-report-fidelity',
      EDITORIAL_MODEL_SYSTEM_PROMPT,
    );
    let result: Omit<LLMResult<unknown>, 'receiptId'>;
    try {
      result = await input.modelPort.client.generateStructured<unknown>({
        prompt: EDITORIAL_FIDELITY_PROMPT,
        systemPrompt: EDITORIAL_MODEL_SYSTEM_PROMPT,
        schema: input.schema,
        schemaName: 'editorial-report-fidelity',
        context,
        limits: input.modelPort.configuration.limits,
        redirectMode: input.modelPort.configuration.redirectMode,
      });
    } catch (error) {
      if (!(error instanceof LLMInvocationError)) throw error;
      cases.push({
        caseId: golden.caseId,
        expected: golden.expected,
        actual: 'call_failed',
        requestedModel: 'unavailable',
      });
      continue;
    }
    const identity = assertGoldenModelIdentity(result, input.modelPort, promptHash);
    try {
      validator.validateOrThrow('editorial-report-fidelity', result.data);
      const plan = parseEditorialFidelityReviewPlan(result.data);
      const check = plan.checks[0];
      if (
        plan.checks.length !== 1
        || !check
        || check.copyPointer !== golden.paraphrase.copyPointer
        || canonicalEditorialJson(check.materialUnitIds) !== canonicalEditorialJson(golden.paraphrase.materialUnitIds)
      ) throw new Error('golden response binding mismatch');
      cases.push({
        caseId: golden.caseId,
        expected: golden.expected,
        actual: check.verdict,
        ...identity,
      });
    } catch {
      cases.push({
        caseId: golden.caseId,
        expected: golden.expected,
        actual: 'schema_invalid',
        ...identity,
      });
    }
  }
  return { cases };
}

function modelIdentities(
  observations: readonly CalibrationModelObservation[],
  modelPort: Extract<EditorialModelPort, { client: object }>,
): EditorialCalibrationSampleResult['modelIdentities'] {
  return observations.flatMap(({ response }) => {
    if (!response?.requestedModel) return [];
    const route = modelPort.configuration.routes.find(
      ({ requestedModel }) => requestedModel === response.requestedModel,
    );
    return [{
      requestedModel: response.requestedModel,
      expectedModel: route?.expectedActualModel ?? response.expectedModel ?? 'unavailable',
      actualModel: response.actualModel,
    }];
  });
}

function safeFailureCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? code
    : 'EDITORIAL_CALIBRATION_SAMPLE_FAILED';
}

function normalizedMaterialCodePoints(
  material: ReturnType<typeof parseEditorialMaterial>,
): number {
  return material.units.reduce((count, unit) => (
    count + Array.from(String(unit.value)).length
  ), 0);
}

function degradedReasonCodes(
  diagnostic: ReturnType<typeof parseEditorialDiagnostic>,
): string[] {
  const codes = diagnostic.candidateAttempts.flatMap(({ issueCodes }) => issueCodes);
  if (diagnostic.mode !== 'none' && diagnostic.modelEgress.decision === 'deny') {
    codes.push(diagnostic.modelEgress.reasonCode);
  }
  if (codes.length === 0) {
    codes.push(...diagnostic.issues.map(({ code }) => code));
  }
  return [...new Set(codes)].sort();
}

async function captureReference(html: Uint8Array): Promise<{
  desktopPngBytes: Uint8Array;
  mobilePngBytes: Uint8Array;
  a4PdfBytes: Uint8Array;
}> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/*', async (route) => {
      const protocol = new URL(route.request().url()).protocol;
      if (protocol === 'data:' || protocol === 'about:') await route.continue();
      else await route.abort();
    });
    await page.setContent(Buffer.from(html).toString('utf8'), { waitUntil: 'load' });
    await page.emulateMedia({ media: 'screen' });
    const desktopPngBytes = await page.screenshot({ fullPage: false, type: 'png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobilePngBytes = await page.screenshot({ fullPage: false, type: 'png' });
    await page.emulateMedia({ media: 'print' });
    const a4PdfBytes = await page.pdf({ format: 'A4', printBackground: true });
    return { desktopPngBytes, mobilePngBytes, a4PdfBytes };
  } finally {
    await browser.close();
  }
}

function assertWithinStore(path: string, storeDirectory: string): string {
  const resolvedPath = resolve(path);
  const resolvedStore = resolve(storeDirectory);
  if (!resolvedPath.startsWith(`${resolvedStore}${sep}`)) {
    calibrationFailure('EDITORIAL_CALIBRATION_STORE_ESCAPE');
  }
  return resolvedPath;
}

export async function collectEditorialPhase2Calibration(input: {
  corpus: EditorialCalibrationCorpus;
  runDirectory: string;
  storeDirectory: string;
}): Promise<EditorialCalibrationCollection> {
  const { modelPort, observations } = trackedEditorialModelPort();
  const fixturePath = fileURLToPath(new URL('../tests/fixtures/editorial-fidelity-golden.json', import.meta.url));
  const fixtureBytes = await readFile(fixturePath);
  if (fixtureBytes.byteLength > 512 * 1024) calibrationFailure('EDITORIAL_CALIBRATION_GOLDEN_INVALID');
  const fixture = parseEditorialFidelityGoldenFixture(parseJsonBytes(fixtureBytes));
  const fixtureHash = hashBytes(fixtureBytes);
  const schemaText = loadSchemaText(resolveSchema('editorial-report-fidelity'));
  if (schemaText === null) calibrationFailure('EDITORIAL_CALIBRATION_MODEL_SCHEMA_MISSING');
  let schema: object;
  try {
    schema = JSON.parse(schemaText) as object;
  } catch {
    calibrationFailure('EDITORIAL_CALIBRATION_MODEL_SCHEMA_MISSING');
  }
  const golden = await runEditorialFidelityGolden({ fixture, fixtureHash, schema, modelPort });

  const repository = new ControlPlaneRepository(pool);
  const workspaceRoot = process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';
  const canonicalArtifacts = new ControlArtifactStore({
    root: join(workspaceRoot, 'current-control'),
    registry: repository,
  });
  const tasks: EditorialTaskReader = Object.freeze({
    getTaskDetail: (taskId) => repository.getTaskDetail(taskId),
    getArtifact: (artifactId) => repository.getArtifact(artifactId),
    findSealedArtifact: (request) => repository.findSealedArtifact(request),
  });
  const artifacts: EditorialArtifactReader = Object.freeze({
    readVerifiedJson: <T>(artifactId: string) => canonicalArtifacts.readVerifiedJson<T>(artifactId),
    readVerifiedBoundJson: <T>(artifactId: string) => canonicalArtifacts.readVerifiedBoundJson<T>(artifactId),
    readVerifiedBinary: (artifactId) => canonicalArtifacts.readVerifiedBinary(artifactId),
  });
  const source = new EditorialSourceReader({ tasks, artifacts });
  const store = new EditorialReportStore({ root: input.storeDirectory });
  const pipeline = new EditorialReportPipeline({ source, store, modelPort });
  const samples: EditorialCalibrationSampleEvidence[] = [];
  let referenceArtifacts: EditorialCalibrationCollection['reference'] | undefined;

  for (const corpusSample of input.corpus.samples) {
    const frozen = await source.readCurrent(corpusSample.taskId);
    const materialization = materializeEditorialReport(frozen);
    const modelEgress = evaluateEditorialModelEgress({
      sourcePolicyMetadata: materialization.sourcePolicyMetadata,
      modelPort,
    });
    const startObservation = observations.length;
    let generation: Awaited<ReturnType<EditorialReportPipeline['generate']>> | undefined;
    let failure: unknown;
    try {
      generation = await pipeline.generate({ taskId: corpusSample.taskId });
    } catch (error) {
      failure = error;
    }
    const sampleObservations = observations.slice(startObservation);
    const identities = modelIdentities(sampleObservations, modelPort);
    if (!generation) {
      samples.push(parseSample({
        sampleKey: hashBytes(corpusSample.taskId),
        deliverableType: materialization.material.deliverableType,
        presentationMode: materialization.material.presentationMode,
        hasExportableRaster: false,
        egressDecision: modelEgress.decision,
        status: 'fail',
        cacheHit: false,
        actualOutboundCallCount: sampleObservations.length,
        modelIdentities: identities,
        paraphraseCount: 0,
        fidelityPassed: false,
        reasonCodes: [safeFailureCode(failure)],
        renderedCompositionKinds: [],
        hasRiskSection: false,
        hasRiskRegister: false,
        metrics: {
          unitCount: materialization.material.units.length,
          normalizedTextCodePoints: normalizedMaterialCodePoints(materialization.material),
          modelContextBytes: materialization.modelContextByteSize,
          htmlBytes: 0,
          exportedAssetCount: 0,
        },
      }));
      continue;
    }
    const manifestPath = assertWithinStore(generation.manifestPath, input.storeDirectory);
    const slotDirectory = dirname(manifestPath);
    const [manifestBytes, htmlBytes, materialBytes, blueprintBytes, diagnosticBytes] = await Promise.all([
      readSecureFile(manifestPath, 256 * 1024),
      readSecureFile(assertWithinStore(generation.reportPath, input.storeDirectory), MAX_CALIBRATION_JSON_BYTES),
      readSecureFile(join(slotDirectory, 'editorial-material.json'), MAX_CALIBRATION_JSON_BYTES),
      readSecureFile(join(slotDirectory, 'editorial-blueprint.json'), MAX_CALIBRATION_JSON_BYTES),
      readSecureFile(join(slotDirectory, 'editorial-diagnostic.json'), MAX_CALIBRATION_JSON_BYTES),
    ]);
    const manifest = parseEditorialReport(parseJsonBytes(manifestBytes));
    const material = parseEditorialMaterial(parseJsonBytes(materialBytes));
    const blueprint = parseEditorialBlueprint(parseJsonBytes(blueprintBytes));
    const diagnostic = parseEditorialDiagnostic(parseJsonBytes(diagnosticBytes));
    if (
      manifest.taskId !== corpusSample.taskId
      || manifest.generationId !== generation.generationId
      || manifest.status !== generation.status
      || manifest.files.html.contentSha256 !== hashBytes(htmlBytes)
      || manifest.pipeline.gatewayConfiguration?.gatewayConfigurationHash !== modelPort.configuration.gatewayConfigurationHash
      || canonicalEditorialJson(material) !== canonicalEditorialJson(materialization.material)
    ) calibrationFailure('EDITORIAL_CALIBRATION_COLLECTION_INVALID');
    const paraphraseCount = enumerateEditorialParaphrases(blueprint).length;
    const fidelityPassed = diagnostic.checks.some(
      ({ id, status }) => id === 'content_fidelity' && status === 'passed',
    );
    const replay = renderEditorialReport({
      material,
      blueprint,
      verifiedVisualAssets: frozen.verifiedVisualAssets,
    });
    if (hashBytes(replay.htmlBytes) !== hashBytes(htmlBytes)) {
      calibrationFailure('EDITORIAL_CALIBRATION_COLLECTION_INVALID');
    }
    const sample = parseSample({
      sampleKey: hashBytes(corpusSample.taskId),
      deliverableType: material.deliverableType,
      presentationMode: material.presentationMode,
      hasExportableRaster: manifest.exportedAssets.length > 0,
      egressDecision: manifest.pipeline.modelEgress.decision,
      status: generation.status,
      cacheHit: false,
      actualOutboundCallCount: sampleObservations.length,
      modelIdentities: identities,
      paraphraseCount,
      fidelityPassed,
      ...(generation.status === 'degraded' ? { reasonCodes: degradedReasonCodes(diagnostic) } : {}),
      generationId: generation.generationId,
      htmlHash: hashBytes(htmlBytes),
      renderedCompositionKinds: replay.trace.renderedCompositionKinds,
      hasRiskSection: blueprint.sections.some(({ role }) => role === 'risk'),
      hasRiskRegister: blueprint.sections.some(({ blocks }) => blocks.some(({ kind }) => kind === 'risk-register')),
      metrics: {
        unitCount: material.units.length,
        normalizedTextCodePoints: normalizedMaterialCodePoints(material),
        modelContextBytes: materialization.modelContextByteSize,
        htmlBytes: htmlBytes.byteLength,
        exportedAssetCount: manifest.exportedAssets.length,
      },
    });
    samples.push(sample);
    if (corpusSample.referenceCase) {
      if (
        sample.status !== 'ready'
        || sample.actualOutboundCallCount < 2
        || sampleObservations.filter(({ response }) => response !== undefined).length < 2
      ) calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_NOT_READY');
      const captures = await captureReference(htmlBytes);
      referenceArtifacts = {
        sampleKey: sample.sampleKey as Sha256,
        generationId: generation.generationId,
        htmlHash: hashBytes(htmlBytes),
        manifestBytes,
        htmlBytes,
        ...captures,
      };
    }
  }
  if (!referenceArtifacts) calibrationFailure('EDITORIAL_CALIBRATION_REFERENCE_NOT_READY');
  return {
    fixtureHash,
    gatewayConfigurationHash: modelPort.configuration.gatewayConfigurationHash,
    golden,
    corpus: { samples },
    reference: referenceArtifacts,
  };
}

export interface EditorialCalibrationCliDependencies {
  collect?: (input: {
    corpus: EditorialCalibrationCorpus;
    runDirectory: string;
    storeDirectory: string;
  }) => Promise<EditorialCalibrationCollection>;
  currentCommit?: () => string;
  calibrationRoot?: string;
  close?: () => Promise<void>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export function assertEditorialCalibrationBaseMainAncestor(
  head: string,
  isAncestor: (base: string, candidate: string) => boolean = (base, candidate) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', base, candidate], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
): void {
  const candidate = commitHash(head);
  if (!isAncestor(BASE_MAIN_COMMIT, candidate)) {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_BASE_MAIN_MISMATCH');
  }
}

function repositoryHead(): string {
  let head: string;
  let status: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_COMMIT_UNAVAILABLE');
  }
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_COMMIT_UNAVAILABLE');
  }
  if (status.length > 0) throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_WORKTREE_DIRTY');
  assertEditorialCalibrationBaseMainAncestor(head);
  return head;
}

function defaultCalibrationRoot(): string {
  const workspaceRoot = process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';
  return resolve(workspaceRoot, 'editorial-reports', 'calibration');
}

function assertCalibrationRunDirectory(path: string, calibrationRoot: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(calibrationRoot);
  if (
    dirname(resolvedPath) !== resolvedRoot
    || !/^run\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(basename(resolvedPath))
  ) calibrationFailure('EDITORIAL_CALIBRATION_PATH_INVALID');
}

function assertCollectPaths(
  corpusPath: string,
  runDirectory: string,
  calibrationRoot: string,
): void {
  const resolvedRoot = resolve(calibrationRoot);
  if (resolve(corpusPath) !== join(resolvedRoot, 'corpus.json')) {
    calibrationFailure('EDITORIAL_CALIBRATION_PATH_INVALID');
  }
  assertCalibrationRunDirectory(runDirectory, resolvedRoot);
}

export function parseEditorialCalibrationArgs(args: readonly string[]): EditorialCalibrationCommand {
  const commandArgs = args[0] === '--' ? args.slice(1) : [...args];
  if (
    commandArgs.length === 5
    && commandArgs[0] === '--collect'
    && commandArgs[1] === '--corpus'
    && commandArgs[2]
    && commandArgs[3] === '--run-dir'
    && commandArgs[4]
  ) {
    return { mode: 'collect', corpusPath: commandArgs[2], runDirectory: commandArgs[4] };
  }
  if (
    commandArgs.length === 7
    && commandArgs[0] === '--finalize'
    && commandArgs[1] === '--draft'
    && commandArgs[2]
    && commandArgs[3] === '--reference-rubric'
    && commandArgs[4]
    && commandArgs[5] === '--output'
    && commandArgs[6]
  ) {
    return {
      mode: 'finalize',
      draftPath: commandArgs[2],
      referenceRubricPath: commandArgs[4],
      outputPath: commandArgs[6],
    };
  }
  if (
    commandArgs.length === 2
    && commandArgs[0] === '--verify'
    && commandArgs[1]
  ) {
    return { mode: 'verify', resultPath: commandArgs[1] };
  }
  throw new EditorialCalibrationError(ARGUMENT_FAILURE_CODE);
}

async function assertEmptyOwnerDirectory(path: string): Promise<OwnerDirectoryIdentity> {
  const identity = await assertOwnerDirectory(path);
  if ((await readdir(path)).length !== 0) {
    throw new EditorialCalibrationError('EDITORIAL_CALIBRATION_RUN_NOT_EMPTY');
  }
  await assertOwnerDirectory(path, identity);
  return identity;
}

export async function runEditorialCalibrationCli(
  args: readonly string[],
  dependencies: EditorialCalibrationCliDependencies = {},
): Promise<0 | 1> {
  const writeStdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let exitCode: 0 | 1 = 0;
  try {
    const command = parseEditorialCalibrationArgs(args);
    const calibrationRoot = resolve(dependencies.calibrationRoot ?? defaultCalibrationRoot());
    const readCurrentCommit = dependencies.currentCommit ?? repositoryHead;
    const currentCommit = commitHash(readCurrentCommit());
    const commitFence = (): void => {
      if (commitHash(readCurrentCommit()) !== currentCommit) {
        calibrationFailure('EDITORIAL_CALIBRATION_COMMIT_MISMATCH');
      }
    };
    if (command.mode === 'collect') {
      const runDirectory = resolve(command.runDirectory);
      const corpusPath = resolve(command.corpusPath);
      assertCollectPaths(corpusPath, runDirectory, calibrationRoot);
      const runDirectoryIdentity = await assertEmptyOwnerDirectory(runDirectory);
      await assertOwnerDirectory(dirname(corpusPath));
      const corpus = parseEditorialCalibrationCorpus(parseJsonBytes(
        await readSecureFile(corpusPath, 64 * 1024),
      ));
      const storeDirectory = join(runDirectory, 'store');
      await mkdir(storeDirectory, { mode: 0o700 });
      await chmod(storeDirectory, 0o700);
      const storeDirectoryIdentity = await assertEmptyOwnerDirectory(storeDirectory);
      const collect = dependencies.collect ?? collectEditorialPhase2Calibration;
      const collection = await collect({ corpus, runDirectory, storeDirectory });
      await assertOwnerDirectory(runDirectory, runDirectoryIdentity);
      await assertOwnerDirectory(storeDirectory, storeDirectoryIdentity);
      commitFence();
      const draft = await persistCalibrationCollection({
        collection,
        corpus,
        runDirectory,
        implementationCommit: currentCommit,
      });
      await assertOwnerDirectory(runDirectory, runDirectoryIdentity);
      await assertOwnerDirectory(storeDirectory, storeDirectoryIdentity);
      commitFence();
      const machineGate = evaluateEditorialCalibrationGate({
        golden: draft.golden,
        corpus: { samples: draft.corpus.samples },
        reference: { sampleKey: draft.reference.sampleKey, allRubricItemsPassed: true },
      });
      writeStdout(JSON.stringify({
        mode: 'collect',
        runDirectory,
        draftPath: join(runDirectory, DRAFT_FILE),
        runId: draft.runId,
        gate: machineGate,
      }));
      if (!machineGate.passed) {
        writeStderr('EDITORIAL_CALIBRATION_GATE_FAILED');
        exitCode = 1;
      }
    } else if (command.mode === 'finalize') {
      assertCalibrationRunDirectory(dirname(resolve(command.draftPath)), calibrationRoot);
      const result = await finalizeEditorialCalibrationRun({ ...command, currentCommit, commitFence });
      writeStdout(JSON.stringify({ mode: 'finalize', outputPath: resolve(command.outputPath), gate: result.gate }));
      if (!result.gate.passed) {
        writeStderr('EDITORIAL_CALIBRATION_GATE_FAILED');
        exitCode = 1;
      }
    } else {
      assertCalibrationRunDirectory(dirname(resolve(command.resultPath)), calibrationRoot);
      const result = await verifyEditorialCalibrationRun({ ...command, currentCommit, commitFence });
      writeStdout(JSON.stringify({ mode: 'verify', resultPath: resolve(command.resultPath), gate: result.gate }));
      if (!result.gate.passed) {
        writeStderr('EDITORIAL_CALIBRATION_GATE_FAILED');
        exitCode = 1;
      }
    }
  } catch (error) {
    writeStderr(error instanceof EditorialCalibrationError
      ? error.code
      : 'EDITORIAL_CALIBRATION_FAILED');
    exitCode = 1;
  } finally {
    try {
      await (dependencies.close ?? closePool)();
    } catch {
      exitCode = 1;
    }
  }
  return exitCode;
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void runEditorialCalibrationCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
