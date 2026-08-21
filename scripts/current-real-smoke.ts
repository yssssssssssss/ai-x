import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { closePool, loadEnv } from '../database/db.ts';
import {
  parseModelRoutes,
  type GatewayModelRoute,
} from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import { requiredApprovals } from '../apps/orchestrator-runtime/src/control/task-workflow.ts';
import { ReportPackageArtifactService } from '../apps/orchestrator-runtime/src/report/report-package-artifact.ts';

export interface RealSmokeConfig {
  ALLOW_REAL_PROVIDER?: string;
  LLM_PROVIDER?: string;
  TOOL_ADAPTER?: string;
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  LLM_GATEWAY_BASE_URL?: string;
  LLM_GATEWAY_API_KEY?: string;
  LLM_MODEL_NAME?: string;
  LLM_EXPECTED_ACTUAL_MODEL?: string;
  TAVILY_API_KEY?: string;
  PLAYWRIGHT_CAPTURE_ENABLED?: string;
  CURRENT_REQUIRE_BROWSER_EVIDENCE?: string;
}

type JsonScalar = string | number | boolean | null;

export interface SmokeReceiptInput extends VerifiedSmokeEvidenceSummary {
  scenarioId: string;
  profile: string;
  taskType: string;
  deliverableType: string;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  reportPackageId: string;
  visualAssetCount: number;
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  evidenceArtifactIds: string[];
  toolReceipt: Record<string, unknown>;
  counts: {
    evidence: number;
    findings: number;
    recommendations: number;
  };
  sources: string[];
  provider: string;
  requestedModel: string;
  actualModel: string;
  coreTool: string;
  packageSealed: boolean;
  review: {
    artifactId: string;
    automated: true;
    verdict: 'pass';
  };
}
export interface SmokeReceipt extends SmokeReceiptInput {
  evidenceCount: number;
}

export interface SemanticGoldScenario {
  id: string;
  profile: string;
  taskType: ResearchTaskV2['task_type'];
  businessDomain: string;
  input: string;
  expectedDeliverableType: string;
  minPublicSources: number;
  minVisualAssets: number;
  sensitivity: ResearchTaskV2['sensitivity'];
  piiDetected: boolean;
  variant?: 'clear' | 'ambiguous' | 'missing_input' | 'constraint_conflict' | 'pii';
}

export interface SemanticGoldFixture {
  profiles: readonly string[];
  scenarios: readonly SemanticGoldScenario[];
}

export interface SmokeEvidenceSummary {
  gapCount: number;
  toolArtifactIds: string[];
  visualAssetIds: string[];
  visualAssetManifestIds: string[];
  browserCaptureCount: number;
  browserCaptureIds: string[];
  browserCaptureHosts: string[];
  screenshotEvidenceCount: number;
  screenshotEvidenceIds: string[];
  chartRenderCount: number;
  chartRenderIds: string[];
  browserToolVerified: boolean;
}

export interface VerifiedSmokeEvidenceSummary extends SmokeEvidenceSummary {
  historyRereadVerified: true;
}

interface SmokeEvidenceStep {
  stepNo: number;
  actorType: string;
  actorId: string;
  state: string;
  outputArtifactId?: string | null;
  toolProvenance?: Record<string, unknown> | null;
  failure?: Record<string, unknown> | null;
}

export type ApprovalMode = 'allow_owner' | 'forbid';

export interface SmokeRunInput {
  fixturePath: string;
  profiles: string[];
  scenarioId: string;
  designImagePath?: string;
  approvalMode?: ApprovalMode;
}

const REQUIRED_NON_BLANK_FIELDS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'LLM_GATEWAY_BASE_URL',
  'LLM_GATEWAY_API_KEY',
  'LLM_MODEL_NAME',
  'LLM_EXPECTED_ACTUAL_MODEL',
  'TAVILY_API_KEY',
] as const;

const TOOL_RECEIPT_FIELDS = [
  'actorId',
  'declaredAdapterType',
  'resolvedAdapterType',
  'implementationId',
  'executionMode',
  'endpointHost',
  'status',
  'latencyMs',
] as const;


export interface SmokePlanStep {
  actor_type: string;
  actor_id: string;
  requires_approval?: boolean;
}

const REQUIRED_EXACT_CAPABILITIES: SmokePlanStep[] = [
  { actor_type: 'tool', actor_id: 'tavily-web-search' },
];
// Report drafting and review are engine-owned stages. They are appended after
// the frozen plan steps, so requiring `llm`/`reviewer` actors in the plan makes
// the smoke contract reject valid plans before execution starts. Their actual
// execution is verified below through the sealed Deliverable and Review
// Artifacts instead.
const REQUIRED_ACTOR_TYPES = ['skill'] as const;
const REQUIRED_CAPABILITY_DESCRIPTION = [
  ...REQUIRED_EXACT_CAPABILITIES.map(({ actor_id }) => actor_id),
  ...REQUIRED_ACTOR_TYPES,
].join(', ');

export const CURRENT_REAL_SMOKE_PROFILES = [
  'competitive_research',
  'user_research_planning',
  'voc_diagnosis',
  'design_audit',
  'a11y_audit',
] as const;

export function assertRealSmokeConfig(env: RealSmokeConfig): void {
  if (env.ALLOW_REAL_PROVIDER !== '1') {
    throw new Error('ALLOW_REAL_PROVIDER must be exactly 1');
  }
  if (env.LLM_PROVIDER !== 'gateway') {
    throw new Error('LLM_PROVIDER must be exactly gateway');
  }
  if (env.TOOL_ADAPTER !== 'real') {
    throw new Error('TOOL_ADAPTER must be exactly real');
  }
  for (const field of REQUIRED_NON_BLANK_FIELDS) {
    if (typeof env[field] !== 'string' || env[field].trim() === '') {
      throw new Error(`${field} must be non-empty`);
    }
  }
}

interface GatewayModelCall {
  status: string;
  provider: string;
  requestedModel: string;
  actualModel: string;
}

export function assertGatewayModelReceipts(input: {
  modelRoutes: readonly GatewayModelRoute[];
  modelCalls: GatewayModelCall[];
}): void {
  const expectedByRequested = new Map(
    input.modelRoutes.map(({ requestedModel, expectedActualModel }) => [requestedModel, expectedActualModel]),
  );
  if (
    expectedByRequested.size === 0
    || input.modelCalls.length === 0
    || input.modelCalls.some((call) => (
      call.status !== 'succeeded'
      || call.provider !== 'gateway'
      || expectedByRequested.get(call.requestedModel) !== call.actualModel
    ))
  ) {
    throw new Error('execution has an invalid gateway model receipt');
  }
}

function jsonScalar(value: unknown, field: string): JsonScalar {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`${field} is not JSON-safe`);
}

function finiteCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} is not a valid count`);
  return value;
}

function positiveCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be greater than zero`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function canonicalHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.+$/u, '');
    if (!hostname || /%(?![0-9a-f]{2})/iu.test(url.pathname)) return null;
    url.hostname = hostname;
    url.pathname = url.pathname.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => {
      const character = String.fromCharCode(Number.parseInt(hex, 16));
      return /^[a-z0-9._~-]$/iu.test(character) ? character : `%${hex.toUpperCase()}`;
    });
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

function uniqueHttpsUrls(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const canonical = canonicalHttpsUrl(value);
    return canonical === null ? [] : [canonical];
  }))];
}

export function formatSmokeReceipt(input: SmokeReceiptInput): SmokeReceipt {

  if (
    input.toolReceipt.actorId !== 'tavily-web-search'
    || input.toolReceipt.executionMode !== 'real'
    || input.toolReceipt.declaredAdapterType !== 'tavily'
    || input.toolReceipt.resolvedAdapterType !== 'tavily'
  ) {
    throw new Error('Tool receipt must prove a real Tavily tavily-web-search execution');
  }
  const toolReceipt = Object.fromEntries(
    TOOL_RECEIPT_FIELDS.map((field) => [
      field,
      field === 'latencyMs'
        ? finiteNumber(input.toolReceipt[field], `toolReceipt.${field}`)
        : jsonScalar(input.toolReceipt[field], `toolReceipt.${field}`),
    ]),
  );
  const toolArtifactIds = sortedUniqueIds(input.toolArtifactIds, 'toolArtifactIds');
  const visualAssetIds = sortedUniqueIds(input.visualAssetIds, 'visualAssetIds');
  const visualAssetManifestIds = sortedUniqueIds(
    input.visualAssetManifestIds,
    'visualAssetManifestIds',
  );
  const browserCaptureIds = sortedUniqueIds(input.browserCaptureIds, 'browserCaptureIds');
  const browserCaptureHosts = sortedUniqueIds(input.browserCaptureHosts, 'browserCaptureHosts');
  const screenshotEvidenceIds = sortedUniqueIds(
    input.screenshotEvidenceIds,
    'screenshotEvidenceIds',
  );
  const chartRenderIds = sortedUniqueIds(input.chartRenderIds, 'chartRenderIds');
  if (
    input.historyRereadVerified !== true
    || finiteCount(input.visualAssetCount, 'visualAssetCount') !== visualAssetIds.length
    || visualAssetManifestIds.length !== visualAssetIds.length
    || finiteCount(input.browserCaptureCount, 'browserCaptureCount') !== browserCaptureIds.length
    || finiteCount(input.screenshotEvidenceCount, 'screenshotEvidenceCount')
      !== screenshotEvidenceIds.length
    || finiteCount(input.chartRenderCount, 'chartRenderCount') !== chartRenderIds.length
    || typeof input.browserToolVerified !== 'boolean'
    || (browserCaptureIds.length > 0 && !input.browserToolVerified)
  ) {
    throw new Error('Smoke receipt evidence counts or historical verification are invalid');
  }

  return {
    scenarioId: nonBlankString(input.scenarioId, 'scenarioId'),
    profile: input.profile,
    taskType: input.taskType,
    deliverableType: nonBlankString(input.deliverableType, 'deliverableType'),
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    reportPackageId: input.reportPackageId,
    visualAssetCount: finiteCount(input.visualAssetCount, 'visualAssetCount'),
    gapCount: finiteCount(input.gapCount, 'gapCount'),
    toolArtifactIds,
    visualAssetIds,
    visualAssetManifestIds,
    browserCaptureCount: finiteCount(input.browserCaptureCount, 'browserCaptureCount'),
    browserCaptureIds,
    browserCaptureHosts,
    screenshotEvidenceCount: finiteCount(
      input.screenshotEvidenceCount,
      'screenshotEvidenceCount',
    ),
    screenshotEvidenceIds,
    chartRenderCount: finiteCount(input.chartRenderCount, 'chartRenderCount'),
    chartRenderIds,
    browserToolVerified: input.browserToolVerified === true,
    historyRereadVerified: input.historyRereadVerified,
    evidenceCount: finiteCount(input.counts.evidence, 'counts.evidence'),
    provider: input.provider,
    requestedModel: input.requestedModel,
    actualModel: input.actualModel,
    coreTool: input.coreTool,
    packageSealed: input.packageSealed,
    review: verifyAutomatedReviewArtifactReceipt(input.review),
    deliverableArtifactId: input.deliverableArtifactId,
    evidenceManifestArtifactId: input.evidenceManifestArtifactId,
    evidenceArtifactIds: [...input.evidenceArtifactIds],
    toolReceipt,
    counts: {
      evidence: finiteCount(input.counts.evidence, 'counts.evidence'),
      findings: positiveCount(input.counts.findings, 'counts.findings'),
      recommendations: positiveCount(input.counts.recommendations, 'counts.recommendations'),
    },
    sources: uniqueHttpsUrls(input.sources),
  };
}

export function assertSmokeReceiptMinimums(
  receipt: Pick<SmokeReceipt, 'evidenceCount' | 'visualAssetCount' | 'sources'>,
  scenario: Pick<SemanticGoldScenario, 'minPublicSources' | 'minVisualAssets'>,
): void {
  const minPublicSources = finiteCount(scenario.minPublicSources, 'scenario.minPublicSources');
  const minVisualAssets = finiteCount(scenario.minVisualAssets, 'scenario.minVisualAssets');
  const uniqueSources = uniqueHttpsUrls(receipt.sources);
  if (receipt.evidenceCount < minPublicSources || uniqueSources.length < minPublicSources) {
    throw new Error('real smoke evidence is below the semantic Gold minimum');
  }
  if (receipt.visualAssetCount < minVisualAssets) {
    throw new Error('real smoke visual inventory is below the semantic Gold minimum');
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} is missing or invalid`);
  }
  return value as Record<string, unknown>;
}
export interface AutomatedReviewArtifactReceipt {
  artifactId: string;
  automated: true;
  verdict: 'pass';
}

export function verifyAutomatedReviewArtifactReceipt(value: unknown): AutomatedReviewArtifactReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('automated Review Artifact receipt is missing or invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.artifactId !== 'string'
    || candidate.artifactId.trim() === ''
    || candidate.automated !== true
    || candidate.verdict !== 'pass'
  ) {
    throw new Error('automated Review Artifact receipt is missing or invalid');
  }
  return {
    artifactId: candidate.artifactId,
    automated: true,
    verdict: 'pass',
  };
}

export function designSmokeInputValue(filePath: string | undefined): { dataUrl: string } {
  const path = nonBlankString(filePath, 'CURRENT_DESIGN_SMOKE_IMAGE_PATH');
  if (!isAbsolute(path)) {
    throw new Error('CURRENT_DESIGN_SMOKE_IMAGE_PATH must be an absolute local path');
  }
  const contentType = ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  } as const)[extname(path).toLowerCase() as '.jpg' | '.jpeg' | '.png' | '.webp'];
  if (!contentType) {
    throw new Error('CURRENT_DESIGN_SMOKE_IMAGE_PATH must reference JPEG, PNG, or WebP');
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0) throw new Error('CURRENT_DESIGN_SMOKE_IMAGE_PATH is empty');
  return { dataUrl: `data:${contentType};base64,${bytes.toString('base64')}` };
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} is missing or invalid`);
  return value;
}

function nonBlankString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is missing or invalid`);
  }
  return value;
}

export function selectSmokeScenario(
  fixture: SemanticGoldFixture,
  profile: string,
  scenarioId: string,
): SemanticGoldScenario {
  if (typeof scenarioId !== 'string' || scenarioId.trim() === '') {
    throw new Error('scenarioId is required');
  }
  if (!fixture.profiles.includes(profile)) throw new Error(`fixture has no profile ${profile}`);
  const scenario = fixture.scenarios.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`smoke scenario ${scenarioId} was not found`);
  if (scenario.profile !== profile) {
    throw new Error(`smoke scenario ${scenarioId} does not match profile ${profile}`);
  }
  if (scenario.variant !== 'clear' || scenario.piiDetected !== false) {
    throw new Error(`smoke scenario ${scenarioId} is not a safe clear scenario`);
  }
  return scenario;
}

function sortedUniqueIds(values: readonly unknown[], field: string): string[] {
  const ids = values.map((value, index) => nonBlankString(value, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${field} contains duplicate ids`);
  return [...ids].sort();
}

function reportAssetReferences(delivered: Record<string, unknown>): Map<string, string> {
  const references = new Map<string, string>();
  if (delivered.reportDocument === undefined) return references;
  const document = record(delivered.reportDocument, 'reportDocument');
  const sections = array(document.sections, 'reportDocument.sections');
  const add = (value: unknown, field: string): void => {
    const reference = record(value, field);
    const assetId = nonBlankString(reference.assetId, `${field}.assetId`);
    const manifestArtifactId = nonBlankString(
      reference.manifestArtifactId,
      `${field}.manifestArtifactId`,
    );
    const prior = references.get(assetId);
    if (prior !== undefined && prior !== manifestArtifactId) {
      throw new Error(`visual Asset ${assetId} has conflicting Manifest ids`);
    }
    references.set(assetId, manifestArtifactId);
  };
  sections.forEach((sectionValue, sectionIndex) => {
    const section = record(sectionValue, `reportDocument.sections[${sectionIndex}]`);
    array(section.blocks, `reportDocument.sections[${sectionIndex}].blocks`)
      .forEach((blockValue, blockIndex) => {
        const field = `reportDocument.sections[${sectionIndex}].blocks[${blockIndex}]`;
        const block = record(blockValue, field);
        if (block.type === 'image') add(block.assetRef, `${field}.assetRef`);
        else if (block.type === 'image-comparison') {
          add(block.beforeAssetRef, `${field}.beforeAssetRef`);
          add(block.afterAssetRef, `${field}.afterAssetRef`);
        } else if (block.type === 'chart') add(block.chartRef, `${field}.chartRef`);
      });
  });
  return references;
}

interface ParsedSmokeGapSummary {
  keys: string[];
  failuresHash: string;
  scope: 'page' | 'step';
}

function parseSmokeGapSummary(value: unknown, field: string): ParsedSmokeGapSummary {
  const summary = record(value, field);
  const fields = Object.keys(summary).sort();
  if (JSON.stringify(fields) !== JSON.stringify(['count', 'failuresHash', 'keys'])) {
    throw new Error('gapSummary may contain only count, keys, and failuresHash');
  }
  const count = finiteNumber(summary.count, `${field}.count`);
  const keys = array(summary.keys, `${field}.keys`)
    .map((key, index) => nonBlankString(key, `${field}.keys[${index}]`));
  const failuresHash = nonBlankString(summary.failuresHash, `${field}.failuresHash`);
  if (!Number.isInteger(count) || count <= 0 || count !== keys.length) {
    throw new Error('gapSummary count does not match its keys');
  }
  if (new Set(keys).size !== keys.length) throw new Error('gapSummary keys are not unique');
  if (!/^sha256:[a-f0-9]{64}$/u.test(failuresHash)) {
    throw new Error('gapSummary failuresHash is invalid');
  }
  const pageScoped = keys.every((key) => /^(?:0|[1-9]\d*):[a-z][a-z0-9_]*$/u.test(key));
  const stepScoped = keys.length === 1 && /^step:[a-z][a-z0-9_]*$/u.test(keys[0]!);
  if (!pageScoped && !stepScoped) {
    throw new Error('gapSummary keys are malformed or mix page and step scopes');
  }
  return { keys, failuresHash, scope: pageScoped ? 'page' : 'step' };
}

function gapKeys(input: {
  plan: unknown;
  steps: readonly SmokeEvidenceStep[];
}): Set<string> {
  const keys = new Set<string>();
  const plan = record(input.plan, 'plan');
  const capabilityGaps = plan.capability_gaps === undefined
    ? []
    : array(plan.capability_gaps, 'plan.capability_gaps');
  capabilityGaps.forEach((value, index) => {
    const gap = record(value, `plan.capability_gaps[${index}]`);
    const capabilityId = nonBlankString(gap.capability_id, 'capability gap id');
    const code = nonBlankString(gap.code, 'capability gap code');
    keys.add(`capability:${capabilityId}:${code}`);
  });

  input.steps.forEach((step, index) => {
    const stepNo = finiteNumber(step.stepNo, `steps[${index}].stepNo`);
    if (!Number.isInteger(stepNo) || stepNo <= 0) throw new Error(`steps[${index}].stepNo is invalid`);
    const provenance = step.toolProvenance;
    if (provenance === null || provenance === undefined) {
      if (step.actorType === 'tool' && step.state === 'skipped') keys.add(`step:${stepNo}:legacy_skip`);
      return;
    }
    const toolProvenance = record(provenance, `steps[${index}].toolProvenance`);
    if (toolProvenance.gapSummary === undefined) {
      if (step.actorType === 'tool' && step.state === 'skipped') keys.add(`step:${stepNo}:legacy_skip`);
      return;
    }
    const summary = parseSmokeGapSummary(
      toolProvenance.gapSummary,
      `steps[${index}].toolProvenance.gapSummary`,
    );
    summary.keys.forEach((key) => keys.add(`step:${stepNo}:${key}`));
  });
  return keys;
}

function stableSmokeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSmokeValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableSmokeValue(child)]),
  );
}

function smokeHashJson(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stableSmokeValue(value)))
    .digest('hex')}`;
}

export function verifySmokeGapSummaryHashes(input: {
  steps: readonly SmokeEvidenceStep[];
  toolOutputsByArtifactId: Readonly<Record<string, unknown>>;
}): void {
  input.steps.forEach((step, index) => {
    const provenance = step.toolProvenance;
    if (!provenance || provenance.gapSummary === undefined) return;
    const summary = parseSmokeGapSummary(
      provenance.gapSummary,
      `steps[${index}].toolProvenance.gapSummary`,
    );
    let truthSource: unknown;
    if (summary.scope === 'step') {
      if (step.state !== 'skipped') {
        throw new Error(`step gapSummary is not allowed on ${step.state} step ${step.stepNo}`);
      }
      truthSource = record(step.failure, `steps[${index}].failure`);
    } else if (step.state === 'succeeded') {
      const artifactId = nonBlankString(step.outputArtifactId, `steps[${index}].outputArtifactId`);
      if (!Object.hasOwn(input.toolOutputsByArtifactId, artifactId)) {
        throw new Error(`Tool Artifact ${artifactId} is unavailable for gapSummary verification`);
      }
      const artifact = record(input.toolOutputsByArtifactId[artifactId], `Tool Artifact ${artifactId}`);
      truthSource = record(artifact.output, `Tool Artifact ${artifactId}.output`).failures;
    } else if (step.state === 'skipped') {
      truthSource = record(step.failure, `steps[${index}].failure`).page_failures;
    } else {
      throw new Error(`gapSummary is not allowed on ${step.state} step ${step.stepNo}`);
    }
    if (
      (summary.scope === 'page' && !Array.isArray(truthSource))
      || smokeHashJson(truthSource) !== summary.failuresHash
    ) {
      throw new Error('gapSummary failuresHash does not match its failure truth source');
    }
  });
}

export function summarizeSmokeEvidence(input: {
  plan: unknown;
  steps: readonly SmokeEvidenceStep[];
  delivered: unknown;
}): SmokeEvidenceSummary {
  const delivered = record(input.delivered, 'delivered');
  const references = reportAssetReferences(delivered);
  const manifests = delivered.visualAssetManifests === undefined
    ? []
    : array(delivered.visualAssetManifests, 'delivered.visualAssetManifests');
  const manifestByAsset = new Map<string, Record<string, unknown>>();
  manifests.forEach((value, index) => {
    const manifest = record(value, `delivered.visualAssetManifests[${index}]`);
    const assetId = nonBlankString(
      manifest.assetId,
      `delivered.visualAssetManifests[${index}].assetId`,
    );
    if (manifestByAsset.has(assetId)) throw new Error(`duplicate visual Asset ${assetId}`);
    if (!references.has(assetId)) {
      throw new Error(`visual Asset ${assetId} has no ReportDocument Manifest reference`);
    }
    manifestByAsset.set(assetId, manifest);
  });
  if (references.size !== manifestByAsset.size) {
    throw new Error('ReportDocument visual references do not match delivered visual Assets');
  }

  const evidenceManifest = record(delivered.evidenceManifest, 'delivered.evidenceManifest');
  const evidenceEntries = array(evidenceManifest.entries, 'delivered.evidenceManifest.entries')
    .map((value, index) => record(value, `delivered.evidenceManifest.entries[${index}]`));
  const screenshotEntries = evidenceEntries.filter((entry) => entry.kind === 'screenshot');
  const screenshotEvidenceIds = sortedUniqueIds(
    screenshotEntries.map((entry) => entry.id),
    'screenshotEvidenceIds',
  );
  const screenshotManifestIds = new Set(
    screenshotEntries.map((entry, index) => nonBlankString(
      entry.artifactId,
      `screenshotEntries[${index}].artifactId`,
    )),
  );

  const browserCaptureIds: string[] = [];
  const browserCaptureHosts: string[] = [];
  const chartRenderIds: string[] = [];
  for (const [assetId, manifest] of manifestByAsset) {
    const source = record(manifest.source, `visual Asset ${assetId}.source`);
    if (source.kind === 'browser_capture') {
      const manifestArtifactId = references.get(assetId)!;
      if (!screenshotManifestIds.has(manifestArtifactId)) {
        throw new Error(`browser capture ${assetId} has no screenshot Evidence`);
      }
      const sourceUrl = nonBlankString(
        source.sourcePageUrl,
        `browser capture ${assetId}.sourcePageUrl`,
      );
      const canonical = canonicalHttpsUrl(sourceUrl);
      if (canonical === null) throw new Error(`browser capture ${assetId} has an invalid source URL`);
      browserCaptureIds.push(assetId);
      browserCaptureHosts.push(new URL(canonical).hostname);
    } else if (source.kind === 'chart_render') {
      chartRenderIds.push(assetId);
    }
  }

  const toolSteps = input.steps.filter((step) => step.actorType === 'tool');
  const toolArtifactIds = sortedUniqueIds(
    toolSteps
      .filter((step) => step.state === 'succeeded')
      .map((step) => step.outputArtifactId),
    'toolArtifactIds',
  );
  const browserToolVerified = toolSteps.some((step) => {
    if (
      step.actorId !== 'playwright-page-capture'
      || step.state !== 'succeeded'
      || typeof step.outputArtifactId !== 'string'
    ) return false;
    const provenance = step.toolProvenance;
    return provenance !== null
      && typeof provenance === 'object'
      && !Array.isArray(provenance)
      && (provenance as Record<string, unknown>).executionMode === 'real'
      && (provenance as Record<string, unknown>).implementationId === 'playwright-page-capture-v1';
  });
  if (browserCaptureIds.length > 0 && !browserToolVerified) {
    throw new Error('browser captures have no qualifying real Playwright Tool receipt');
  }

  const visualAssetIds = sortedUniqueIds([...manifestByAsset.keys()], 'visualAssetIds');
  const visualAssetManifestIds = sortedUniqueIds([...references.values()], 'visualAssetManifestIds');
  const sortedBrowserCaptureIds = sortedUniqueIds(browserCaptureIds, 'browserCaptureIds');
  const sortedChartRenderIds = sortedUniqueIds(chartRenderIds, 'chartRenderIds');
  return {
    gapCount: gapKeys({ plan: input.plan, steps: input.steps }).size,
    toolArtifactIds,
    visualAssetIds,
    visualAssetManifestIds,
    browserCaptureCount: sortedBrowserCaptureIds.length,
    browserCaptureIds: sortedBrowserCaptureIds,
    browserCaptureHosts: [...new Set(browserCaptureHosts)].sort(),
    screenshotEvidenceCount: screenshotEvidenceIds.length,
    screenshotEvidenceIds,
    chartRenderCount: sortedChartRenderIds.length,
    chartRenderIds: sortedChartRenderIds,
    browserToolVerified,
  };
}

export function verifySmokeHistoryReread(input: {
  executionGapCount: number;
  initial: SmokeEvidenceSummary;
  reread: SmokeEvidenceSummary;
  requireBrowserEvidence: boolean;
}): VerifiedSmokeEvidenceSummary {
  const executionGapCount = finiteCount(input.executionGapCount, 'executionGapCount');
  if (executionGapCount !== input.initial.gapCount) {
    throw new Error('historical gapCount does not match the execution receipt');
  }
  if (JSON.stringify(input.initial) !== JSON.stringify(input.reread)) {
    throw new Error('historical reread counts or ids drifted');
  }
  if (input.requireBrowserEvidence && (
    input.initial.browserCaptureCount < 3
    || input.initial.browserCaptureHosts.length < 3
    || input.initial.screenshotEvidenceCount < 3
    || input.initial.chartRenderCount < 1
    || !input.initial.browserToolVerified
  )) {
    throw new Error('required browser or chart evidence is missing');
  }
  return { ...input.initial, historyRereadVerified: true };
}

const CONTROLLED_SMOKE_DECISION = [
  'Controlled smoke decision: use Mainland China and public sources from the last 24 months.',
  'Cover the primary segments implied by the original request, leading publicly discoverable brands, and official or mainstream ecommerce channels.',
  'Normalize comparable pricing and produce an actionable evidence-backed competitive analysis report.',
  'Treat unspecified details as conservative assumptions, proceed without private data or external side effects, and do not ask this question again.',
].join(' ');

function explicitSmokeConfirmationAnswers(confirmations: unknown[]): Record<string, unknown> {
  return Object.fromEntries(confirmations.map((candidate, index) => {
    const confirmation = record(candidate, `structuredTask.clarification_questions[${index}]`);
    const key = nonBlankString(confirmation.key, `structuredTask.clarification_questions[${index}].key`);
    const question = nonBlankString(
      confirmation.question,
      `structuredTask.clarification_questions[${index}].question`,
    );
    return [key, `${CONTROLLED_SMOKE_DECISION} Resolved question: ${question}`];
  }));
}

type SmokeRequirementResult<
  TRequirement extends { clarification_questions: unknown[] },
  TPlanning,
> =
  | { status: 'clarification_required'; requirement: TRequirement }
  | { status: 'ready_to_plan'; requirement: TRequirement; planningResult?: TPlanning };

export async function resolveSmokeRequirement<
  TRequirement extends { clarification_questions: unknown[] },
  TPlanning,
>(
  initial: SmokeRequirementResult<TRequirement, TPlanning>,
  clarify: (
    answers: Record<string, unknown>,
  ) => Promise<SmokeRequirementResult<TRequirement, TPlanning>>,
): Promise<SmokeRequirementResult<TRequirement, TPlanning>> {
  let current = initial;
  for (let round = 0; round < 3 && current.status === 'clarification_required'; round += 1) {
    const confirmations = current.requirement.clarification_questions;
    if (confirmations.length === 0) break;
    current = await clarify(explicitSmokeConfirmationAnswers(confirmations));
  }
  return current;
}

function missingPlanCapabilities(steps: SmokePlanStep[]): string[] {
  const missing = REQUIRED_EXACT_CAPABILITIES
    .filter((required) => !steps.some((step) => (
      step.actor_type === required.actor_type && step.actor_id === required.actor_id
    )))
    .map(({ actor_id }) => actor_id);
  for (const actorType of REQUIRED_ACTOR_TYPES) {
    if (!steps.some((step) => step.actor_type === actorType && step.actor_id.trim() !== '')) {
      missing.push(actorType);
    }
  }
  return missing;
}

export function requireActorCoverage(
  steps: Array<{ actorType: string; actorId: string; state: string }>,
  plannedSteps: SmokePlanStep[],
): void {
  if (missingPlanCapabilities(plannedSteps).length > 0) {
    throw new Error(`Smoke plan must include ${REQUIRED_CAPABILITY_DESCRIPTION}`);
  }
  const requiredPlannedSteps = [
    ...REQUIRED_EXACT_CAPABILITIES,
    ...REQUIRED_ACTOR_TYPES.map((actorType) => plannedSteps.find((step) => (
      step.actor_type === actorType && step.actor_id.trim() !== ''
    ))!),
  ];
  for (const required of requiredPlannedSteps) {
    if (!steps.some((step) => (
      step.actorType === required.actor_type
      && step.actorId === required.actor_id
      && step.state === 'succeeded'
    ))) {
      throw new Error(`execution is missing succeeded capability ${required.actor_id}`);
    }
  }

}
export function resolveApprovalMode(mode: ApprovalMode | undefined): ApprovalMode {
  return mode ?? 'allow_owner';
}

export function mayAutoApproveSmoke(mode?: ApprovalMode): boolean {
  return resolveApprovalMode(mode) === 'allow_owner';
}

export function assertSmokePlanApprovalPolicy(
  steps: readonly SmokePlanStep[],
  mode?: ApprovalMode,
): void {
  if (resolveApprovalMode(mode) === 'forbid' && steps.some((step) => step.requires_approval === true)) {
    throw new Error('GOLD_APPROVAL_GATE: selected plan contains requires_approval before confirmation');
  }
}

export function selectSmokeCandidate<
  T extends { candidateId: string; plan: { steps: SmokePlanStep[] } },
>(candidates: T[]): T {
  const coversAllCapabilities = (candidate: T) => missingPlanCapabilities(candidate.plan.steps).length === 0;
  const speed = candidates.find((candidate) => candidate.candidateId === 'speed' && coversAllCapabilities(candidate));
  if (speed) return speed;
  const completeCandidate = candidates.find(coversAllCapabilities);
  if (completeCandidate) return completeCandidate;
  throw new Error(`Smoke plan must include ${REQUIRED_CAPABILITY_DESCRIPTION}`);
}

type SeedUser = { id: string; status: string };
async function executeRealSmoke(
  scenario: SemanticGoldScenario,
  designImagePath?: string,
  requireBrowserEvidence = false,
  approvalMode: ApprovalMode = 'allow_owner',
): Promise<SmokeReceipt> {
  const [repositoryModule, seedModule, runtimeModule] = await Promise.all([
    import('../database/repository.ts'),
    import('../database/development-seed.ts'),
    import('../apps/agent-api/src/control-runtime.ts'),
  ]);
  const seedUserResult: SeedUser | null = await repositoryModule.getUserById(seedModule.DEVELOPMENT_SEED_USER_ID);
  if (!seedUserResult || seedUserResult.id !== seedModule.DEVELOPMENT_SEED_USER_ID) {
    throw new Error('DEVELOPMENT_SEED_MISSING: run pnpm db:seed');
  }
  if (seedUserResult.status !== 'active') {
    throw new Error('DEVELOPMENT_SEED_INACTIVE: run pnpm db:seed');
  }
  const seedUser: SeedUser = seedUserResult;

  const runtime = runtimeModule.buildControlRuntime();
  const conversation = await runtime.conversations.create({
    ownerUserId: seedUser.id,
    title: `Current real smoke: ${scenario.profile}`,
  });
  const created = await runtime.repository.createTask({
    conversationId: conversation.id,
    ownerUserId: seedUser.id,
    originalInput: scenario.input,
    taskType: scenario.taskType,
    structuredTask: {},
    state: 'awaiting_clarification',
    sensitivity: scenario.sensitivity,
    piiDetected: scenario.piiDetected,
  });
  const refined = await runtime.requirementRefinement.understand({
    taskId: created.id,
    conversationId: conversation.id,
    ownerUserId: seedUser.id,
    originalInput: scenario.input,
  });
  const finalized = await resolveSmokeRequirement(refined, (answers) => (
    runtime.requirementRefinement.clarify({
      taskId: created.id,
      conversationId: conversation.id,
      ownerUserId: seedUser.id,
      answers,
    })
  ));
  if (finalized.status !== 'ready_to_plan' || !finalized.planningResult) {
    throw new Error(`real smoke requirement did not become ready for ${scenario.profile}`);
  }
  if (finalized.requirement.task_type !== scenario.taskType) {
    throw new Error(`real smoke task type drifted for ${scenario.profile}`);
  }
  const finalizedTask = await runtime.repository.getTaskDetail(created.id);
  if (!finalizedTask) throw new Error(`real smoke task disappeared for ${scenario.profile}`);
  const planned = await runtime.controlPlanning.planExistingTask({
    taskId: created.id,
    conversationId: conversation.id,
    ownerUserId: seedUser.id,
    expectedStateVersion: finalizedTask.stateVersion,
    originalInput: scenario.input,
  }, finalized.planningResult);
  const selectedCandidate = selectSmokeCandidate(planned.candidates);
  if (selectedCandidate.plan.deliverable_type !== scenario.expectedDeliverableType) {
    throw new Error(`real smoke plan deliverable drifted for ${scenario.profile}`);
  }
  assertSmokePlanApprovalPolicy(selectedCandidate.plan.steps, approvalMode);

  const actor = { userId: seedUser.id, role: 'owner' as const };
  const taskId = nonBlankString(planned.task.id, 'taskId');
  const selected = await runtime.workflow.select({
    taskId,
    expectedVersion: planned.task.stateVersion,
    idempotencyKey: `current-real-smoke:select:${scenario.profile}:${taskId}`,
    actor,
    planVersionId: selectedCandidate.planVersionId,
  });
  const structuredTask = finalized.requirement;
  let confirmed = await runtime.workflow.confirm({
    taskId,
    planVersionId: selected.planVersionId,
    expectedVersion: selected.stateVersion,
    idempotencyKey: `current-real-smoke:confirm:${scenario.profile}:${taskId}`,
    actor,
    confirmationAnswers: explicitSmokeConfirmationAnswers(structuredTask.clarification_questions),
    inputValues: scenario.profile === 'design_audit'
      ? { designImage: designSmokeInputValue(designImagePath) }
      : {},
  });
  if (confirmed.state === 'awaiting_approval') {
    if (!mayAutoApproveSmoke(approvalMode)) {
      throw new Error('GOLD_APPROVAL_GATE: Gold confirmation reached awaiting_approval');
    }
    const approvalTask = await runtime.repository.getTaskDetail(taskId);
    const approvalPlan = await runtime.repository.getPlanVersionDetail(selected.planVersionId);
    if (!approvalTask || !approvalPlan) {
      throw new Error('real smoke approval state lost its task or plan');
    }
    for (const approval of requiredApprovals(approvalTask, approvalPlan)) {
      if (approval.authority !== actor.role) {
        throw new Error(`real smoke requires an unavailable ${approval.authority} approval for ${approval.key}`);
      }
      confirmed = await runtime.workflow.approve({
        taskId,
        planVersionId: selected.planVersionId,
        expectedVersion: confirmed.stateVersion,
        idempotencyKey: `current-real-smoke:approve:${scenario.profile}:${taskId}:${approval.key}`,
        actor,
        gateKey: approval.key,
        decision: 'approved',
      });
    }
  }
  if (confirmed.state !== 'ready') {
    throw new Error(`confirmed task must be ready, received ${confirmed.state}`);
  }

  const execution = await runtime.workflow.execute({
    taskId,
    planVersionId: selected.planVersionId,
    expectedVersion: confirmed.stateVersion,
    idempotencyKey: `current-real-smoke:execute:${scenario.profile}:${taskId}`,
    actor,
  });
  if (
    execution.executionDisabled
    || (execution.status !== 'completed' && execution.status !== 'completed_with_gaps')
  ) {
    throw new Error(`real execution did not complete: ${execution.state}`);
  }

  const attemptId = nonBlankString(execution.attemptId, 'attemptId');
  const deliverableArtifactId = nonBlankString(execution.deliverableArtifactId, 'deliverableArtifactId');
  const reportPackageArtifactId = nonBlankString(
    execution.reportPackageArtifactId,
    'reportPackageArtifactId',
  );
  const evidenceManifestArtifactId = nonBlankString(
    execution.evidenceManifestArtifactId,
    'evidenceManifestArtifactId',
  );
  const reportReviewArtifactId = nonBlankString(
    execution.reportReviewArtifactId,
    'reportReviewArtifactId',
  );
  const verifiedReportPackage = await new ReportPackageArtifactService(runtime.artifacts).verify({
    artifactId: reportPackageArtifactId,
    attemptId,
  });
  if (
    verifiedReportPackage.value.taskId !== taskId
    || verifiedReportPackage.value.planVersionId !== selected.planVersionId
    || verifiedReportPackage.value.deliverableArtifactId !== deliverableArtifactId
    || verifiedReportPackage.value.evidenceManifestArtifactId !== evidenceManifestArtifactId
    || verifiedReportPackage.value.reportReviewArtifactId !== reportReviewArtifactId
  ) {
    throw new Error('Report Package does not match the executed task components');
  }
  const delivered = record(
    await runtime.getDeliverable(taskId, seedUser.id),
    'deliverable response',
  );
  const deliverable = record(delivered.deliverable, 'deliverable');
  const manifest = record(delivered.evidenceManifest, 'evidenceManifest');
  const deliverableType = nonBlankString(deliverable.deliverableType, 'deliverable.deliverableType');
  if (deliverableType !== scenario.expectedDeliverableType) {
    throw new Error(`real smoke delivered the wrong report type for ${scenario.profile}`);
  }
  for (const [field, expected] of [
    ['taskId', taskId],
    ['planVersionId', selected.planVersionId],
    ['attemptId', attemptId],
  ] as const) {
    if (nonBlankString(manifest[field], `evidenceManifest.${field}`) !== expected) {
      throw new Error(`evidence manifest ${field} does not match execution identity`);
    }
  }
  if (nonBlankString(deliverable.taskId, 'deliverable.taskId') !== taskId) {
    throw new Error('deliverable.taskId does not match the executed task');
  }
  if (nonBlankString(deliverable.planVersionId, 'deliverable.planVersionId') !== selected.planVersionId) {
    throw new Error('deliverable.planVersionId does not match the selected plan');
  }
  if (nonBlankString(deliverable.attemptId, 'deliverable.attemptId') !== attemptId) {
    throw new Error('deliverable.attemptId does not match the execution attempt');
  }
  if (
    nonBlankString(deliverable.evidenceManifestArtifactId, 'deliverable.evidenceManifestArtifactId')
    !== evidenceManifestArtifactId
  ) {
    throw new Error('deliverable evidence manifest does not match the execution receipt');
  }

  const steps = await runtime.repository.listExecutionSteps(attemptId);
  requireActorCoverage(steps, selectedCandidate.plan.steps);
  const realToolStep = steps.find((step) => {
    const provenance = step.toolProvenance;
    return step.actorType === 'tool'
      && step.actorId === 'tavily-web-search'
      && step.state === 'succeeded'
      && provenance?.executionMode === 'real'
      && provenance.declaredAdapterType === 'tavily'
      && provenance.resolvedAdapterType === 'tavily'
      && typeof provenance.implementationId === 'string'
      && provenance.implementationId !== 'unknown';
  });
  if (!realToolStep?.toolProvenance) throw new Error('execution has no qualifying real Tavily Tool provenance');

  const configuredModel = nonBlankString(process.env.LLM_MODEL_NAME, 'LLM_MODEL_NAME');
  const expectedActualModel = nonBlankString(
    process.env.LLM_EXPECTED_ACTUAL_MODEL,
    'LLM_EXPECTED_ACTUAL_MODEL',
  );
  const modelRoutes = parseModelRoutes(
    process.env.LLM_MODEL_ROUTES,
    configuredModel,
    expectedActualModel,
  );
  const modelCalls = await runtime.repository.listModelCalls(attemptId);
  assertGatewayModelReceipts({ modelRoutes, modelCalls });
  const representativeModelCall = modelCalls[0]!;

  const entries = array(manifest.entries, 'evidenceManifest.entries').map((entry, index) => (
    record(entry, `evidenceManifest.entries[${index}]`)
  ));
  const realEvidenceEntries = entries.filter((entry) => {
    const proof = entry.toolProof;
    return entry.toolId === 'tavily-web-search'
      && proof !== null
      && typeof proof === 'object'
      && !Array.isArray(proof)
      && (proof as Record<string, unknown>).executionMode === 'real';
  });
  if (realEvidenceEntries.length === 0) throw new Error('evidence manifest has no real Tool evidence');

  const evidenceArtifactIds = [...new Set(realEvidenceEntries.map((entry, index) => (
    nonBlankString(entry.artifactId, `evidenceManifest.entries[${index}].artifactId`)
  )))];
  const sources = uniqueHttpsUrls(realEvidenceEntries.map((entry, index) => (
    nonBlankString(entry.sourceUrl, `evidenceManifest.entries[${index}].sourceUrl`)
  )));
  if (sources.length === 0) throw new Error('evidence manifest has no HTTPS source');

  await Promise.all([
    runtime.artifacts.verifySealed(deliverableArtifactId),
    runtime.artifacts.verifySealed(evidenceManifestArtifactId),
    runtime.artifacts.verifySealed(reportReviewArtifactId),
    ...evidenceArtifactIds.map((artifactId) => runtime.artifacts.verifySealed(artifactId)),
  ]);

  const findingGraph = record(deliverable.findingGraph, 'deliverable.findingGraph');
  const findings = array(findingGraph.findings, 'deliverable.findingGraph.findings');
  const recommendations = array(deliverable.recommendations, 'deliverable.recommendations');
  const review = record(delivered.reportReview, 'reportReview');
  if (nonBlankString(review.verdict, 'reportReview.verdict') !== 'pass') {
    throw new Error('real smoke requires a passed automated Review Artifact');
  }
  const automatedReview = verifyAutomatedReviewArtifactReceipt({
    artifactId: reportReviewArtifactId,
    automated: true,
    verdict: review.verdict,
  });
  const visualAssetCount = 'visualAssetManifests' in delivered && Array.isArray(delivered.visualAssetManifests)
    ? delivered.visualAssetManifests.length
    : 0;
  const gapArtifactIds = [...new Set(steps.flatMap((step) => (
    step.state === 'succeeded'
    && step.toolProvenance?.gapSummary !== undefined
    && typeof step.outputArtifactId === 'string'
      ? [step.outputArtifactId]
      : []
  )))];
  const gapArtifacts = await Promise.all(gapArtifactIds.map(async (artifactId) => {
    const artifact = await runtime.artifacts.readVerifiedJson<unknown>(artifactId);
    return [artifactId, artifact.value] as const;
  }));
  verifySmokeGapSummaryHashes({
    steps,
    toolOutputsByArtifactId: Object.fromEntries(gapArtifacts),
  });
  const initialEvidence = summarizeSmokeEvidence({
    plan: selectedCandidate.plan,
    steps,
    delivered,
  });
  await Promise.all([
    ...initialEvidence.toolArtifactIds,
    ...initialEvidence.visualAssetIds,
    ...initialEvidence.visualAssetManifestIds,
  ].map((artifactId) => runtime.artifacts.verifySealed(artifactId)));
  if (initialEvidence.browserCaptureCount > 0) {
    const browserStep = steps.find((step) => (
      step.actorType === 'tool'
      && step.actorId === 'playwright-page-capture'
      && step.state === 'succeeded'
    ));
    const browserArtifactId = nonBlankString(
      browserStep?.outputArtifactId,
      'Playwright Tool Artifact id',
    );
    const browserArtifact = await runtime.artifacts.readVerifiedJson<unknown>(browserArtifactId);
    const browserOutput = record(
      record(browserArtifact.value, 'Playwright Tool Artifact').output,
      'Playwright Tool Artifact.output',
    );
    if (
      browserOutput.security_profile !== 'browser-controls-v1'
      || array(browserOutput.captures, 'Playwright Tool Artifact.output.captures').length
        < initialEvidence.browserCaptureCount
    ) {
      throw new Error('Playwright Tool Artifact does not prove the browser-controls-v1 capture');
    }
  }
  const [rereadPlan, rereadSteps, rereadDelivered, rereadTask, rereadReportPackage] = await Promise.all([
    runtime.repository.getActivePlan(taskId),
    runtime.repository.listExecutionSteps(attemptId),
    runtime.getDeliverable(taskId, seedUser.id),
    runtime.repository.getTaskDetail(taskId),
    runtime.repository.findSealedArtifact({ taskId, attemptId, kind: 'report_package' }),
  ]);
  if (
    !rereadPlan
    || rereadPlan.planVersionId !== selected.planVersionId
    || !rereadDelivered
    || !rereadTask
    || rereadTask.activePlanVersionId !== selected.planVersionId
    || rereadTask.currentAttemptId !== attemptId
    || rereadReportPackage?.id !== reportPackageArtifactId
  ) {
    throw new Error('historical reread did not preserve task, plan, attempt, and Report Package identity');
  }
  const verifiedEvidence = verifySmokeHistoryReread({
    executionGapCount: finiteNumber(execution.gapCount, 'execution.gapCount'),
    initial: initialEvidence,
    reread: summarizeSmokeEvidence({
      plan: rereadPlan.plan,
      steps: rereadSteps,
      delivered: rereadDelivered,
    }),
    requireBrowserEvidence,
  });
  const expectedTaskState = verifiedEvidence.gapCount > 0 ? 'completed_with_gaps' : 'completed';
  if (rereadTask.state !== expectedTaskState) {
    throw new Error('historical task state does not match its gapCount');
  }
  const provenance = realToolStep.toolProvenance;
  return formatSmokeReceipt({
    scenarioId: scenario.id,
    profile: scenario.profile,
    taskType: finalized.requirement.task_type,
    deliverableType,
    taskId,
    planVersionId: selected.planVersionId,
    attemptId,
    reportPackageId: reportPackageArtifactId,
    visualAssetCount,
    ...verifiedEvidence,
    provider: 'gateway',
    requestedModel: representativeModelCall.requestedModel,
    actualModel: representativeModelCall.actualModel,
    coreTool: 'tavily-web-search',
    packageSealed: verifiedReportPackage.artifact.state === 'SEALED',
    review: automatedReview,
    deliverableArtifactId,
    evidenceManifestArtifactId,
    evidenceArtifactIds,
    toolReceipt: {
      actorId: realToolStep.actorId,
      declaredAdapterType: provenance.declaredAdapterType,
      resolvedAdapterType: provenance.resolvedAdapterType,
      implementationId: provenance.implementationId,
      executionMode: provenance.executionMode,
      endpointHost: provenance.endpointHost ?? null,
      status: 'ok',
      latencyMs: realToolStep.latencyMs,
    },
    counts: {
      evidence: sources.length,
      findings: findings.length,
      recommendations: recommendations.length,
    },
    sources,
  });
}

function requireBrowserEvidence(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('CURRENT_REQUIRE_BROWSER_EVIDENCE must be exactly 0 or 1');
}

function readFixture(fixturePath: string): SemanticGoldFixture {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as SemanticGoldFixture;
  if (!Array.isArray(fixture.profiles) || !Array.isArray(fixture.scenarios)) {
    throw new Error('current semantic Gold fixture is malformed');
  }
  return fixture;
}

export async function runCurrentRealSmoke(input: SmokeRunInput): Promise<SmokeReceipt[]> {
  try {
    loadEnv();
    const fixture = readFixture(input.fixturePath);
    if (input.profiles.length !== 1) {
      throw new Error('real smoke requires exactly one profile and one scenarioId');
    }
    const profile = input.profiles[0]!;
    if (!(CURRENT_REAL_SMOKE_PROFILES as readonly string[]).includes(profile)) {
      throw new Error(`real smoke profile ${profile} has no supported full-real contract`);
    }
    const scenario = selectSmokeScenario(fixture, profile, input.scenarioId);
    const browserEvidenceRequired = requireBrowserEvidence(
      process.env.CURRENT_REQUIRE_BROWSER_EVIDENCE,
    );
    if (browserEvidenceRequired && process.env.PLAYWRIGHT_CAPTURE_ENABLED !== '1') {
      throw new Error('required browser evidence needs PLAYWRIGHT_CAPTURE_ENABLED=1');
    }
    assertRealSmokeConfig(process.env);
    const receipt = await executeRealSmoke(
      scenario,
      input.designImagePath ?? process.env.CURRENT_DESIGN_SMOKE_IMAGE_PATH,
      browserEvidenceRequired,
      resolveApprovalMode(input.approvalMode),
    );
    assertSmokeReceiptMinimums(receipt, scenario);
    return [receipt];
  } finally {
    await closePool();
  }
}

export function safeSmokeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const messageHash = createHash('sha256').update(message).digest('hex').slice(0, 16);
  return `Current real smoke failed message_hash=${messageHash}`;
}

async function main(): Promise<void> {
  try {
    const fixturePath = process.env.CURRENT_REAL_SMOKE_FIXTURE
      ?? 'tests/fixtures/current-semantic-gold.json';
    const profile = process.env.CURRENT_SMOKE_PROFILE ?? CURRENT_REAL_SMOKE_PROFILES[0];
    const scenarioId = nonBlankString(process.env.CURRENT_SMOKE_SCENARIO, 'CURRENT_SMOKE_SCENARIO');
    console.log(JSON.stringify(await runCurrentRealSmoke({ fixturePath, profiles: [profile], scenarioId })));
  } catch (error) {
    console.error(safeSmokeErrorMessage(error));
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) void main();
