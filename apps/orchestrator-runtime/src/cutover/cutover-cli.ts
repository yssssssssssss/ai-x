import { CutoverService } from './cutover-service.ts';
import { evidenceFromOperatorInput, loadCutoverOperatorInput } from './cutover-input.ts';
import { runCutoverHttpSmoke } from './cutover-smoke.ts';

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function requireFlag(args: string[], flag: string): string {
  const value = flagValue(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function prepare(args: string[]): Promise<void> {
  const input = loadCutoverOperatorInput(requireFlag(args, '--input'));
  const smokeBaseUrl = flagValue(args, '--smoke-base-url');
  if (smokeBaseUrl) {
    const smoke = await runCutoverHttpSmoke({
      baseUrl: smokeBaseUrl,
      bearerToken: requireFlag(args, '--smoke-token'),
      taskId: requireFlag(args, '--smoke-task-id'),
    });
    input.readOnlySmoke.legacyMutation410 = smoke.legacyMutation410;
    input.readOnlySmoke.oldRoutesAbsent = smoke.oldRoute404;
  }

  const result = new CutoverService({ auditRoot: requireFlag(args, '--audit-root') }).prepareGoLive(evidenceFromOperatorInput(input));
  console.log(`decision=${result.decision}`);
  console.log(`directory=${result.directory}`);
  console.log(`rollback=${result.rollback.mode}`);
  console.log(`legacyWriterAllowed=${String(result.legacyWriterAllowed)}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') {
    await prepare(args);
    return;
  }
  throw new Error('usage: cutover-cli.ts prepare|verify ...');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
