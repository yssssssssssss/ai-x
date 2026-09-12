import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { canonicalJsonBytes } from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  runEditorialShowcaseOfflineCli,
} from '../apps/orchestrator-runtime/src/universal-editorial-showcase.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test('offline Showcase CLI atomically writes a deterministic no-model bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'editorial-showcase-cli-'));
  roots.push(root);
  const materialPath = join(root, 'material.json');
  const outputDir = join(root, 'showcase');
  await writeFile(materialPath, canonicalJsonBytes(showcaseFixture().material));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exit = await runEditorialShowcaseOfflineCli([
    '--material-path', materialPath,
    '--output-dir', outputDir,
  ], {
    enabled: true,
    now: () => new Date('2026-08-30T00:00:00.000Z'),
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exit, 0);
  assert.deepEqual(stderr, []);
  const result = JSON.parse(stdout[0]!) as { status: string; generationMode: string; reportPath: string; manifestPath: string };
  assert.equal(result.status, 'ready');
  assert.equal(result.generationMode, 'deterministic_showcase');
  assert.equal(result.reportPath, join(outputDir, 'editorial-showcase.html'));
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(result.reportPath)).mode & 0o777, 0o600);

  const manifest = JSON.parse((await readFile(result.manifestPath)).toString('utf8')) as Record<string, unknown>;
  assert.equal(manifest.version, 'editorial-showcase-offline-v1');
  assert.equal(manifest.generationMode, 'deterministic_showcase');
  assert.equal(manifest.generatedAt, '2026-08-30T00:00:00.000Z');
  assert.match(String(manifest.htmlHash), /^sha256:[a-f0-9]{64}$/u);
  assert.ok((await readFile(result.reportPath, 'utf8')).startsWith('<!doctype html>'));
});

test('offline Showcase CLI is disabled unless manual mode is explicit', async () => {
  const stderr: string[] = [];
  const exit = await runEditorialShowcaseOfflineCli([], {
    enabled: false,
    writeStdout: () => undefined,
    writeStderr: (line) => stderr.push(line),
  });
  assert.equal(exit, 1);
  assert.deepEqual(stderr, ['SHOWCASE_CLI_ARGUMENT_INVALID']);
});
