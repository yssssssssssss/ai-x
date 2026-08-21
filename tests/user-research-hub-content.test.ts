import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

import {
  buildHubContentApply,
  checkAppliedHubContent,
  writeHubContentApply,
} from '../scripts/user-research-hub-content.ts';
import type { HubManifest, ProfileDraft } from '../scripts/user-research-hub-integration.ts';

const REPOSITORY_ROOT = process.cwd();
const SOURCE_ROOT = process.env.USER_RESEARCH_HUB_SOURCE
  ?? join(REPOSITORY_ROOT, 'wiki/user-research');
const MANIFEST_PATH = join(REPOSITORY_ROOT, 'knowledge-base/.sources/user-research-hub-2026-08-21.yaml');
const PROFILE_PATH = join(REPOSITORY_ROOT, 'knowledge-base/.sources/user-research-hub-profile-draft-2026-08-21.yaml');

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function prepareCanonicalTargets(manifest: HubManifest, repositoryRoot: string): void {
  for (const entity of manifest.entities.filter(({ disposition }) => (
    disposition === 'map_existing' || disposition === 'merge_into_existing'
  ))) {
    assert.ok(entity.target);
    const source = join(REPOSITORY_ROOT, entity.target.path);
    if (statSync(source).isDirectory()) {
      const entry = join(source, 'SKILL.md');
      write(join(repositoryRoot, entity.target.path, 'SKILL.md'), readFileSync(entry, 'utf8'));
    } else {
      write(join(repositoryRoot, entity.target.path), readFileSync(source, 'utf8'));
    }
  }
}

function governedSourceHashes(manifest: HubManifest): Map<string, string> {
  const governed = new Set(manifest.entities.filter(({ disposition }) => (
    disposition === 'import_candidate' || disposition === 'merge_into_existing'
  )).map(({ source_path }) => source_path));
  return new Map([...governed].map((sourcePath) => [
    sourcePath,
    readFileSync(join(SOURCE_ROOT, sourcePath)).toString('base64'),
  ]));
}

test('Phase-B content apply is deterministic, governed, and never overwrites canonical active content', {
  skip: !existsSync(SOURCE_ROOT),
}, () => {
  const manifest = YAML.parse(readFileSync(MANIFEST_PATH, 'utf8')) as HubManifest;
  const profileDraft = YAML.parse(readFileSync(PROFILE_PATH, 'utf8')) as ProfileDraft;
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'hub-content-apply-'));
  try {
    prepareCanonicalTargets(manifest, repositoryRoot);
    const sourceBefore = governedSourceHashes(manifest);
    const first = buildHubContentApply(manifest, SOURCE_ROOT, repositoryRoot, profileDraft);

    assert.deepEqual(first.report.materialized, {
      candidate_files: 55,
      knowledge_methods: 24,
      scenarios: 15,
      assets: 14,
      draft_skills: 2,
    });
    assert.deepEqual(first.report.merge_drafts, {
      files: 22,
      skill_files: 22,
      knowledge_files: 0,
    });
    assert.equal(first.report.mapped_existing.knowledge_entries, 104);
    assert.equal(first.report.governance.scanned_entities, 77);
    assert.equal(first.report.governance.blocked_entities, 0);
    assert.equal(first.report.comparisons.length, 126);
    assert.equal(first.files.size, 78, '55 candidates + 22 merge drafts + one report');
    assert.equal(first.report.runtime_boundary.source_only_materialized, 0);
    assert.equal(first.report.runtime_boundary.reject_runtime_materialized, 0);
    assert.equal(first.report.runtime_boundary.opaque_materialized, 0);

    const collisionPath = first.report.outputs.find(({ kind }) => kind === 'candidate')!.path;
    write(join(repositoryRoot, collisionPath), '# unmanaged\n');
    assert.throws(
      () => writeHubContentApply(first, repositoryRoot),
      /refusing to overwrite an unmanaged canonical path/u,
    );
    rmSync(join(repositoryRoot, collisionPath));

    const firstWrite = writeHubContentApply(first, repositoryRoot);
    assert.equal(firstWrite.written, 78);
    assert.deepEqual(checkAppliedHubContent(first, repositoryRoot), []);
    const firstOutputs = new Map([...first.files.keys()].map((path) => [
      path,
      readFileSync(join(repositoryRoot, path), 'utf8'),
    ]));

    const second = buildHubContentApply(first.manifest, SOURCE_ROOT, repositoryRoot, profileDraft);
    const secondWrite = writeHubContentApply(second, repositoryRoot);
    assert.deepEqual(secondWrite, { written: 0, unchanged: 78 });
    assert.equal(second.report.output_set_hash, first.report.output_set_hash);
    assert.deepEqual(checkAppliedHubContent(second, repositoryRoot), []);
    for (const [path, value] of firstOutputs) assert.equal(readFileSync(join(repositoryRoot, path), 'utf8'), value, path);

    const candidateOutputs = second.report.outputs.filter(({ kind }) => kind === 'candidate');
    assert.ok(candidateOutputs.every(({ path }) => !path.includes('00-source-sync')));
    assert.ok(candidateOutputs.every(({ path }) => !path.startsWith('wiki/')));
    assert.ok([...second.files.values()].every((value) => !/\[LOCAL_HOME\]\/|\/Users\//u.test(value)));
    assert.deepEqual(governedSourceHashes(manifest), sourceBefore, 'apply must not mutate the Hub source');
    assert.ok(second.manifest.entities.filter(({ disposition }) => (
      disposition === 'import_candidate' || disposition === 'merge_into_existing'
    )).every(({ governance }) => (
      governance?.review_status === 'review_required'
      && governance.scans.secrets === 'clear'
      && governance.scans.pii === 'clear'
    )));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
