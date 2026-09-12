import { join } from 'node:path';

import type { ControlPlaneRepository } from '../../../database/control-plane.ts';
import type { ControlArtifactStore } from './control/artifact-store.ts';
import {
  NO_EDITORIAL_MODEL_PORT,
  canonicalSha256,
  evaluateEditorialModelEgress,
  type EditorialArtifactReader,
  type EditorialGatewayConfiguration,
  type EditorialModelPort,
  type EditorialTaskReader,
} from './report/editorial-report-contract.ts';
import { EditorialSourceReader } from './report/editorial-report-source-reader.ts';
import { REPORT_PACKAGE_SCHEMA_VERSION } from './report/report-package-artifact.ts';
import { EditorialShowcasePipeline } from './report/editorial-showcase-pipeline.ts';
import { EditorialShowcasePlanner } from './report/editorial-showcase-planner.ts';
import { EditorialShowcaseStore } from './report/editorial-showcase-store.ts';
import type { LLMClient, LLMResult } from './runtime/llm-client.ts';

const SHOWCASE_LIMITS = Object.freeze({
  overallTimeoutMs: 90_000,
  maxHttpAttempts: 3,
  maxRetryAfterMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxOutputTokens: 8_000,
} as const);

export function universalEditorialModelPort(input: {
  llm?: LLMClient;
  expectedActualModel?: string;
  endpointUrl?: string;
}): EditorialModelPort {
  const llm = input.llm;
  const expectedActualModel = input.expectedActualModel?.trim();
  const endpointUrl = input.endpointUrl?.trim();
  if (
    !llm
    || !expectedActualModel
    || !endpointUrl
    || llm.identity.provider !== 'gateway'
    || llm.identity.mode !== 'real'
    || llm.identity.eligibleAsReal !== true
  ) return NO_EDITORIAL_MODEL_PORT;

  const body = {
    provider: llm.identity.provider,
    endpointHost: llm.identity.endpointHost,
    endpointUrl,
    mode: llm.identity.mode,
    eligibleAsReal: llm.identity.eligibleAsReal,
    redirectMode: 'error' as const,
    routes: [{
      requestedModel: llm.identity.requestedModel,
      expectedActualModel,
      expectedActualModelExplicit: true as const,
    }],
    limits: SHOWCASE_LIMITS,
  };
  const configuration: EditorialGatewayConfiguration = Object.freeze({
    ...body,
    gatewayConfigurationHash: canonicalSha256(body),
  });
  const client = {
    configurationIdentity: {
      provider: body.provider,
      endpointHost: body.endpointHost,
      endpointUrl: body.endpointUrl,
      mode: body.mode,
      eligibleAsReal: body.eligibleAsReal,
      routes: body.routes,
    },
    async generateStructured<T>(options: {
      prompt: string;
      systemPrompt: string;
      schema: object;
      schemaName: string;
      context: object;
    }): Promise<Omit<LLMResult<T>, 'receiptId'>> {
      return llm.generateStructured<T>({
        prompt: `${options.systemPrompt}\n\n${options.prompt}`,
        schema: options.schema,
        schemaName: options.schemaName,
        context: options.context,
        receipt: {
          stage: 'editorial_showcase_intent',
          contextManifestHash: canonicalSha256(options.context),
          expectedModel: expectedActualModel,
        },
      });
    },
  };
  return { client, configuration } as unknown as EditorialModelPort;
}

export function createUniversalEditorialShowcasePipeline(input: {
  repository: ControlPlaneRepository;
  artifacts: ControlArtifactStore;
  workspaceRoot: string;
  modelPort?: EditorialModelPort;
  llm?: LLMClient;
  expectedActualModel?: string;
  endpointUrl?: string;
}): EditorialShowcasePipeline {
  const tasks: EditorialTaskReader = Object.freeze({
    getTaskDetail: (taskId) => input.repository.getTaskDetail(taskId),
    getArtifact: (artifactId) => input.repository.getArtifact(artifactId),
    async findSealedArtifact(query) {
      const task = await input.repository.getTaskDetail(query.taskId);
      if (!task?.activePlanVersionId) return null;
      const candidates = await input.repository.listArtifactsForAttempt({
        taskId: query.taskId,
        planVersionId: task.activePlanVersionId,
        attemptId: query.attemptId,
        kinds: [query.kind],
      });
      const current = candidates.reverse();
      return current.find((artifact) => artifact.state === 'SEALED' && artifact.schemaVersion === 'report-package-v2')
        ?? current.find((artifact) => artifact.state === 'SEALED' && artifact.schemaVersion === REPORT_PACKAGE_SCHEMA_VERSION)
        ?? null;
    },
  });
  const artifactReader: EditorialArtifactReader = Object.freeze({
    readVerifiedJson: <T>(artifactId: string) => input.artifacts.readVerifiedJson<T>(artifactId),
    readVerifiedBoundJson: <T>(artifactId: string) => input.artifacts.readVerifiedBoundJson<T>(artifactId),
    readVerifiedBoundText: (artifactId: string) => input.artifacts.readVerifiedBoundText(artifactId),
    readVerifiedBinary: (artifactId) => input.artifacts.readVerifiedBinary(artifactId),
  });
  const source = new EditorialSourceReader({ tasks, artifacts: artifactReader });
  const modelPort = input.modelPort ?? universalEditorialModelPort({
    llm: input.llm,
    expectedActualModel: input.expectedActualModel,
    endpointUrl: input.endpointUrl,
  });
  const root = join(input.workspaceRoot, 'universal-editorial-reports');
  const showcaseStore = new EditorialShowcaseStore(root);

  return new EditorialShowcasePipeline({
    source,
    planner: new EditorialShowcasePlanner({ modelPort }),
    store: showcaseStore,
    lockStore: showcaseStore,
    modelAllowed: (materialization) => evaluateEditorialModelEgress({
      sourcePolicyMetadata: materialization.sourcePolicyMetadata,
      modelPort,
    }).decision === 'allow',
  });
}
