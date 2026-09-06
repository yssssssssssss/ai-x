import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  DockerSandboxExecutor,
  type SandboxProcessRunner,
} from '../apps/orchestrator-runtime/src/skill-native/sandbox-executor.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('Docker sandbox requires a digest-pinned image', () => {
  assert.equal(new DockerSandboxExecutor({ image: 'skill-runtime:latest' }).status().available, false);
  assert.equal(new DockerSandboxExecutor({ image: `skill-runtime@sha256:${'a'.repeat(64)}` }).status().available, true);
});

test('Docker sandbox runs with no network, no capabilities, read-only mounts, and bounded outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-sandbox-'));
  roots.push(root);
  const packageRoot = join(root, 'package');
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  writeFileSync(join(packageRoot, 'scripts', 'render.py'), 'print("render")\n');
  let observedArgs: string[] = [];
  const runner: SandboxProcessRunner = async (command, args) => {
    assert.equal(command, 'docker');
    observedArgs = args;
    const outputMount = args.find((value) => value.includes('dst=/outputs'))!;
    const outputRoot = /src=([^,]+),dst=\/outputs/u.exec(outputMount)?.[1];
    assert.ok(outputRoot);
    writeFileSync(join(outputRoot, 'result.html'), '<!doctype html><p>result</p>');
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const sandbox = new DockerSandboxExecutor({
    image: `skill-runtime@sha256:${'a'.repeat(64)}`,
    workspaceRoot: join(root, 'workspace'),
    runner,
  });
  const result = await sandbox.execute({
    packageRoot,
    scriptPath: 'scripts/render.py',
    runtime: 'python',
    arguments: ['/outputs/result.html'],
    inputs: [],
    outputs: ['result.html'],
    readonlyMounts: [],
    signal: new AbortController().signal,
  });

  assert.ok(observedArgs.includes('none'));
  assert.ok(observedArgs.includes('--read-only'));
  assert.ok(observedArgs.includes('ALL'));
  assert.ok(observedArgs.includes('no-new-privileges'));
  assert.equal(result.outputs[0]?.bytes.toString(), '<!doctype html><p>result</p>');
});

test('Docker sandbox removes the named container with a fresh signal after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-sandbox-cancel-'));
  roots.push(root);
  const packageRoot = join(root, 'package');
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  writeFileSync(join(packageRoot, 'scripts', 'render.py'), 'print("render")\n');
  const calls: Array<{ args: string[]; aborted: boolean }> = [];
  const runner: SandboxProcessRunner = async (_command, args, options) => {
    calls.push({ args, aborted: options.signal.aborted });
    if (args[0] === 'run') throw new Error('sandbox execution cancelled');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const sandbox = new DockerSandboxExecutor({
    image: `skill-runtime@sha256:${'a'.repeat(64)}`,
    workspaceRoot: join(root, 'workspace'),
    runner,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(sandbox.execute({
    packageRoot,
    scriptPath: 'scripts/render.py',
    runtime: 'python',
    arguments: [],
    inputs: [],
    outputs: [],
    readonlyMounts: [],
    signal: controller.signal,
  }), /sandbox execution cancelled/u);

  const run = calls[0]!;
  const name = run.args[run.args.indexOf('--name') + 1];
  assert.match(name ?? '', /^skill-native-[0-9a-f-]+$/u);
  assert.equal(run.aborted, true);
  assert.deepEqual(calls[1], { args: ['rm', '-f', name], aborted: false });
});
