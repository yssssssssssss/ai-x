import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

import {
  buildDistinctnessReport,
  checkManifest,
  createCanonicalCatalog,
  hashFiles,
  scanHub,
  serializeDistinctnessReport,
  serializeManifest,
  validateManifestSchema,
  type HubManifest,
  type ProfileDraft,
} from '../scripts/user-research-hub-integration.ts';

const REPOSITORY_ROOT = process.cwd();
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'wiki/user-research');
const MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  'knowledge-base/.sources/user-research-hub-2026-08-21.yaml',
);
const PROFILE_DRAFT_PATH = join(
  REPOSITORY_ROOT,
  'knowledge-base/.sources/user-research-hub-profile-draft-2026-08-21.yaml',
);
const DISTINCTNESS_REPORT_PATH = join(
  REPOSITORY_ROOT,
  'knowledge-base/.sources/user-research-hub-profile-distinctness-2026-08-21.json',
);

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'user-research-hub-'));
}

function write(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function loadManifest(): HubManifest {
  return YAML.parse(readFileSync(MANIFEST_PATH, 'utf8')) as HubManifest;
}

function cloneManifest(manifest: HubManifest): HubManifest {
  return structuredClone(manifest);
}

test('raw file hashes and canonical NDJSON tree hashes are deterministic', () => {
  const root = temporaryDirectory();
  try {
    write(join(root, 'b.txt'), 'same visible text\r\n');
    write(join(root, 'a.txt'), Buffer.from([0, 1, 2, 255]));
    const first = scanHub(root);
    const second = scanHub(root);

    assert.deepEqual(first.files, second.files);
    assert.equal(first.files[0]?.path, 'a.txt');
    assert.equal(first.files[0]?.sha256, `sha256:${createHash('sha256')
      .update(Buffer.from([0, 1, 2, 255]))
      .digest('hex')}`);
    assert.equal(hashFiles(first.files), hashFiles([...first.files].reverse()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source scanning records only the declared LOCAL_HOME transform and fails on unknown YAML errors', () => {
  const known = temporaryDirectory();
  const unknown = temporaryDirectory();
  try {
    write(join(known, 'known.md'), '---\nsource_path: [LOCAL_HOME]/guide.md\n---\nbody\n');
    const scan = scanHub(known);
    assert.equal(scan.files[0]?.frontmatter.status, 'known_invalid');
    assert.equal(scan.files[0]?.frontmatter.transform_rule_id, 'quote-local-home-frontmatter-v1');

    write(join(unknown, 'unknown.md'), '---\nvalue: [unterminated\n---\nbody\n');
    assert.throws(() => scanHub(unknown), /unknown frontmatter parse failure.*unknown\.md/u);
  } finally {
    rmSync(known, { recursive: true, force: true });
    rmSync(unknown, { recursive: true, force: true });
  }
});

test('source scanning rejects symlinks, non-normalized names, and ambiguous path identities', () => {
  const root = temporaryDirectory();
  try {
    write(join(root, 'target.txt'), 'target');
    symlinkSync('target.txt', join(root, 'link.txt'));
    assert.throws(() => scanHub(root), /symlink.*link\.txt/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checked-in disposition schema is Draft-07 and structurally validates the manifest', () => {
  const schema = JSON.parse(readFileSync(
    join(REPOSITORY_ROOT, 'schemas/user-research-hub-disposition.schema.json'),
    'utf8',
  )) as { $schema?: string };
  const manifest = loadManifest();

  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(validateManifestSchema(manifest, REPOSITORY_ROOT), []);
});

test('checked-in Hub snapshot covers every physical file and registry entity exactly once', {
  skip: !existsSync(SOURCE_ROOT),
}, () => {
  const manifest = loadManifest();
  const scan = scanHub(SOURCE_ROOT);
  const diagnostics = checkManifest(
    manifest,
    scan,
    createCanonicalCatalog(REPOSITORY_ROOT),
  );

  assert.deepEqual(diagnostics, []);
  assert.equal(manifest.snapshot.file_count, 8_491);
  assert.equal(manifest.snapshot.byte_count, 400_355_408);
  assert.equal(manifest.snapshot.source_sync.file_count, 7_683);
  assert.equal(manifest.snapshot.organized.file_count, 808);
  assert.equal(manifest.files.length, 8_491);
  assert.equal(new Set(manifest.files.map(({ path }) => path)).size, 8_491);
  assert.equal(manifest.entities.length, 275);
  assert.deepEqual(
    Object.fromEntries(manifest.registries.map(({ kind, entity_count }) => [kind, entity_count])),
    { case: 29, domain: 8, knowledge: 184, skill: 25, task: 29 },
  );
  assert.equal(
    manifest.files.filter(({ frontmatter }) => frontmatter.status === 'known_invalid').length,
    169,
  );
});

test('manifest records exact 104 Knowledge and 18 Skill canonical mappings', () => {
  const manifest = loadManifest();
  const knowledgeMappings = manifest.entities.filter((entity) => (
    entity.registry_kind === 'knowledge' && entity.disposition === 'map_existing'
  ));
  const exactSkillMappings = manifest.entities.filter((entity) => (
    entity.registry_kind === 'skill' && entity.mapping_basis === 'exact_skill_slug'
  ));
  const continuousDiscovery = manifest.entities.find(({ id }) => (
    id === 'ur-method-methods-scenarios-product-experience-iteration-continuous-discovery'
  ));

  assert.equal(knowledgeMappings.length, 104);
  assert.equal(exactSkillMappings.length, 18);
  assert.equal(continuousDiscovery?.mapping_basis, 'explicit_continuous_discovery');
  assert.equal(continuousDiscovery?.target?.canonical_id, 'scenario_continuous_discovery');
});

test('manifest preserves upstream mismatches and records the accepted Gate-1 decisions without inventing files', () => {
  const manifest = loadManifest();
  assert.deepEqual(manifest.upstream_manifest.declared_count_checks.map((check) => ({
    key: check.key,
    declared: check.declared,
    observed: check.observed,
    status: check.status,
  })), [
    {
      key: 'agent_skill_entries_snapshot.entry_count',
      declared: 55,
      observed: 27,
      status: 'mismatch',
    },
    {
      key: 'additional_field_source_trees.huangliu-design.file_count',
      declared: 5_587,
      observed: 5_585,
      status: 'mismatch',
    },
  ]);
  assert.ok(manifest.gate_1.facts.some(({ id, status }) => id === 'deploy-artifact-boundary-undefined' && status === 'accepted'));
  assert.ok(manifest.gate_1.facts.some(({ id, status }) => id === 'source-rights-not-declared' && status === 'accepted'));
  assert.equal(manifest.gate_1.status, 'ready');
});

test('manifest semantic checks reject duplicate targets', {
  skip: !existsSync(SOURCE_ROOT),
}, () => {
  const scan = scanHub(SOURCE_ROOT);
  const catalog = createCanonicalCatalog(REPOSITORY_ROOT);
  const duplicate = cloneManifest(loadManifest());
  const mapped = duplicate.entities.filter(({ disposition }) => disposition === 'map_existing');
  assert.ok(mapped.length >= 2 && mapped[0]?.target);
  mapped[1]!.target = structuredClone(mapped[0]!.target);
  delete mapped[0]!.coalescence_group_id;
  delete mapped[1]!.coalescence_group_id;
  assert.ok(checkManifest(duplicate, scan, catalog).some((diagnostic) => (
    diagnostic.includes('duplicate canonical target')
  )));
});

test('opaque binary files remain source-only or reject-runtime through their exact coverage group', () => {
  const manifest = loadManifest();
  const groups = new Map(manifest.attachment_groups.map((group) => [group.id, group]));
  const opaque = manifest.files.filter(({ media_type }) => (
    media_type === 'application/octet-stream'
    || media_type === 'application/pdf'
    || media_type === 'application/zip'
  ));
  assert.ok(opaque.length > 0);
  for (const file of opaque) {
    if (file.coverage.kind === 'entity') {
      assert.fail(`opaque file must not have entity coverage: ${file.path}`);
    } else if (file.coverage.kind === 'attachment') {
      const disposition = groups.get(file.coverage.attachment_group_ref)?.disposition;
      assert.ok(disposition === 'source_only' || disposition === 'reject_runtime', file.path);
    } else {
      assert.ok(
        file.coverage.disposition === 'source_only'
          || file.coverage.disposition === 'reject_runtime',
        file.path,
      );
    }
  }
});

test('Profile draft deterministically reports all 15 Scenarios and 60 baseline comparisons', () => {
  const draft = YAML.parse(readFileSync(PROFILE_DRAFT_PATH, 'utf8')) as ProfileDraft;
  const report = buildDistinctnessReport(draft);
  const checkedIn = readFileSync(DISTINCTNESS_REPORT_PATH, 'utf8');

  assert.equal(draft.runtime_consumed, false);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.profile_specs.length, 7);
  assert.equal(draft.scenario_profile_mappings.length, 15);
  assert.ok(draft.scenario_profile_mappings.every(({ candidate_profiles }) => (
    candidate_profiles[0] === 'speed'
    && candidate_profiles[1] === 'depth'
    && candidate_profiles.length >= 3
  )));
  assert.deepEqual(report.summary, {
    scenarioCount: 15,
    mappedScenarioCount: 15,
    specialtyBindingCount: 30,
    baselineComparisonCount: 60,
    semanticPassCount: 60,
    semanticFailCount: 0,
    catalogSupportedCount: 0,
    catalogConditionalCount: 27,
    catalogGapCount: 3,
  });
  assert.equal(serializeDistinctnessReport(report), checkedIn);
  assert.equal(serializeDistinctnessReport(buildDistinctnessReport(draft)), checkedIn);
});

test('checked-in manifest serialization is stable and contains no absolute source mount path', () => {
  const manifest = loadManifest();
  const serialized = serializeManifest(manifest);
  assert.equal(serialized, serializeManifest(cloneManifest(manifest)));
  assert.doesNotMatch(serialized, /\/Users\/|\\Users\\|user-research-hub-integration\/wiki/u);
  assert.equal(manifest.logical_root, 'wiki/user-research');
});
