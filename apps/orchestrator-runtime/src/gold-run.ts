import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { verifyToken } from '../../agent-api/src/auth.ts';
import { buildControlRuntime } from '../../agent-api/src/control-runtime.ts';
import {
  GoldBatchService,
  goldPinsHash,
  type GoldPins,
} from './gold/gold-batch-service.ts';
import { ReportPackageArtifactService } from './report/report-package-artifact.ts';
import { assertTrustedGoldEnabled } from './audit/gold-policy.ts';
import { isInfraFailure } from './audit/failure-classify.ts';
import { hashFile } from './runtime/config-loader.ts';
import { closePool, loadEnv, pool } from '../../../database/db.ts';
import {
  PostgresGoldBatchStore,
  PostgresGoldReviewerAuthority,
} from '../../../database/gold-batch-store.ts';
import type { MigrationDatabase } from '../../../database/migration-runner.ts';
import {
  runCurrentRealSmoke,
  type SemanticGoldFixture,
  type SemanticGoldScenario,
  type LegacySmokeReceipt,
  type SmokeReceipt,
} from '../../../scripts/current-real-smoke.ts';

const GOLD_PROFILE = 'competitive_research';
export const GOLD_SCENARIO_ID = 'competitive-jd-crowdfunding-channel-gold';
const DEFAULT_FIXTURE = 'tests/fixtures/current-semantic-gold.json';

type GoldCommand =
  | { kind: 'collect'; batchId?: string }
  | { kind: 'review'; batchId: string; attemptId: string; verdict: 'usable' | 'needs_revision' | 'unusable' }
  | { kind: 'decide'; batchId: string };

function nonBlank(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function parseGoldCommand(args: string[]): GoldCommand {
  const [command, ...rest] = args;
  if (command === undefined || command === 'collect') {
    return { kind: 'collect', ...(rest[0] ? { batchId: rest[0] } : {}) };
  }
  if (command === 'review') {
    const [batchId, attemptId, verdict] = rest;
    if (
      !batchId
      || !attemptId
      || (verdict !== 'usable' && verdict !== 'needs_revision' && verdict !== 'unusable')
      || rest.length !== 3
    ) {
      throw new Error('usage: pnpm gold:run review <batch_id> <attempt_id> <usable|needs_revision|unusable>');
    }
    return { kind: 'review', batchId, attemptId, verdict };
  }
  if (command === 'decide') {
    if (!rest[0] || rest.length !== 1) throw new Error('usage: pnpm gold:run decide <batch_id>');
    return { kind: 'decide', batchId: rest[0] };
  }
  return { kind: 'collect', batchId: command };
}

export function assertGoldSmokeReceipt(
  receipt: SmokeReceipt,
  expectedScenarioId: string,
): asserts receipt is LegacySmokeReceipt {
  if ('contract' in receipt) {
    throw new Error('Gold collection has not switched from ReportPackage to FinalReport');
  }
  if (
    receipt.scenarioId !== expectedScenarioId
    || receipt.profile !== GOLD_PROFILE
    || receipt.taskType !== GOLD_PROFILE
    || receipt.provider !== 'gateway'
    || receipt.coreTool !== 'tavily-web-search'
    || receipt.toolReceipt.actorId !== 'tavily-web-search'
    || receipt.toolReceipt.executionMode !== 'real'
    || receipt.toolReceipt.declaredAdapterType !== 'tavily'
    || receipt.toolReceipt.resolvedAdapterType !== 'tavily'
    || typeof receipt.toolReceipt.implementationId !== 'string'
    || receipt.toolReceipt.implementationId.trim() === ''
    || !receipt.requestedModel.trim()
    || !receipt.actualModel.trim()
    || receipt.packageSealed !== true
    || !receipt.attemptId.trim()
    || !receipt.reportPackageId.trim()
    || receipt.toolArtifactIds.length === 0
    || receipt.visualAssetCount !== receipt.visualAssetIds.length
    || receipt.visualAssetCount !== receipt.visualAssetManifestIds.length
    || receipt.historyRereadVerified !== true
    || receipt.review.automated !== true
    || receipt.review.verdict !== 'pass'
  ) {
    throw new Error('Gold collection received a non-qualifying Current real-smoke receipt');
  }
}

export function buildGoldPins(input: {
  scenarioId: string;
  scenarioInput: string;
  endpoint: string;
  requestedModel: string;
  expectedActualModel: string;
  buildId: string;
}): GoldPins {
  return {
    scenarioId: nonBlank(input.scenarioId, 'scenarioId'),
    scenarioInputHash: sha256(nonBlank(input.scenarioInput, 'scenarioInput')),
    policyHash: hashFile('orchestrator/gold-policy.yaml'),
    provider: 'gateway',
    endpoint: new URL(nonBlank(input.endpoint, 'LLM_GATEWAY_BASE_URL')).host,
    requestedModel: nonBlank(input.requestedModel, 'LLM_MODEL_NAME'),
    expectedActualModel: nonBlank(input.expectedActualModel, 'LLM_EXPECTED_ACTUAL_MODEL'),
    coreTool: 'tavily-web-search',
    buildHash: sha256(nonBlank(input.buildId, 'buildId')),
    registryHash: hashFile('orchestrator/skill-registry.yaml'),
    schemaHash: hashFile('schemas/deliverables/competitive-analysis-report.schema.json'),
    reviewPolicyHash: hashFile('orchestrator/report-rubrics/competitive-analysis-report.yaml'),
  };
}

function liveDatabase(): MigrationDatabase {
  return { connect: () => pool.connect() };
}

function goldService(authenticatedReviewerId?: string): {
  service: GoldBatchService;
  store: PostgresGoldBatchStore;
} {
  const database = liveDatabase();
  const store = new PostgresGoldBatchStore(database);
  const reviewerAuthority = new PostgresGoldReviewerAuthority(database);
  const service = new GoldBatchService(store, {
    reportPackages: {
      verify: (input) => new ReportPackageArtifactService(buildControlRuntime().artifacts).verify(input),
    },
    reviewers: {
      verifyReviewer: async (input) => {
        const verified = await reviewerAuthority.verifyReviewer(input);
        return {
          ...verified,
          authenticated: verified.authenticated && input.reviewerId === authenticatedReviewerId,
        };
      },
    },
  });
  return { service, store };
}

export function selectGoldScenario(fixture: SemanticGoldFixture): SemanticGoldScenario {
  const matches = fixture.scenarios.filter(({ id }) => id === GOLD_SCENARIO_ID);
  if (matches.length !== 1) {
    throw new Error(`Gold fixture must contain exactly one ${GOLD_SCENARIO_ID} scenario`);
  }
  const scenario = matches[0]!;
  if (
    scenario.profile !== GOLD_PROFILE
    || scenario.taskType !== GOLD_PROFILE
    || scenario.variant !== 'clear'
    || scenario.piiDetected !== false
    || typeof scenario.input !== 'string'
    || scenario.input.trim() === ''
  ) {
    throw new Error(`Gold scenario ${GOLD_SCENARIO_ID} is not a safe clear competitive scenario`);
  }
  return scenario;
}

function fixtureScenario(fixturePath: string): { id: string; input: string } {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as SemanticGoldFixture;
  if (!Array.isArray(fixture.profiles) || !Array.isArray(fixture.scenarios)) {
    throw new Error('Gold fixture is malformed');
  }
  const scenario = selectGoldScenario(fixture);
  return { id: scenario.id, input: scenario.input };
}

function currentBuildId(): string {
  return process.env.GOLD_BUILD_ID
    ?? process.env.GITHUB_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function collect(command: Extract<GoldCommand, { kind: 'collect' }>): Promise<void> {
  const fixturePath = process.env.CURRENT_REAL_SMOKE_FIXTURE ?? DEFAULT_FIXTURE;
  const scenario = fixtureScenario(fixturePath);
  const pins = buildGoldPins({
    scenarioId: scenario.id,
    scenarioInput: scenario.input,
    endpoint: nonBlank(process.env.LLM_GATEWAY_BASE_URL, 'LLM_GATEWAY_BASE_URL'),
    requestedModel: nonBlank(process.env.LLM_MODEL_NAME, 'LLM_MODEL_NAME'),
    expectedActualModel: nonBlank(process.env.LLM_EXPECTED_ACTUAL_MODEL, 'LLM_EXPECTED_ACTUAL_MODEL'),
    buildId: currentBuildId(),
  });
  const batchId = command.batchId
    ?? `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${scenario.id}`;
  const { service, store } = goldService();
  const existing = await store.getBatch(batchId);
  if (!existing) {
    await service.createBatch({ batchId, pins });
  } else if (existing.pinsHash !== goldPinsHash(pins)) {
    throw new Error(`Gold batch ${batchId} pins do not match this build`);
  } else if (existing.state !== 'COLLECTING') {
    console.log(JSON.stringify({ batchId, machineState: existing.state, decision: existing.decision }));
    return;
  }

  for (const slot of await store.getSlots(batchId)) {
    if (slot.attemptId !== null) continue;
    while (true) {
      try {
        const [receipt] = await runCurrentRealSmoke({
          fixturePath,
          profiles: [GOLD_PROFILE],
          scenarioId: scenario.id,
          approvalMode: 'forbid',
        });
        if (!receipt) throw new Error('Current real smoke returned no Gold receipt');
        assertGoldSmokeReceipt(receipt, scenario.id);
        await service.recordAttempt({
          batchId,
          slotNo: slot.slotNo as 1 | 2 | 3,
          attemptId: receipt.attemptId,
          result: { kind: 'success', fullReal: true, reportPackageId: receipt.reportPackageId },
        });
        console.log(JSON.stringify({
          batchId,
          slotNo: slot.slotNo,
          attemptId: receipt.attemptId,
          reportPackageId: receipt.reportPackageId,
          machineReviewArtifactId: receipt.review.artifactId,
        }));
        break;
      } catch (error) {
        if (!isInfraFailure(error)) {
          throw new Error(`Gold slot ${slot.slotNo} capability run failed`, { cause: error });
        }
        await service.recordAttempt({
          batchId,
          slotNo: slot.slotNo as 1 | 2 | 3,
          result: { kind: 'infra', code: 'network' },
        });
      }
    }
  }
  const batch = await store.getBatch(batchId);
  console.log(JSON.stringify({
    batchId,
    machineState: batch?.state,
    next: 'independent reviewers submit asynchronously; then run gold:run decide',
  }));
}

async function submitReview(command: Extract<GoldCommand, { kind: 'review' }>): Promise<void> {
  const token = nonBlank(process.env.GOLD_REVIEWER_JWT, 'GOLD_REVIEWER_JWT');
  const reviewer = verifyToken(token);
  if (!reviewer) throw new Error('GOLD_REVIEWER_JWT is invalid');
  const { service } = goldService(reviewer.userId);
  await service.submitReview({
    batchId: command.batchId,
    attemptId: command.attemptId,
    reviewerId: reviewer.userId,
    verdict: command.verdict,
  });
  console.log(JSON.stringify({
    batchId: command.batchId,
    attemptId: command.attemptId,
    reviewerId: reviewer.userId,
    verdict: command.verdict,
  }));
}

async function decide(command: Extract<GoldCommand, { kind: 'decide' }>): Promise<void> {
  const decision = await goldService().service.decide({ batchId: command.batchId });
  console.log(JSON.stringify({ batchId: command.batchId, decision }));
}

async function main(): Promise<void> {
  loadEnv();
  assertTrustedGoldEnabled();
  const command = parseGoldCommand(process.argv.slice(2));
  if (command.kind === 'collect') await collect(command);
  else if (command.kind === 'review') await submitReview(command);
  else await decide(command);
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(closePool);
}
