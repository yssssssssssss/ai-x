import { isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

import { closePool, pool } from '../../../database/db.ts';
import { ControlPlaneRepository } from '../../../database/control-plane.ts';
import type { MigrationDatabase } from '../../../database/migration-runner.ts';
import { ControlArtifactStore } from './control/artifact-store.ts';
import {
  EditorialContractError,
  NO_EDITORIAL_MODEL_PORT,
  canonicalEditorialJson,
  canonicalSha256,
  parseEditorialGatewayConfiguration,
  type EditorialArtifactReader,
  type EditorialGatewayConfiguration,
  type EditorialModelPort,
  type EditorialStructuredModelClient,
  type EditorialTaskReader,
} from './report/editorial-report-contract.ts';
import { EditorialMaterializationError } from './report/editorial-report-materializer.ts';
import {
  EditorialPipelineError,
  EditorialReportPipeline,
  type EditorialReportGenerationResult,
} from './report/editorial-report-pipeline.ts';
import { EditorialRendererError } from './report/editorial-report-renderer.ts';
import { EditorialSourceError, EditorialSourceReader } from './report/editorial-report-source-reader.ts';
import { EditorialReportStore, EditorialStoreError } from './report/editorial-report-store.ts';
import { GatewayLLMClient } from './runtime/gateway-llm-client.ts';
import { GatewayConfigurationError } from './runtime/llm-client.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const GENERIC_FAILURE_CODE = 'EDITORIAL_REPORT_FAILED';
const USAGE_FAILURE_CODE = 'EDITORIAL_CLI_ARGUMENT_INVALID';

export interface EditorialReportCommand {
  taskId: string;
}

export interface EditorialReportCliPipeline {
  generate(input: { taskId: string }): Promise<EditorialReportGenerationResult>;
}

export interface EditorialReportCliDependencies {
  createPipeline?: () => EditorialReportCliPipeline;
  close?: () => Promise<void>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export interface Phase1EditorialPipelineOptions {
  database?: MigrationDatabase;
  workspaceRoot?: string;
}

export interface EditorialModelPortFactoryOptions {
  provider?: string;
  createGatewayClient?: () => EditorialStructuredModelClient;
}

export class EditorialReportCliError extends Error {
  readonly name = 'EditorialReportCliError';

  constructor(readonly code: typeof USAGE_FAILURE_CODE) {
    super(code);
  }
}

export function parseEditorialReportArgs(args: readonly string[]): EditorialReportCommand {
  const commandArgs = args[0] === '--' ? args.slice(1) : args;
  if (
    commandArgs.length !== 2
    || commandArgs[0] !== '--task-id'
    || !UUID_PATTERN.test(commandArgs[1] ?? '')
  ) {
    throw new EditorialReportCliError(USAGE_FAILURE_CODE);
  }
  return { taskId: commandArgs[1]! };
}

const EDITORIAL_LLM_LIMITS = Object.freeze({
  overallTimeoutMs: 90_000,
  maxHttpAttempts: 3,
  maxRetryAfterMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxOutputTokens: 8_000,
} as const);

function isNormalizableGatewayConfigurationError(error: unknown): error is GatewayConfigurationError {
  if (!(error instanceof GatewayConfigurationError)) return false;
  switch (error.code) {
    case 'PROVIDER_UNCONFIGURED':
    case 'GATEWAY_BASE_URL_MISSING':
    case 'GATEWAY_API_KEY_MISSING':
    case 'GATEWAY_ENDPOINT_INVALID':
    case 'GATEWAY_ROUTE_INVALID':
    case 'GATEWAY_ACTUAL_MODEL_PIN_MISSING':
      return true;
  }
}

function freezeEditorialGatewayConfiguration(
  configuration: EditorialGatewayConfiguration,
): EditorialGatewayConfiguration {
  Object.freeze(configuration.limits);
  configuration.routes.forEach(Object.freeze);
  Object.freeze(configuration.routes);
  return Object.freeze(configuration);
}

export function createEditorialModelPort(
  options: EditorialModelPortFactoryOptions = {},
): EditorialModelPort {
  try {
    const provider = options.provider ?? process.env.LLM_PROVIDER;
    if (provider !== 'gateway') {
      throw new GatewayConfigurationError('PROVIDER_UNCONFIGURED', 'Editorial Gateway provider is not configured');
    }
    const client = options.createGatewayClient?.() ?? new GatewayLLMClient();
    const identity = client.configurationIdentity;
    if (identity.routes.length === 0 || identity.routes.length > 16) {
      throw new GatewayConfigurationError('GATEWAY_ROUTE_INVALID', 'Editorial Gateway route count is invalid');
    }
    if (identity.routes.some(({ expectedActualModelExplicit }) => expectedActualModelExplicit !== true)) {
      throw new GatewayConfigurationError(
        'GATEWAY_ACTUAL_MODEL_PIN_MISSING',
        'Editorial Gateway requires an explicit actual-model pin for every route',
      );
    }
    if (identity.routes.some(({ expectedActualModel }) => expectedActualModel.trim().toLowerCase() === 'unknown')) {
      throw new GatewayConfigurationError(
        'GATEWAY_ROUTE_INVALID',
        'Editorial Gateway actual-model pin must not be unknown',
      );
    }
    const body = {
      provider: identity.provider,
      endpointHost: identity.endpointHost,
      endpointUrl: identity.endpointUrl,
      mode: identity.mode,
      eligibleAsReal: identity.eligibleAsReal,
      redirectMode: 'error' as const,
      routes: identity.routes.map(({ requestedModel, expectedActualModel }) => ({
        requestedModel,
        expectedActualModel,
        expectedActualModelExplicit: true as const,
      })),
      limits: EDITORIAL_LLM_LIMITS,
    };
    const configurationCandidate = {
      ...body,
      gatewayConfigurationHash: canonicalSha256(body),
    };
    if (Buffer.byteLength(canonicalEditorialJson(configurationCandidate), 'utf8') > 16 * 1024) {
      throw new GatewayConfigurationError('GATEWAY_ROUTE_INVALID', 'Editorial Gateway configuration exceeds 16 KiB');
    }
    const configuration = freezeEditorialGatewayConfiguration(
      parseEditorialGatewayConfiguration(configurationCandidate),
    );
    return Object.freeze({ client, configuration });
  } catch (error) {
    if (isNormalizableGatewayConfigurationError(error)) return NO_EDITORIAL_MODEL_PORT;
    throw error;
  }
}

function createEditorialReportPipelineWithPort(
  modelPort: EditorialModelPort,
  options: Phase1EditorialPipelineOptions,
): EditorialReportPipeline {
  const repository = new ControlPlaneRepository(options.database ?? pool);
  const workspaceRoot = options.workspaceRoot ?? process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';
  const canonicalArtifacts = new ControlArtifactStore({
    root: join(workspaceRoot, 'current-control'),
    registry: repository,
  });

  const tasks: EditorialTaskReader = Object.freeze({
    getTaskDetail: (taskId) => repository.getTaskDetail(taskId),
    getArtifact: (artifactId) => repository.getArtifact(artifactId),
    findSealedArtifact: (input) => repository.findSealedArtifact(input),
  });
  const artifacts: EditorialArtifactReader = Object.freeze({
    readVerifiedJson: <T>(artifactId: string) => canonicalArtifacts.readVerifiedJson<T>(artifactId),
    readVerifiedBoundJson: <T>(artifactId: string) => canonicalArtifacts.readVerifiedBoundJson<T>(artifactId),
    readVerifiedBinary: (artifactId) => canonicalArtifacts.readVerifiedBinary(artifactId),
  });
  const source = new EditorialSourceReader({ tasks, artifacts });
  const store = new EditorialReportStore({ root: join(workspaceRoot, 'editorial-reports') });

  return new EditorialReportPipeline({
    source,
    store,
    modelPort,
    writeAuditLine: (line) => { process.stderr.write(`${line}\n`); },
  });
}

export function createPhase1EditorialReportPipeline(
  options: Phase1EditorialPipelineOptions = {},
): EditorialReportPipeline {
  return createEditorialReportPipelineWithPort(NO_EDITORIAL_MODEL_PORT, options);
}

export function createEditorialReportPipeline(
  options: Phase1EditorialPipelineOptions = {},
): EditorialReportPipeline {
  return createEditorialReportPipelineWithPort(createEditorialModelPort(), options);
}

function knownFailureCode(error: unknown): string {
  const known = error instanceof EditorialReportCliError
    || error instanceof EditorialSourceError
    || error instanceof EditorialContractError
    || error instanceof EditorialMaterializationError
    || error instanceof EditorialRendererError
    || error instanceof EditorialStoreError
    || error instanceof EditorialPipelineError;
  if (!known || !SAFE_ERROR_CODE_PATTERN.test(error.code)) return GENERIC_FAILURE_CODE;
  return error.code;
}

function safeDiagnosticPath(error: unknown): string | undefined {
  if (!(error instanceof EditorialPipelineError)) return undefined;
  const candidate = error.diagnosticPath;
  if (
    candidate === undefined
    || !isAbsolute(candidate)
    || normalize(candidate) !== candidate
    || Buffer.byteLength(candidate, 'utf8') > 4_096
    || /[\u0000\r\n]/u.test(candidate)
  ) return undefined;
  return candidate;
}

function failureOutput(error: unknown): string {
  const code = knownFailureCode(error);
  const diagnosticPath = safeDiagnosticPath(error);
  return diagnosticPath === undefined
    ? code
    : JSON.stringify({ code, diagnosticPath });
}

export async function runEditorialReportCli(
  args: readonly string[],
  dependencies: EditorialReportCliDependencies = {},
): Promise<0 | 1> {
  const createPipeline = dependencies.createPipeline ?? createEditorialReportPipeline;
  const close = dependencies.close ?? closePool;
  const writeStdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let result: EditorialReportGenerationResult | undefined;
  let failure: string | undefined;

  try {
    const command = parseEditorialReportArgs(args);
    result = await createPipeline().generate(command);
  } catch (error) {
    failure = failureOutput(error);
  } finally {
    try {
      await close();
    } catch {
      failure ??= GENERIC_FAILURE_CODE;
      result = undefined;
    }
  }

  if (failure !== undefined || result === undefined) {
    writeStderr(failure ?? GENERIC_FAILURE_CODE);
    return 1;
  }
  writeStdout(JSON.stringify(result));
  return 0;
}

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void runEditorialReportCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
