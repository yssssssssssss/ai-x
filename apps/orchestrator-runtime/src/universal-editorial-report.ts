import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { closePool, pool } from '../../../database/db.ts';
import { ControlPlaneRepository } from '../../../database/control-plane.ts';
import { ControlArtifactStore } from './control/artifact-store.ts';
import { createUniversalEditorialShowcasePipeline } from './universal-editorial-showcase-runtime.ts';
import { GatewayLLMClient } from './runtime/gateway-llm-client.ts';
import { ReceiptLLMClient } from './runtime/receipt-llm-client.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function runUniversalEditorialReportCli(
  args: readonly string[],
  writeStdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<0 | 1> {
  const values = args[0] === '--' ? args.slice(1) : [...args];
  if (
    process.env.EDITORIAL_SHOWCASE_MODE !== 'manual'
    || values.length !== 2
    || values[0] !== '--task-id'
    || !UUID.test(values[1] ?? '')
  ) {
    writeStderr('UNIVERSAL_SHOWCASE_ARGUMENT_INVALID');
    return 1;
  }

  try {
    const repository = new ControlPlaneRepository(pool);
    const workspaceRoot = process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';
    const artifacts = new ControlArtifactStore({
      root: join(workspaceRoot, 'current-control'),
      registry: repository,
    });
    const task = await repository.getTaskDetail(values[1]!);
    if (!task) {
      writeStderr('UNIVERSAL_SHOWCASE_TASK_INVALID');
      return 1;
    }
    let modelOptions: Parameters<typeof createUniversalEditorialShowcasePipeline>[0] = {
      repository,
      artifacts,
      workspaceRoot,
    };
    const expectedActualModel = process.env.LLM_EXPECTED_ACTUAL_MODEL?.trim();
    if (process.env.LLM_PROVIDER === 'gateway' && expectedActualModel) {
      try {
        const gateway = new GatewayLLMClient();
        modelOptions = {
          ...modelOptions,
          llm: new ReceiptLLMClient(gateway, repository),
          expectedActualModel,
          endpointUrl: `${process.env.LLM_GATEWAY_BASE_URL?.replace(/\/$/u, '') ?? ''}/chat/completions`,
        };
      } catch {
        // The Showcase pipeline deterministically falls back when Gateway configuration is unavailable.
      }
    }
    const result = await createUniversalEditorialShowcasePipeline(modelOptions).generate({ taskId: values[1]! });
    writeStdout(JSON.stringify(result));
    return 0;
  } catch {
    writeStderr('UNIVERSAL_SHOWCASE_GENERATION_FAILED');
    return 1;
  } finally {
    await closePool();
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void runUniversalEditorialReportCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
