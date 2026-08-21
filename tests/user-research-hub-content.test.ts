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
  HUB_CONTENT_REPORT_PATH,
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

test('owner-waived content apply is deterministic, governed, and never overwrites canonical active content', {
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
      candidate_files: 32,
      knowledge_methods: 15,
      scenarios: 15,
      assets: 1,
      draft_skills: 1,
    });
    assert.deepEqual(first.report.merge_drafts, {
      files: 2,
      skill_files: 2,
      knowledge_files: 0,
    });
    assert.equal(first.report.mapped_existing.knowledge_entries, 117);
    assert.equal(first.report.governance.scanned_entities, 34);
    assert.equal(first.report.governance.blocked_entities, 0);
    assert.equal(first.report.governance.gate_2_review_required, false);
    assert.equal(first.report.gate_1_reuse_scope, 'production-owner-waiver');
    assert.equal(first.report.runtime_boundary.candidate_status, 'mixed');
    assert.equal(first.manifest.entities.filter(({ disposition, target }) => (
      disposition === 'import_candidate' && target?.status === 'approved'
    )).length, 31);
    assert.equal(first.manifest.entities.filter(({ disposition, target }) => (
      disposition === 'import_candidate' && target?.status === 'candidate'
    )).length, 1);
    assert.equal(first.report.comparisons.length, 137);
    assert.equal(first.files.size, 35, '32 candidates + 2 merge drafts + one report');
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
    assert.equal(firstWrite.written, 35);
    assert.equal(firstWrite.removed, 0);
    assert.deepEqual(checkAppliedHubContent(first, repositoryRoot), []);
    const firstOutputs = new Map([...first.files.keys()].map((path) => [
      path,
      readFileSync(join(repositoryRoot, path), 'utf8'),
    ]));

    const second = buildHubContentApply(first.manifest, SOURCE_ROOT, repositoryRoot, profileDraft);
    const secondWrite = writeHubContentApply(second, repositoryRoot);
    assert.deepEqual(secondWrite, { written: 0, unchanged: 35, removed: 0 });
    assert.equal(second.report.output_set_hash, first.report.output_set_hash);
    assert.deepEqual(checkAppliedHubContent(second, repositoryRoot), []);
    for (const [path, value] of firstOutputs) assert.equal(readFileSync(join(repositoryRoot, path), 'utf8'), value, path);

    const stalePath = 'knowledge-base/assets/templates/stale-hub-candidate.md';
    write(join(repositoryRoot, stalePath), [
      '---',
      'id: stale-hub-candidate',
      'type: asset',
      'title: stale',
      'status: candidate',
      'managed_by: user-research-hub-integration-v1',
      '---',
      '',
      '# stale',
      '',
    ].join('\n'));
    const previousReportPath = join(repositoryRoot, HUB_CONTENT_REPORT_PATH);
    const previousReport = JSON.parse(readFileSync(previousReportPath, 'utf8')) as { outputs: Array<{ path: string }> };
    previousReport.outputs.push({ path: stalePath });
    writeFileSync(previousReportPath, `${JSON.stringify(previousReport, null, 2)}\n`);
    const cleanupWrite = writeHubContentApply(second, repositoryRoot);
    assert.deepEqual(cleanupWrite, { written: 1, unchanged: 34, removed: 1 });
    assert.equal(existsSync(join(repositoryRoot, stalePath)), false);
    assert.deepEqual(checkAppliedHubContent(second, repositoryRoot), []);

    const candidateOutputs = second.report.outputs.filter(({ kind }) => kind === 'candidate');
    assert.ok(candidateOutputs.every(({ path }) => !path.includes('00-source-sync')));
    assert.ok(candidateOutputs.every(({ path }) => !path.startsWith('wiki/')));
    assert.ok([...second.files.values()].every((value) => !/\[LOCAL_HOME\]\/|\/Users\//u.test(value)));
    assert.deepEqual(governedSourceHashes(manifest), sourceBefore, 'apply must not mutate the Hub source');
    assert.ok(second.manifest.entities.filter(({ disposition }) => (
      disposition === 'import_candidate' || disposition === 'merge_into_existing'
    )).every(({ governance }) => (
      governance?.review_status === 'complete'
      && governance.scans.secrets === 'clear'
      && governance.scans.pii === 'clear'
      && (governance.scans.internal_business_facts === 'clear'
        || governance.scans.internal_business_facts === 'reviewed')
    )));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
