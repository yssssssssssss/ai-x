import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { closePool, loadEnv } from '../database/db.ts';

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
  sensitivity: ResearchTaskV2['sensitivity'];
  piiDetected: boolean;
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
  { actor_type: 'skill', actor_id: 'competitive-web-research' },
  { actor_type: 'skill', actor_id: 'generate-research-plan' },
];
const REQUIRED_ACTOR_TYPES = ['llm', 'reviewer'] as const;
const REQUIRED_CAPABILITY_DESCRIPTION = [
  ...REQUIRED_EXACT_CAPABILITIES.map(({ actor_id }) => actor_id),
  ...REQUIRED_ACTOR_TYPES,
].join(', ');

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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
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
    sources: input.sources.filter(isHttpsUrl),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} is missing or invalid`);
  }
  return value as Record<string, unknown>;
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

function explicitSmokeConfirmationAnswers(confirmations: unknown[]): Record<string, unknown> {
  return Object.fromEntries(confirmations.map((candidate, index) => {
    const confirmation = record(candidate, `structuredTask.clarification_questions[${index}]`);
    const key = nonBlankString(confirmation.key, `structuredTask.clarification_questions[${index}].key`);
    const question = nonBlankString(
      confirmation.question,
      `structuredTask.clarification_questions[${index}].question`,
    );
    return [key, `Real smoke explicit confirmation: ${question}`];
  }));
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
  const finalized = refined.status === 'clarification_required'
    ? await runtime.requirementRefinement.clarify({
      taskId: created.id,
      conversationId: conversation.id,
      ownerUserId: seedUser.id,
      answers: explicitSmokeConfirmationAnswers(refined.requirement.clarification_questions),
    })
    : refined;
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
  if (configuredModel !== expectedActualModel) {
    throw new Error('LLM model pin must match requested and actual model');
  }
  const modelCalls = await runtime.repository.listModelCalls(attemptId);
  if (
    modelCalls.length === 0
    || modelCalls.some((call) => (
      call.status !== 'succeeded'
      || call.provider !== 'gateway'
      || call.requestedModel !== configuredModel
      || call.actualModel !== expectedActualModel
    ))
  ) {
    throw new Error('execution has an invalid gateway model receipt');
  }

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
  const sources = realEvidenceEntries.map((entry, index) => (
    nonBlankString(entry.sourceUrl, `evidenceManifest.entries[${index}].sourceUrl`)
  ));
  if (!sources.some(isHttpsUrl)) throw new Error('evidence manifest has no HTTPS source');

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
  const visualAssetCount = 'visualAssetManifests' in delivered && Array.isArray(delivered.visualAssetManifests)
    ? delivered.visualAssetManifests.length
    : 0;
  const provenance = realToolStep.toolProvenance;
  return formatSmokeReceipt({
    profile: scenario.profile,
    taskType: finalized.requirement.task_type,
    taskId,
    planVersionId: selected.planVersionId,
    attemptId,
    reportPackageId: deliverableArtifactId,
    visualAssetCount,
    provider: 'gateway',
    requestedModel: configuredModel,
    actualModel: expectedActualModel,
    coreTool: 'tavily-web-search',
    packageSealed: true,
    review: {
      reviewerId: 'report-review-service',
      authenticated: true,
      independent: true,
      verdict: 'usable',
    },
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
      evidence: realEvidenceEntries.length,
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
      if (!fixture.profiles.includes(profile)) throw new Error(`fixture has no profile ${profile}`);
      const scenario = fixture.scenarios.find((candidate) => candidate.profile === profile);
      if (!scenario) throw new Error(`fixture has no scenario for profile ${profile}`);
      receipts.push(await executeRealSmoke(scenario));
    }
    return receipts;
  } finally {
    await closePool();
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Current real smoke failed';
}

async function main(): Promise<void> {
  try {
    const fixturePath = process.env.CURRENT_REAL_SMOKE_FIXTURE
      ?? 'tests/fixtures/current-semantic-gold.json';
    const profile = process.env.CURRENT_SMOKE_PROFILE ?? 'competitive_research';
    console.log(JSON.stringify(await runCurrentRealSmoke({ fixturePath, profiles: [profile] })));
  } catch (error) {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) void main();
