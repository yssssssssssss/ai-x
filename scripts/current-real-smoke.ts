import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { closePool, loadEnv } from '../database/db.ts';
import {
  parseModelRoutes,
  type GatewayModelRoute,
} from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';

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
}

type JsonScalar = string | number | boolean | null;

export interface SmokeReceiptInput {
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
    reviewerId: string;
    authenticated: boolean;
    independent: boolean;
    verdict: 'usable' | 'needs_revision' | 'unusable';
  };
}
export interface SmokeReceipt extends SmokeReceiptInput {
  evidenceCount: number;
}

interface SemanticGoldScenario {
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

interface SemanticGoldFixture {
  profiles: string[];
  scenarios: SemanticGoldScenario[];
}

interface SmokeRunInput {
  fixturePath: string;
  profiles: string[];
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


interface SmokePlanStep {
  actor_type: string;
  actor_id: string;
}

const REQUIRED_EXACT_CAPABILITIES: SmokePlanStep[] = [
  { actor_type: 'tool', actor_id: 'tavily-web-search' },
];
const REQUIRED_ACTOR_TYPES = ['skill', 'llm', 'reviewer'] as const;
const REQUIRED_CAPABILITY_DESCRIPTION = [
  ...REQUIRED_EXACT_CAPABILITIES.map(({ actor_id }) => actor_id),
  ...REQUIRED_ACTOR_TYPES,
].join(', ');

export const CURRENT_REAL_SMOKE_PROFILES = ['competitive_research'] as const;

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
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} is not a valid count`);
  return value;
}

function positiveCount(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be greater than zero`);
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

  return {
    profile: input.profile,
    taskType: input.taskType,
    deliverableType: nonBlankString(input.deliverableType, 'deliverableType'),
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    reportPackageId: input.reportPackageId,
    visualAssetCount: finiteCount(input.visualAssetCount, 'visualAssetCount'),
    evidenceCount: finiteCount(input.counts.evidence, 'counts.evidence'),
    provider: input.provider,
    requestedModel: input.requestedModel,
    actualModel: input.actualModel,
    coreTool: input.coreTool,
    packageSealed: input.packageSealed,
    review: input.review,
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
export interface PersistedIndependentReview {
  reviewerId: string;
  authenticated: boolean;
  independent: boolean;
  verdict: 'usable' | 'needs_revision' | 'unusable';
}

export function verifyPersistedIndependentReview(value: unknown): PersistedIndependentReview {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('independent review evidence is missing or invalid');
  }
  const candidate = value as Record<string, unknown>;
  const reviewerId = candidate.reviewerId;
  const verdict = candidate.verdict;
  if (
    typeof reviewerId !== 'string'
    || reviewerId.trim() === ''
    || candidate.authenticated !== true
    || candidate.independent !== true
    || (verdict !== 'usable' && verdict !== 'needs_revision' && verdict !== 'unusable')
  ) {
    throw new Error('independent review evidence is missing or invalid');
  }
  return {
    reviewerId,
    authenticated: true,
    independent: true,
    verdict,
  };
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
async function executeRealSmoke(scenario: SemanticGoldScenario): Promise<SmokeReceipt> {
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
  const confirmed = await runtime.workflow.confirm({
    taskId,
    planVersionId: selected.planVersionId,
    expectedVersion: selected.stateVersion,
    idempotencyKey: `current-real-smoke:confirm:${scenario.profile}:${taskId}`,
    actor,
    confirmationAnswers: explicitSmokeConfirmationAnswers(structuredTask.clarification_questions),
    inputValues: {},
  });
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
  const evidenceManifestArtifactId = nonBlankString(
    execution.evidenceManifestArtifactId,
    'evidenceManifestArtifactId',
  );
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
    ...evidenceArtifactIds.map((artifactId) => runtime.artifacts.verifySealed(artifactId)),
  ]);

  const findingGraph = record(deliverable.findingGraph, 'deliverable.findingGraph');
  const findings = array(findingGraph.findings, 'deliverable.findingGraph.findings');
  const recommendations = array(deliverable.recommendations, 'deliverable.recommendations');
  const review = record(delivered.reportReview, 'reportReview');
  if (nonBlankString(review.verdict, 'reportReview.verdict') !== 'pass') {
    throw new Error('real smoke requires an independently passed report review');
  }
  const persistedReview = await runtime.repository.findPersistedIndependentReview(attemptId);
  const independentReview = verifyPersistedIndependentReview(persistedReview);
  if (independentReview.verdict !== 'usable') {
    throw new Error('real smoke requires an independently usable persisted review');
  }
  const visualAssetCount = 'visualAssetManifests' in delivered && Array.isArray(delivered.visualAssetManifests)
    ? delivered.visualAssetManifests.length
    : 0;
  const provenance = realToolStep.toolProvenance;
  return formatSmokeReceipt({
    profile: scenario.profile,
    taskType: finalized.requirement.task_type,
    deliverableType,
    taskId,
    planVersionId: selected.planVersionId,
    attemptId,
    reportPackageId: deliverableArtifactId,
    visualAssetCount,
    provider: 'gateway',
    requestedModel: representativeModelCall.requestedModel,
    actualModel: representativeModelCall.actualModel,
    coreTool: 'tavily-web-search',
    packageSealed: true,
    review: independentReview,
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
    assertRealSmokeConfig(process.env);
    const fixture = readFixture(input.fixturePath);
    const receipts: SmokeReceipt[] = [];
    for (const profile of input.profiles) {
      if (!(CURRENT_REAL_SMOKE_PROFILES as readonly string[]).includes(profile)) {
        throw new Error(`real smoke profile ${profile} has no supported full-real contract`);
      }
      if (!fixture.profiles.includes(profile)) throw new Error(`fixture has no profile ${profile}`);
      const candidates = fixture.scenarios.filter((candidate) => candidate.profile === profile);
      const scenario = candidates.find((candidate) => candidate.variant === 'clear' && candidate.piiDetected === false);
      if (!scenario) throw new Error(`fixture has no safe clear scenario for profile ${profile}`);
      if (scenario.piiDetected) throw new Error(`PII scenario ${profile} cannot enter real smoke`);
      const receipt = await executeRealSmoke(scenario);
      assertSmokeReceiptMinimums(receipt, scenario);
      receipts.push(receipt);
    }
    return receipts;
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
    console.log(JSON.stringify(await runCurrentRealSmoke({ fixturePath, profiles: [profile] })));
  } catch (error) {
    console.error(safeSmokeErrorMessage(error));
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) void main();
