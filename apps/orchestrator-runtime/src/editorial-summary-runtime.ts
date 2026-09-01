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
import { EditorialSummaryGenerator } from './report/editorial-summary-generator.ts';
import { EditorialSummaryPipeline } from './report/editorial-summary-pipeline.ts';
import { EditorialSummaryStore } from './report/editorial-summary-store.ts';
import type { LLMClient, LLMResult } from './runtime/llm-client.ts';

const SUMMARY_EGRESS_LIMITS = Object.freeze({
  overallTimeoutMs: 90_000,
  maxHttpAttempts: 3,
  maxRetryAfterMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxOutputTokens: 8_000,
} as const);

export function editorialSummaryModelPort(input: {
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
    limits: SUMMARY_EGRESS_LIMITS,
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
          stage: 'editorial_summary_policy_probe',
          contextManifestHash: canonicalSha256(options.context),
          expectedModel: expectedActualModel,
        },
      });
    },
  };
  return { client, configuration } as unknown as EditorialModelPort;
}

export function createEditorialSummaryPipeline(input: {
  repository: ControlPlaneRepository;
  artifacts: ControlArtifactStore;
  workspaceRoot: string;
  llm: LLMClient;
  expectedActualModel: string;
  endpointUrl?: string;
}): EditorialSummaryPipeline {
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
  const modelPort = editorialSummaryModelPort(input);
  const store = new EditorialSummaryStore(join(input.workspaceRoot, 'editorial-summary-reports'));
  const generationIdentity = canonicalSha256({
    pipeline: 'editorial-summary-v1',
    routing: 'gateway-model-pool',
    provider: input.llm.identity.provider,
    endpointHost: input.llm.identity.endpointHost,
    requestedModel: input.llm.identity.requestedModel,
    expectedActualModel: input.expectedActualModel,
    gatewayConfigurationHash: modelPort.configuration?.gatewayConfigurationHash ?? null,
  });
  return new EditorialSummaryPipeline({
    source,
    generator: new EditorialSummaryGenerator({
      llm: input.llm,
      expectedActualModel: input.expectedActualModel,
    }),
    store,
    lockStore: store,
    generationIdentity,
    modelAllowed: (materialization) => evaluateEditorialModelEgress({
      sourcePolicyMetadata: materialization.sourcePolicyMetadata,
      modelPort,
    }).decision === 'allow',
  });
}
