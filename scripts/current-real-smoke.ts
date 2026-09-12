import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { closePool, loadEnv } from '../database/db.ts';
import {
  parseModelRoutes,
  type GatewayModelRoute,
} from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import { requiredApprovals } from '../apps/orchestrator-runtime/src/control/task-workflow.ts';
import { ReportPackageArtifactService } from '../apps/orchestrator-runtime/src/report/report-package-artifact.ts';
import { ReportPackageV2ArtifactService } from '../apps/orchestrator-runtime/src/report/report-package-v2-artifact.ts';
import { ReportPackageV3ArtifactService } from '../apps/orchestrator-runtime/src/report/report-package-v3-artifact.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

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
  MULTI_SKILL_PORTFOLIO_WRITER_ENABLED?: string;
  VIRTUAL_USER_BASE_URL?: string;
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
export interface EditorialSummarySmokeResult {
  status: 'ready' | 'failed';
  htmlSha256?: string;
  failure?: string;
}

export interface JoyspaceSmokeReceipt {
  status: 'available';
  stepNo: number;
  toolArtifactId: string;
  knowledgeSnapshotArtifactId: string;
  evidenceId: string;
  o2Version: string;
  webcliVersion: string;
}

export interface SmokeReceipt extends SmokeReceiptInput {
  evidenceCount: number;
  editorialSummary?: EditorialSummarySmokeResult;
  joyspace?: JoyspaceSmokeReceipt;
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
  requireMultiSkill?: boolean;
  expectedContributorSkillIds?: string[];
  requiredToolIds?: string[];
  requireJoyspace?: boolean;
  planningScenarioId?: string;
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
  skillProvenance?: Record<string, unknown> | null;
  failure?: Record<string, unknown> | null;
}

export type ApprovalMode = 'allow_owner' | 'forbid';

export interface SmokeProgressEvent {
  stage: 'starting' | 'requirement' | 'planning' | 'confirmation' | 'execution' | 'verification' | 'completed';
  message: string;
  taskId?: string;
  attemptId?: string;
  elapsedMs: number;
}

export interface SmokeRunInput {
  fixturePath: string;
  profiles: string[];
  scenarioId: string;
  designImagePath?: string;
  approvalMode?: ApprovalMode;
  progress?: (event: SmokeProgressEvent) => void;
}

export interface SmokeReportContract {
  reportDocumentVersion?: 'report-document-v2' | 'report-document-v3' | 'report-document-v4';
  reportPackageVersion: 'report-package-v1' | 'report-package-v2' | 'report-package-v3';
  standaloneHtmlStatus: 'not_applicable' | 'ready';
  showcaseStatus: 'not_applicable' | 'ready';
  fixedPackageRoot: boolean;
}

export function resolveSmokeReportContract(input: {
  deliverableType: string;
  reportV3WriterEnabled: boolean;
  standaloneHtmlBundleV1Enabled: boolean;
  reportEditorialExperienceV1Enabled?: boolean;
  reportEditorialShowcaseV1Enabled?: boolean;
}): SmokeReportContract {
  const reportV3 = input.deliverableType === 'research_strategy_report'
    && input.reportV3WriterEnabled;
  const standaloneHtml = reportV3 && input.standaloneHtmlBundleV1Enabled;
  const showcase = standaloneHtml
    && input.reportEditorialExperienceV1Enabled === true
    && input.reportEditorialShowcaseV1Enabled === true;
  return {
    ...(input.deliverableType === 'research_strategy_report'
      ? { reportDocumentVersion: showcase
          ? 'report-document-v4'
          : reportV3 ? 'report-document-v3' : 'report-document-v2' }
      : {}),
    reportPackageVersion: showcase
      ? 'report-package-v3'
      : standaloneHtml ? 'report-package-v2' : 'report-package-v1',
    standaloneHtmlStatus: standaloneHtml ? 'ready' : 'not_applicable',
    showcaseStatus: showcase ? 'ready' : 'not_applicable',
    fixedPackageRoot: standaloneHtml,
  };
}

export class SmokeInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SmokeInfrastructureError';
  }
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
  'research_synthesis',
  'voc_diagnosis',
  'design_audit',
  'a11y_audit',
  'industry_market_analysis',
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

export async function assertVirtualUserLabReady(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let root: URL;
  try {
    root = new URL(baseUrl);
  } catch (cause) {
    throw new SmokeInfrastructureError('virtual-user-lab preflight failed', { cause });
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    throw new SmokeInfrastructureError('virtual-user-lab preflight failed');
  }
  const endpoint = (path: string): string => new URL(path, `${root.toString().replace(/\/+$/u, '')}/`).toString();
  try {
    const health = await fetchImpl(endpoint('api/health'), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) throw new SmokeInfrastructureError('virtual-user-lab health preflight failed');
    const healthBody = await health.json() as { ok?: unknown; service?: unknown };
    if (healthBody.ok !== true || healthBody.service !== 'virtual-user-lab') {
      throw new SmokeInfrastructureError('virtual-user-lab health preflight failed');
    }

    const simulation = await fetchImpl(endpoint('api/simulate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'real smoke readiness probe' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!simulation.ok) throw new SmokeInfrastructureError('virtual-user-lab simulation preflight failed');
    const simulationBody: unknown = await simulation.json();
    new SchemaValidator().validateFileOrThrow(
      join(process.cwd(), 'tools/virtual-user-lab/output.schema.json'),
      simulationBody,
    );
    if ((simulationBody as { status?: unknown }).status !== 'available') {
      throw new SmokeInfrastructureError('virtual-user-lab simulation preflight failed');
    }
  } catch (cause) {
    if (cause instanceof SmokeInfrastructureError) throw cause;
    throw new SmokeInfrastructureError('virtual-user-lab preflight failed', { cause });
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

export async function readEditorialSummaryWithOneRetry(
  read: () => Promise<string | null>,
): Promise<string | null> {
  try {
    return await read();
  } catch {
    return read();
  }
}

export async function verifyEditorialSummaryForSmoke(
  read: () => Promise<string | null>,
): Promise<EditorialSummarySmokeResult> {
  try {
    const html = await readEditorialSummaryWithOneRetry(read);
    if (
      !html
      || !/^<!doctype html>/iu.test(html.trim())
      || !/<html\b[^>]*\blang=["'](?:zh-CN|en)["']/iu.test(html)
      || !/data-summary-section-id=/u.test(html)
      || !/data-source-ids=/u.test(html)
      || /<(?:iframe|object|embed|form)\b/iu.test(html)
      || /<(?:script|img|video|audio|source)\b[^>]*\bsrc\s*=\s*["']https?:\/\//iu.test(html)
    ) throw new Error('Editorial Summary did not satisfy its binding, language, or offline contract');
    return {
      status: 'ready',
      htmlSha256: `sha256:${createHash('sha256').update(html).digest('hex')}`,
    };
  } catch (error) {
    return { status: 'failed', failure: safeSmokeErrorMessage(error) };
  }
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

  const skillInvocations = plan.skill_invocations === undefined
    ? []
    : array(plan.skill_invocations, 'plan.skill_invocations');
  skillInvocations.forEach((value, invocationIndex) => {
    const invocation = record(value, `plan.skill_invocations[${invocationIndex}]`);
    const invocationId = nonBlankString(invocation.invocation_id, 'Skill invocation id');
    const resourceGaps = invocation.resource_gaps === undefined
      ? []
      : array(invocation.resource_gaps, `plan.skill_invocations[${invocationIndex}].resource_gaps`);
    resourceGaps.forEach((gapValue, gapIndex) => {
      const gap = record(
        gapValue,
        `plan.skill_invocations[${invocationIndex}].resource_gaps[${gapIndex}]`,
      );
      const queryId = nonBlankString(gap.query_id, 'Skill resource gap query id');
      const minItems = finiteNumber(gap.min_items, 'Skill resource gap min_items');
      const selectedItems = finiteNumber(gap.selected_items, 'Skill resource gap selected_items');
      if (
        !Number.isInteger(minItems)
        || minItems < 1
        || !Number.isInteger(selectedItems)
        || selectedItems < 0
        || gap.failure_policy !== 'gap'
        || typeof gap.reason !== 'string'
        || !gap.reason.trim()
      ) {
        throw new Error('Skill resource gap is malformed');
      }
      keys.add(`skill:${invocationId}:resource:${queryId}`);
    });
  });

  input.steps.forEach((step, index) => {
    const stepNo = finiteNumber(step.stepNo, `steps[${index}].stepNo`);
    if (!Number.isInteger(stepNo) || stepNo <= 0) throw new Error(`steps[${index}].stepNo is invalid`);
    if (step.actorType === 'skill' && step.state === 'succeeded' && step.skillProvenance) {
      const skillProvenance = record(step.skillProvenance, `steps[${index}].skillProvenance`);
      if (skillProvenance.status === 'degraded') {
        keys.add(`step:${stepNo}:skill:${step.actorId}:degraded`);
      } else if (skillProvenance.status !== 'succeeded') {
        throw new Error(`steps[${index}].skillProvenance.status is invalid`);
      }
    }
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
  const answers: Record<string, string> = {
    outcome_mode: 'answer',
    deliverable_intent: 'research_strategy_report',
    app_definition: '包含品牌自有 App、垂直宠物 App 和综合电商平台 App，分别给出策略。',
    product_scope: '覆盖干粮、湿粮、鲜粮、冻干和烘焙主粮，并明确共同点与差异。',
    brand_price_segment: '覆盖国产与进口、中端与高端价格带，优先新手与精养宠物主人。',
    key_findings_definition: '每个必答问题至少给出一条关键结论，置信度使用 0 到 1，设计原则至少五条。',
  };
  return Object.fromEntries(confirmations.map((candidate, index) => {
    const confirmation = record(candidate, `structuredTask.clarification_questions[${index}]`);
    const key = nonBlankString(confirmation.key, `structuredTask.clarification_questions[${index}].key`);
    const question = nonBlankString(
      confirmation.question,
      `structuredTask.clarification_questions[${index}].question`,
    );
    return [key, answers[key] ?? `${CONTROLLED_SMOKE_DECISION} Resolved question: ${question}`];
  }));
}

type SmokeRequirementResult<
  TRequirement extends { clarification_questions: unknown[] },
  TPlanning,
> =
  | {
      status: 'clarification_required';
      requirement: TRequirement;
      planningGuidance?: { options: Array<{ id: string }> };
    }
  | { status: 'ready_to_plan'; requirement: TRequirement; planningResult?: TPlanning };

export async function resolveSmokeRequirement<
  TRequirement extends { clarification_questions: unknown[] },
  TPlanning,
>(
  initial: SmokeRequirementResult<TRequirement, TPlanning>,
  clarify: (
    answers: Record<string, unknown>,
    selectedScenarioId?: string,
  ) => Promise<SmokeRequirementResult<TRequirement, TPlanning>>,
  preferredScenarioId?: string,
): Promise<SmokeRequirementResult<TRequirement, TPlanning>> {
  let current = initial;
  for (let round = 0; round < 3 && current.status === 'clarification_required'; round += 1) {
    const confirmations = current.requirement.clarification_questions;
    const selectedScenarioId = confirmations.length === 0
      ? preferredScenarioId ?? current.planningGuidance?.options[0]?.id
      : undefined;
    current = await clarify(
      confirmations.length === 0 ? {} : explicitSmokeConfirmationAnswers(confirmations),
      selectedScenarioId,
    );
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

export function assertMultiSkillSmokePlan(
  plan: Record<string, unknown>,
  scenario: Pick<SemanticGoldScenario, 'requireMultiSkill' | 'expectedContributorSkillIds' | 'requiredToolIds'>,
): void {
  if (!scenario.requireMultiSkill) return;
  if (plan.execution_contract_version !== 'current-execution-plan-v3') {
    throw new Error('multi-Skill real smoke requires CurrentExecutionPlan v3');
  }
  const invocations = array(plan.skill_invocations, 'plan.skill_invocations').map((value, index) => (
    record(value, `plan.skill_invocations[${index}]`)
  ));
  const contributors = invocations
    .filter(({ role }) => role === 'contributor')
    .map(({ skill_id }) => nonBlankString(skill_id, 'Contributor skill_id'))
    .sort();
  const expectedContributors = [...(scenario.expectedContributorSkillIds ?? [])].sort();
  if (
    invocations.filter(({ role }) => role === 'synthesizer').length !== 1
    || contributors.length < 1
    || expectedContributors.some((skillId) => !contributors.includes(skillId))
  ) {
    throw new Error('multi-Skill real smoke has an invalid Contributor/Synthesizer inventory');
  }
  const steps = array(plan.steps, 'plan.steps').map((value, index) => record(value, `plan.steps[${index}]`));
  for (const toolId of scenario.requiredToolIds ?? []) {
    if (!steps.some((step) => step.actor_type === 'tool' && step.actor_id === toolId)) {
      throw new Error(`multi-Skill real smoke is missing required Tool ${toolId}`);
    }
  }
  if (
    (scenario.requiredToolIds ?? []).includes('tavily-web-search')
    && !steps.some((step) => (
      step.actor_id === 'tavily-web-search'
      && typeof step.shared_stage_key === 'string'
      && Array.isArray(step.shared_by_invocation_ids)
      && step.shared_by_invocation_ids.length > 1
    ))
  ) throw new Error('multi-Skill real smoke requires one explicitly shared Tavily stage');
  record(plan.portfolio_summary, 'plan.portfolio_summary');
  array(plan.contribution_requirements, 'plan.contribution_requirements');
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
  progress: (event: SmokeProgressEvent) => void = () => {},
): Promise<SmokeReceipt> {
  const startedAt = Date.now();
  const reportProgress = (event: Omit<SmokeProgressEvent, 'elapsedMs'>) => progress({
    ...event,
    elapsedMs: Date.now() - startedAt,
  });
  reportProgress({ stage: 'starting', message: `starting ${scenario.profile}` });
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
  const orchestrationMode = process.env.MULTI_SKILL_PORTFOLIO_WRITER_ENABLED === 'true'
    ? 'multi_skill'
    : 'single_skill';
  const created = await runtime.repository.createTask({
    conversationId: conversation.id,
    ownerUserId: seedUser.id,
    originalInput: scenario.input,
    taskType: scenario.taskType,
    structuredTask: {},
    state: 'awaiting_clarification',
    sensitivity: scenario.sensitivity,
    piiDetected: scenario.piiDetected,
    orchestrationMode,
  });
  reportProgress({ stage: 'requirement', message: 'task created; refining requirement', taskId: created.id });
  const refined = await runtime.requirementRefinement.understand({
    taskId: created.id,
    conversationId: conversation.id,
    ownerUserId: seedUser.id,
    originalInput: scenario.input,
    orchestrationMode,
  });
  const finalized = await resolveSmokeRequirement(refined, (answers, selectedScenarioId) => (
    runtime.requirementRefinement.clarify({
      taskId: created.id,
      conversationId: conversation.id,
      ownerUserId: seedUser.id,
      answers,
      ...(selectedScenarioId ? { selectedScenarioId } : {}),
    })
  ), scenario.planningScenarioId);
  if (finalized.status !== 'ready_to_plan' || !finalized.planningResult) {
    throw new Error(`real smoke requirement did not become ready for ${scenario.profile}`);
  }
  if (finalized.requirement.task_type !== scenario.taskType) {
    throw new Error(`real smoke task type drifted for ${scenario.profile}`);
  }
  reportProgress({ stage: 'planning', message: 'requirement finalized; planning execution', taskId: created.id });
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
  assertMultiSkillSmokePlan(
    selectedCandidate.plan as unknown as Record<string, unknown>,
    scenario,
  );

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
  reportProgress({ stage: 'confirmation', message: 'plan confirmed; starting execution', taskId });

  let progressBusy = false;
  const executionProgress = setInterval(() => {
    if (progressBusy) return;
    progressBusy = true;
    void runtime.repository.getTaskDetail(taskId).then(async (currentTask) => {
      const currentAttemptId = currentTask?.currentAttemptId ?? undefined;
      const steps = currentAttemptId ? await runtime.repository.listExecutionSteps(currentAttemptId) : [];
      const succeeded = steps.filter(({ state }) => state === 'succeeded').length;
      reportProgress({
        stage: 'execution',
        message: `state=${currentTask?.state ?? 'unknown'} succeeded_steps=${succeeded}/${steps.length}`,
        taskId,
        ...(currentAttemptId ? { attemptId: currentAttemptId } : {}),
      });
    }).catch(() => {
      // Progress reporting is observational and must not interrupt the real execution.
    }).finally(() => {
      progressBusy = false;
    });
  }, 30_000);
  executionProgress.unref();

  let execution;
  try {
    execution = await runtime.workflow.execute({
    taskId,
    planVersionId: selected.planVersionId,
    expectedVersion: confirmed.stateVersion,
    idempotencyKey: `current-real-smoke:execute:${scenario.profile}:${taskId}`,
    actor,
  });
  } finally {
    clearInterval(executionProgress);
  }
  reportProgress({
    stage: 'verification',
    message: `execution returned ${'status' in execution ? execution.status : execution.state}`,
    taskId,
    attemptId: execution.attemptId,
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
  const multiSkillArtifactIds = scenario.requireMultiSkill
    ? {
        crossSkillReviewArtifactId: nonBlankString(
          execution.crossSkillReviewArtifactId,
          'crossSkillReviewArtifactId',
        ),
        contributionLedgerArtifactId: nonBlankString(
          execution.contributionLedgerArtifactId,
          'contributionLedgerArtifactId',
        ),
        contributionSummaryArtifactId: nonBlankString(
          execution.contributionSummaryArtifactId,
          'contributionSummaryArtifactId',
        ),
      }
    : null;
  const reportContract = resolveSmokeReportContract({
    deliverableType: scenario.expectedDeliverableType,
    reportV3WriterEnabled: process.env.REPORT_V3_WRITER_ENABLED === 'true',
    standaloneHtmlBundleV1Enabled: process.env.STANDALONE_HTML_BUNDLE_V1_ENABLED === 'true',
    reportEditorialExperienceV1Enabled: process.env.REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED === 'true',
    reportEditorialShowcaseV1Enabled: process.env.REPORT_EDITORIAL_SHOWCASE_V1_ENABLED === 'true',
  });
  if (
    (reportContract.reportPackageVersion === 'report-package-v2'
      || reportContract.reportPackageVersion === 'report-package-v3')
    && (
      reportContract.standaloneHtmlStatus !== 'ready'
      || reportContract.fixedPackageRoot !== true
    )
  ) {
    throw new Error('Report Package smoke contract is internally inconsistent');
  }
  const canonicalPackageService = new ReportPackageV2ArtifactService(runtime.artifacts);
  const verifiedShowcasePackage = reportContract.reportPackageVersion === 'report-package-v3'
    ? await new ReportPackageV3ArtifactService({
        artifacts: runtime.artifacts,
        canonicalPackages: canonicalPackageService,
      }).verify({
        artifactId: reportPackageArtifactId,
        taskId,
        planVersionId: selected.planVersionId,
        attemptId,
      })
    : null;
  const verifiedReportPackage = verifiedShowcasePackage
    ? await canonicalPackageService.verify({
        artifactId: verifiedShowcasePackage.value.canonicalPackageArtifactId,
        taskId,
        planVersionId: selected.planVersionId,
        attemptId,
      })
    : reportContract.reportPackageVersion === 'report-package-v2'
      ? await canonicalPackageService.verify({
          artifactId: reportPackageArtifactId,
          taskId,
          planVersionId: selected.planVersionId,
          attemptId,
        })
      : await new ReportPackageArtifactService(runtime.artifacts).verify({
          artifactId: reportPackageArtifactId,
          attemptId,
        });
  const reportPackageDocumentArtifactId = verifiedReportPackage.value.version === 'report-package-v2'
    ? verifiedReportPackage.value.sourceReportDocumentArtifactId
    : verifiedReportPackage.value.reportDocumentArtifactId;
  const reportPackageBlueprintArtifactId = verifiedReportPackage.value.version === 'report-package-v2'
    ? verifiedReportPackage.value.layout.blueprintArtifactId
    : verifiedReportPackage.value.reportLayoutBlueprintArtifactId;
  if (
    verifiedReportPackage.value.taskId !== taskId
    || verifiedReportPackage.value.planVersionId !== selected.planVersionId
    || verifiedReportPackage.value.deliverableArtifactId !== deliverableArtifactId
    || verifiedReportPackage.value.evidenceManifestArtifactId !== evidenceManifestArtifactId
    || verifiedReportPackage.value.reportReviewArtifactId !== reportReviewArtifactId
    || (multiSkillArtifactIds && (
      verifiedReportPackage.value.crossSkillReviewArtifactId !== multiSkillArtifactIds.crossSkillReviewArtifactId
      || verifiedReportPackage.value.contributionLedgerArtifactId !== multiSkillArtifactIds.contributionLedgerArtifactId
      || verifiedReportPackage.value.contributionSummaryArtifactId !== multiSkillArtifactIds.contributionSummaryArtifactId
    ))
    || (scenario.profile === 'research_synthesis' && !reportPackageBlueprintArtifactId)
  ) {
    throw new Error('Report Package does not match the executed task components');
  }
  if (
    verifiedReportPackage.value.version === 'report-package-v2'
    && verifiedReportPackage.value.standaloneHtml.status !== reportContract.standaloneHtmlStatus
  ) {
    throw new Error('Report Package v2 does not contain the required standalone HTML');
  }
  if (
    reportContract.reportPackageVersion === 'report-package-v3'
    && (
      verifiedShowcasePackage?.value.showcase.status !== reportContract.showcaseStatus
      || verifiedShowcasePackage.value.preferredHtml !== 'showcase'
    )
  ) {
    throw new Error('Report Package v3 does not contain the required Editorial Showcase');
  }
  const delivered = record(
    await runtime.getDeliverable(taskId, seedUser.id),
    'deliverable response',
  );
  if (scenario.requireMultiSkill) {
    record(delivered.crossSkillReview, 'deliverable response.crossSkillReview');
    record(delivered.contributionLedger, 'deliverable response.contributionLedger');
    record(delivered.contributionSummary, 'deliverable response.contributionSummary');
  }
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
  if (scenario.profile === 'industry_market_analysis') {
    const payload = record(deliverable.payload, 'deliverable.payload');
    if (payload.schemaVersion !== 'industry-market-analysis-v1') {
      throw new Error('Industry smoke did not produce the canonical Industry payload');
    }
    const coverage = array(payload.coverageLedger, 'deliverable.payload.coverageLedger')
      .map((value, index) => record(value, `coverageLedger[${index}]`));
    const dimensions = coverage.map((entry) => nonBlankString(entry.dimension, 'coverage dimension'));
    if (
      dimensions.length !== 10
      || new Set(dimensions).size !== 10
      || 'ABCDEFGHIJ'.split('').some((dimension) => !dimensions.includes(dimension))
    ) throw new Error('Industry smoke coverage ledger does not contain A-J exactly once');
    if (array(payload.strategyChains, 'deliverable.payload.strategyChains').length === 0) {
      throw new Error('Industry smoke has no strategy chain');
    }
  }
  if (scenario.profile === 'research_synthesis') {
    const payload = record(deliverable.payload, 'deliverable.payload');
    const directAnswers = array(payload.directAnswers, 'deliverable.payload.directAnswers').map((value, index) => record(value, `directAnswers[${index}]`));
    if (directAnswers.length === 0 || directAnswers.some((answer) => (
      !nonBlankString(answer.questionId, 'directAnswer.questionId')
      || !nonBlankString(answer.answer, 'directAnswer.answer')
      || typeof answer.confidence !== 'number'
      || !Array.isArray(answer.evidenceIds)
      || typeof answer.validationNeeded !== 'string'
    ))) throw new Error('research strategy direct answers are incomplete');
    if (payload.schemaVersion !== 'research-strategy-content-v2') {
      throw new Error('research strategy requires open content payload v2');
    }
    const contentBlocks = array(payload.contentBlocks, 'deliverable.payload.contentBlocks').map((value, index) => record(value, `contentBlocks[${index}]`));
    const blocksByKind = new Map(contentBlocks.map((block) => [nonBlankString(block.kind, 'contentBlock.kind'), block]));
    const strategyMap = blocksByKind.get('strategy_map');
    const mindModel = blocksByKind.get('mind_model');
    if (!strategyMap || array(strategyMap.cells, 'strategyMap.cells').length === 0 || !mindModel || array(mindModel.nodes, 'mindModel.nodes').length === 0) {
      throw new Error('research strategy map or mind model is empty');
    }
    const principles = blocksByKind.get('design_principles');
    if (!principles || array(principles.items, 'designPrinciples.items').length < 5) {
      throw new Error('research strategy requires at least five design principles for the Gold scenario');
    }
    const opportunities = blocksByKind.get('opportunity_backlog');
    if (!opportunities || array(opportunities.items, 'opportunityBacklog.items').length === 0) {
      throw new Error('research strategy opportunities are empty');
    }
    const actionBlocks = contentBlocks.filter((block) => block.kind === 'prioritized_actions' || block.kind === 'action_plan');
    const priorities = new Set(actionBlocks.flatMap((block, blockIndex) => (
      array(block.items, `actionBlocks[${blockIndex}].items`).map((value, index) => (
        nonBlankString(record(value, `actionItems[${index}]`).priority, `actionItems[${index}].priority`)
      ))
    )));
    for (const priority of ['P0', 'P1', 'P2']) if (!priorities.has(priority)) throw new Error(`research strategy is missing ${priority} action`);
    const reportDocument = record(delivered.reportDocument, 'reportDocument');
    if (reportDocument.version !== reportContract.reportDocumentVersion) {
      throw new Error(`research strategy requires ${reportContract.reportDocumentVersion}`);
    }
    if (reportDocument.layoutMode !== 'model' && reportDocument.layoutMode !== 'fallback') {
      throw new Error('research strategy requires an explicit model or fallback layout mode');
    }
    const answerReview = record(delivered.reportReview, 'reportReview');
    if (answerReview.version !== 'report-review-v2') throw new Error('research strategy requires ReportReview v2');
    if (reportPackageDocumentArtifactId === undefined) {
      throw new Error('research strategy Report Package is missing its ReportDocument');
    }
    if (verifiedReportPackage.value.version === 'report-package-v2') {
      const packageHtml = verifiedReportPackage.value.standaloneHtml;
      if (packageHtml.status !== 'ready') {
        throw new Error('Report Package v2 does not contain the required standalone HTML');
      }
      const deliveredPackage = record(delivered.reportPackage, 'reportPackage');
      if (
        deliveredPackage.version !== verifiedReportPackage.value.version
        || deliveredPackage.reportPublicationId !== verifiedReportPackage.value.reportPublicationId
        || delivered.reportDocumentContentSha256
          !== verifiedReportPackage.value.sourceReportDocumentContentSha256
      ) {
        throw new Error('Report Package v2 is not fixed to the delivered ReportDocument publication');
      }
      const deliveredHtml = record(deliveredPackage.standaloneHtml, 'reportPackage.standaloneHtml');
      if (
        deliveredHtml.status !== 'ready'
        || deliveredHtml.artifactId !== packageHtml.artifactId
        || deliveredHtml.rendererVersion !== packageHtml.rendererVersion
      ) {
        throw new Error('delivered Report Package does not preserve standalone HTML identity');
      }
    }
  }

  const steps = await runtime.repository.listExecutionSteps(attemptId);
  let joyspaceReceipt: JoyspaceSmokeReceipt | undefined;
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
  if (scenario.requireMultiSkill) {
    for (const toolId of scenario.requiredToolIds ?? []) {
      const toolStep = steps.find((step) => (
        step.actorType === 'tool'
        && step.actorId === toolId
        && step.state === 'succeeded'
        && step.toolProvenance?.executionMode === 'real'
        && typeof step.toolProvenance.implementationId === 'string'
        && step.toolProvenance.implementationId !== 'unknown'
      ));
      if (!toolStep) throw new Error(`multi-Skill real smoke has no real ${toolId} receipt`);
    }
    const plan = selectedCandidate.plan as unknown as Record<string, unknown>;
    const contributorSkillIds = array(plan.skill_invocations, 'plan.skill_invocations')
      .map((value, index) => record(value, `plan.skill_invocations[${index}]`))
      .filter(({ role }) => role === 'contributor')
      .map(({ skill_id }) => nonBlankString(skill_id, 'Contributor skill_id'));
    for (const skillId of contributorSkillIds) {
      const outputStep = [...steps].reverse().find((step) => (
        step.actorType === 'skill'
        && step.actorId === skillId
        && step.state === 'succeeded'
        && typeof step.outputArtifactId === 'string'
      ));
      const artifact = outputStep?.outputArtifactId
        ? await runtime.repository.getArtifact(outputStep.outputArtifactId)
        : null;
      if (!artifact || artifact.state !== 'SEALED' || artifact.kind !== 'research_contribution') {
        throw new Error(`multi-Skill Contributor ${skillId} has no SEALED Research Contribution`);
      }
    }
  }

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
  const requiredModelCalls = modelCalls.filter((call) => call.stage !== 'report_layout' || call.status === 'succeeded');
  assertGatewayModelReceipts({ modelRoutes, modelCalls: requiredModelCalls });
  if (
    (scenario.profile === 'research_synthesis' || scenario.profile === 'industry_market_analysis')
    && modelCalls.some(({ stage }) => stage === 'deliverable')
  ) {
    throw new Error('reviewed Skill execution must not rewrite the Skill output in a deliverable LLM stage');
  }
  const representativeModelCall = requiredModelCalls[0]!;

  const entries = array(manifest.entries, 'evidenceManifest.entries').map((entry, index) => (
    record(entry, `evidenceManifest.entries[${index}]`)
  ));
  if (scenario.requireJoyspace === true) {
    const joyspaceStep = steps.find((step) => (
      step.actorType === 'tool'
      && step.actorId === 'joyspace-read'
      && step.state === 'succeeded'
      && step.toolProvenance?.executionMode === 'real'
      && step.toolProvenance.declaredAdapterType === 'o2'
      && step.toolProvenance.resolvedAdapterType === 'o2'
      && step.toolProvenance.endpointHost === 'joyspace.jd.com'
    ));
    if (!joyspaceStep?.toolProvenance) {
      throw new Error('Industry real smoke has no qualifying Joyspace search/view receipt');
    }
    const versions = record(joyspaceStep.toolProvenance.runtimeVersions, 'Joyspace runtimeVersions');
    nonBlankString(versions.o2, 'Joyspace o2 version');
    nonBlankString(versions.webcli, 'Joyspace webcli version');
    const snapshotIds = array(
      joyspaceStep.toolProvenance.knowledgeSnapshotArtifactIds,
      'Joyspace knowledgeSnapshotArtifactIds',
    ).map((value, index) => nonBlankString(value, `Joyspace snapshot ${index}`));
    if (snapshotIds.length !== 1) throw new Error('Industry real smoke requires one Joyspace Knowledge Snapshot');
    const artifacts = await runtime.repository.listArtifactsForAttempt({
      taskId,
      planVersionId: selected.planVersionId,
      attemptId,
    });
    const snapshot = artifacts.find(({ id }) => id === snapshotIds[0]);
    if (
      !snapshot
      || snapshot.state !== 'SEALED'
      || snapshot.kind !== 'knowledge_snapshot'
      || snapshot.schemaVersion !== 'joyspace-knowledge-snapshot-v1'
      || !snapshot.contentSha256
    ) throw new Error('Industry real smoke Joyspace Knowledge Snapshot is not SEALED');
    if (!entries.some((entry) => (
      entry.kind === 'knowledge_excerpt'
      && entry.evidenceClass === 'knowledge'
      && entry.artifactId === snapshot.id
      && entry.sensitivity === 'internal'
      && typeof entry.sourceUrl === 'string'
      && entry.sourceUrl.startsWith('https://joyspace.jd.com/')
    ))) throw new Error('Industry real smoke has no Joyspace Knowledge Evidence binding');
    const evidence = entries.find((entry) => entry.artifactId === snapshot.id)!;
    joyspaceReceipt = {
      status: 'available',
      stepNo: joyspaceStep.stepNo,
      toolArtifactId: nonBlankString(joyspaceStep.outputArtifactId, 'Joyspace Tool Artifact id'),
      knowledgeSnapshotArtifactId: snapshot.id,
      evidenceId: nonBlankString(evidence.id, 'Joyspace Evidence id'),
      o2Version: nonBlankString(versions.o2, 'Joyspace o2 version'),
      webcliVersion: nonBlankString(versions.webcli, 'Joyspace webcli version'),
    };
  }
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
    ...(multiSkillArtifactIds
      ? Object.values(multiSkillArtifactIds).map((artifactId) => runtime.artifacts.verifySealed(artifactId))
      : []),
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
  const editorialSummary = await verifyEditorialSummaryForSmoke(() => (
    runtime.readEditorialSummaryHtml({
      taskId,
      attemptId,
      ownerUserId: seedUser.id,
    })
  ));
  const provenance = realToolStep.toolProvenance;
  reportProgress({
    stage: 'completed',
    message: 'real smoke completed and verified',
    taskId,
    attemptId,
  });
  return {
    ...formatSmokeReceipt({
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
    }),
    editorialSummary,
    ...(joyspaceReceipt ? { joyspace: joyspaceReceipt } : {}),
  };
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
    if (scenario.requireMultiSkill) {
      if (process.env.MULTI_SKILL_PORTFOLIO_WRITER_ENABLED !== 'true') {
        throw new Error('multi-Skill real smoke requires MULTI_SKILL_PORTFOLIO_WRITER_ENABLED=true');
      }
      if (typeof process.env.VIRTUAL_USER_BASE_URL !== 'string' || !process.env.VIRTUAL_USER_BASE_URL.trim()) {
        throw new Error('multi-Skill real smoke requires VIRTUAL_USER_BASE_URL');
      }
    }
    const browserEvidenceRequired = requireBrowserEvidence(
      process.env.CURRENT_REQUIRE_BROWSER_EVIDENCE,
    );
    if (browserEvidenceRequired && process.env.PLAYWRIGHT_CAPTURE_ENABLED !== '1') {
      throw new Error('required browser evidence needs PLAYWRIGHT_CAPTURE_ENABLED=1');
    }
    assertRealSmokeConfig(process.env);
    if (scenario.requiredToolIds?.includes('virtual-user-lab')) {
      await assertVirtualUserLabReady(process.env.VIRTUAL_USER_BASE_URL!);
    }
    const receipt = await executeRealSmoke(
      scenario,
      input.designImagePath ?? process.env.CURRENT_DESIGN_SMOKE_IMAGE_PATH,
      browserEvidenceRequired,
      resolveApprovalMode(input.approvalMode),
      (event) => input.progress?.(event),
    );
    assertSmokeReceiptMinimums(receipt, scenario);
    return [receipt];
  } finally {
    await closePool();
  }
}

export function safeSmokeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : 'UnknownError';
  const messageHash = createHash('sha256').update(message).digest('hex').slice(0, 16);
  return `Current real smoke failed error_type=${errorType} message_hash=${messageHash}`;
}

async function main(): Promise<void> {
  try {
    const profile = process.env.CURRENT_SMOKE_PROFILE ?? CURRENT_REAL_SMOKE_PROFILES[0];
    const fixturePath = process.env.CURRENT_REAL_SMOKE_FIXTURE
      ?? (profile === 'research_synthesis'
        ? 'tests/fixtures/research-synthesis-real-smoke.json'
        : profile === 'industry_market_analysis'
          ? 'tests/fixtures/industry-real-smoke.json'
          : 'tests/fixtures/current-semantic-gold.json');
    const scenarioId = nonBlankString(process.env.CURRENT_SMOKE_SCENARIO, 'CURRENT_SMOKE_SCENARIO');
    console.log(JSON.stringify(await runCurrentRealSmoke({
      fixturePath,
      profiles: [profile],
      scenarioId,
      progress: (event) => console.error(JSON.stringify({ type: 'current-real-smoke-progress', ...event })),
    })));
  } catch (error) {
    console.error(safeSmokeErrorMessage(error));
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) void main();
