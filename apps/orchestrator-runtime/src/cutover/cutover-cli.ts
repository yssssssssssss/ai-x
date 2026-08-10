import { CutoverService } from './cutover-service.ts';
import { evidenceFromOperatorInput, loadCutoverOperatorInput } from './cutover-input.ts';
import { runCutoverHttpSmoke } from './cutover-smoke.ts';
import { runLocalRehearsal, verifyLocalRehearsal } from './cutover-rehearsal.ts';

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

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is required`);
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

function verify(args: string[]): void {
  const manifest = new CutoverService({ auditRoot: '.' }).verifyGoLivePackage(requireFlag(args, '--directory'));
  console.log('verified=true');
  console.log(`releaseId=${manifest.evidence.release.releaseId}`);
  console.log(`rollback=${manifest.rollback.mode}`);
  console.log(`legacyWriterAllowed=${String(manifest.legacyWriterAllowed)}`);
}

async function rehearse(args: string[]): Promise<void> {
  const databaseUrl = requireEnvironment(requireFlag(args, '--database-url-env'));
  const bearerToken = requireEnvironment(requireFlag(args, '--smoke-token-env'));
  const result = await runLocalRehearsal({
    releaseId: requireFlag(args, '--release-id'),
    commit: requireFlag(args, '--commit'),
    baseUrl: requireFlag(args, '--base-url'),
    bearerToken,
    smokeTaskId: requireFlag(args, '--smoke-task-id'),
    databaseUrl,
    workspaceRoot: requireFlag(args, '--workspace-root'),
    auditRoot: requireFlag(args, '--audit-root'),
    outputRoot: requireFlag(args, '--output-root'),
  });
  console.log(`directory=${result.directory}`);
  console.log(`environment=${result.manifest.environment}`);
  console.log(`goLiveEligible=${String(result.manifest.goLiveEligible)}`);
  console.log(`notProductionEvidence=${String(result.manifest.notProductionEvidence)}`);
  console.log(`notGoldSlot=${String(result.manifest.notGoldSlot)}`);
}

function verifyRehearsal(args: string[]): void {
  const manifest = verifyLocalRehearsal(requireFlag(args, '--directory'));
  console.log('verified=true');
  console.log(`environment=${manifest.environment}`);
  console.log(`goLiveEligible=${String(manifest.goLiveEligible)}`);
  console.log(`notProductionEvidence=${String(manifest.notProductionEvidence)}`);
  console.log(`notGoldSlot=${String(manifest.notGoldSlot)}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') {
    await prepare(args);
    return;
  }
  if (command === 'verify') {
    verify(args);
    return;
  }
  if (command === 'rehearse') {
    await rehearse(args);
    return;
  }
  if (command === 'verify-rehearsal') {
    verifyRehearsal(args);
    return;
  }
  throw new Error('usage: cutover-cli.ts prepare|verify|rehearse|verify-rehearsal ...');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
