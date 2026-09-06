import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getConfigRoot } from '../../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SkillLoader } from '../../../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import type {
  GoldSourceSelection,
  KnowledgeIndexItem,
  KnowledgeSnapshotResult,
  KnowledgeSourceRule,
  SkillKnowledgeMapping,
} from './types.ts';


function defaultMappingPath(): string {
  return join(getConfigRoot(), 'evaluations/skills/kb/skill-knowledge-mapping.json');
}

function defaultGoldPath(): string {
  return join(getConfigRoot(), 'evaluations/skills/kb/gold-source-selections.json');
}

function defaultIndexPath(): string {
  return join(getConfigRoot(), 'knowledge-base/.index/knowledge.json');
}
function hashBytes(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export interface PinnedSourceRoot {
  path: string;
  real_path: string;
  dev: number;
  ino: number;
}

function pinSourceRoot(root: string): PinnedSourceRoot {
  const path = resolve(root);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`source root is a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`source root is not a directory: ${path}`);
  return { path, real_path: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertPinnedRoot(root: PinnedSourceRoot): void {
  const stat = lstatSync(root.path);
  if (stat.isSymbolicLink()) throw new Error(`source root is a symlink: ${root.path}`);
  if (stat.dev !== root.dev || stat.ino !== root.ino || realpathSync(root.path) !== root.real_path) {
    throw new Error(`source root changed while reading: ${root.path}`);
  }
}

function assertOpenedSourcePath(root: PinnedSourceRoot, sourcePath: string, fullPath: string, descriptorStat: Stats): void {
  assertPinnedRoot(root);
  const relativePath = relative(root.path, fullPath);
  let currentPath = root.path;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    if (lstatSync(currentPath).isSymbolicLink()) throw new Error(`source path escapes KB root via symlink: ${sourcePath}`);
  }
  const realPath = realpathSync(fullPath);
  const realRelative = relative(root.real_path, realPath);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || realRelative.startsWith(sep)) {
    throw new Error(`source path escapes KB root via symlink: ${sourcePath}`);
  }
  const pathStat = lstatSync(fullPath);
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new Error(`source path changed while reading: ${sourcePath}`);
  }
}

export function readVerifiedSourceFile(
  root: string,
  sourcePath: string,
  expectedHash?: string,
  expectedRoot?: PinnedSourceRoot,
): { bytes: Buffer; content_hash: string; root: PinnedSourceRoot } {
  const pinnedRoot = pinSourceRoot(root);
  if (expectedRoot && (
    pinnedRoot.path !== expectedRoot.path
    || pinnedRoot.real_path !== expectedRoot.real_path
    || pinnedRoot.dev !== expectedRoot.dev
    || pinnedRoot.ino !== expectedRoot.ino
  )) {
    throw new Error(`source root changed while reading: ${pinnedRoot.path}`);
  }
  const fullPath = resolve(pinnedRoot.path, sourcePath);
  const relativePath = relative(pinnedRoot.path, fullPath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error(`source path escapes KB root: ${sourcePath}`);
  }

  const descriptor = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`source is not a regular file: ${sourcePath}`);
    assertOpenedSourcePath(pinnedRoot, sourcePath, fullPath, before);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`source changed while reading: ${sourcePath}`);
    }
    assertOpenedSourcePath(pinnedRoot, sourcePath, fullPath, after);
    const contentHash = hashBytes(bytes);
    if (expectedHash !== undefined && contentHash !== expectedHash) {
      throw new Error(`source hash mismatch: expected ${expectedHash}, got ${contentHash}`);
    }
    return { bytes, content_hash: contentHash, root: pinnedRoot };
  } finally {
    closeSync(descriptor);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sourceRootFor(indexPath: string, sourceRoot?: string): string {
  if (sourceRoot) return resolve(sourceRoot);
  const absolute = resolve(indexPath);
  return absolute.endsWith('/.index/knowledge.json') ? dirname(dirname(absolute)) : dirname(absolute);
}

function assertSafeSourcePath(root: string, sourcePath: string): string {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error(`source root is a symlink: ${root}`);
  const fullPath = resolve(root, sourcePath);
  const relativePath = relative(root, fullPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error(`source path escapes KB root: ${sourcePath}`);
  }
  if (existsSync(fullPath)) {
    let currentPath = root;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      currentPath = join(currentPath, segment);
      if (lstatSync(currentPath).isSymbolicLink()) throw new Error(`source path escapes KB root via symlink: ${sourcePath}`);
    }
    const realRoot = realpathSync(root);
    const realPath = realpathSync(fullPath);
    const realRelative = relative(realRoot, realPath);
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || realRelative.startsWith(sep)) {
      throw new Error(`source path escapes KB root via symlink: ${sourcePath}`);
    }
  }
  return fullPath;
}
export function canonicalSourceId(path: string, indexItems: KnowledgeIndexItem[]): string {
  return indexItems.some((item) => item.source_path === path) ? indexItems.find((item) => item.source_path === path)!.id : `path:${path}`;
}

function readIndex(indexPath: string): { bytes: Buffer; items: KnowledgeIndexItem[] } {
  const bytes = readFileSync(indexPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`invalid knowledge index JSON: ${indexPath}`);
  }
  if (!Array.isArray(parsed)) throw new Error('invalid knowledge index: expected array');
  const seenPaths = new Set<string>();
  const seen = new Set<string>();
  const items = parsed.map((item, position) => {
    if (!record(item)) throw new Error(`invalid knowledge index item at position ${position}`);
    const { id, source_path: sourcePath, status } = item;
    if (typeof id !== 'string' || typeof sourcePath !== 'string' || typeof status !== 'string') {
      throw new Error(`invalid knowledge index item at position ${position}`);
    }
    if (seenPaths.has(sourcePath)) throw new Error(`duplicate knowledge source path: ${sourcePath}`);
    seenPaths.add(sourcePath);
    if (seen.has(id)) throw new Error(`duplicate knowledge index id: ${id}`);
    seen.add(id);
    const indexItem: KnowledgeIndexItem = { ...item, id, source_path: sourcePath, status };
    return indexItem;
  });
  return { bytes, items };
}

function mappingSourcePaths(mapping: SkillKnowledgeMapping): KnowledgeSourceRule[] {
  return [...mapping.required_sources, ...mapping.conditional_sources, ...mapping.optional_sources];
}

function validateMappingShape(value: unknown, position: number): SkillKnowledgeMapping {
  if (!record(value)) throw new Error(`invalid mapping at position ${position}`);
  const required = ['required_sources', 'conditional_sources', 'optional_sources'];
  if (typeof value.skill_id !== 'string' || typeof value.kb_mode !== 'string') throw new Error(`invalid mapping at position ${position}`);
  for (const key of required) if (!Array.isArray(value[key])) throw new Error(`invalid mapping ${value.skill_id}: ${key} must be an array`);
  if (!stringArray(value.retrieval_tags) || !stringArray(value.unresolved_items)) throw new Error(`invalid mapping ${value.skill_id}: string arrays required`);
  if (!['required', 'not_applicable', 'manual_review'].includes(value.kb_mode)) throw new Error(`invalid mapping ${value.skill_id}: invalid kb_mode`);
  if (typeof value.source_status_policy !== 'string' || !['draft_allowed_with_warning', 'reviewed_required', 'not_applicable'].includes(value.source_status_policy)) throw new Error(`invalid mapping ${value.skill_id}: invalid source_status_policy`);
  for (const key of required) {
    for (const source of value[key] as unknown[]) {
      if (!record(source) || typeof source.path !== 'string' || typeof source.role !== 'string') throw new Error(`invalid source rule in mapping ${value.skill_id}`);
    }
  }
  return value as unknown as SkillKnowledgeMapping;
}

export function loadSkillKnowledgeMappings(
  activeSkills: { id: string }[],
  mappingPath?: string,
): Map<string, SkillKnowledgeMapping> {
  const parsed: unknown = JSON.parse(readFileSync(mappingPath ?? defaultMappingPath(), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('invalid skill knowledge mapping: expected array');
  const mappings = parsed.map(validateMappingShape);
  const activeIds = new Set(activeSkills.map((skill) => skill.id));
  const unknown = mappings.map((mapping) => mapping.skill_id).filter((id) => !activeIds.has(id));
  if (unknown.length) throw new Error(`unknown skill mapping: ${unknown.join(', ')}`);
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (seen.has(mapping.skill_id)) throw new Error(`duplicate mapping: ${mapping.skill_id}`);
    seen.add(mapping.skill_id);
  }
  const missing = activeSkills.map((skill) => skill.id).filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`missing mapping: ${missing.join(', ')}`);
  return new Map(activeSkills.map((skill) => [skill.id, mappings.find((mapping) => mapping.skill_id === skill.id)!]));
}

function selectionShape(value: unknown, position: number): GoldSourceSelection {
  if (!record(value) || typeof value.skill_id !== 'string' || typeof value.mode !== 'string' || !stringArray(value.selected_source_ids) || !stringArray(value.unresolved_items)) {
    throw new Error(`invalid gold selection at position ${position}`);
  }
  if (!['gold', 'not_applicable', 'manual_review'].includes(value.mode)) throw new Error(`invalid gold selection mode for ${value.skill_id}`);
  return value as unknown as GoldSourceSelection;
}

function validateGoldSelections(
  selections: GoldSourceSelection[],
  activeSkills: { id: string }[],
): void {
  const activeIds = new Set(activeSkills.map((skill) => skill.id));
  const seen = new Set<string>();
  const mappings = loadSkillKnowledgeMappings(activeSkills);
  const indexPath = defaultIndexPath();
  const indexItems = existsSync(indexPath) ? readIndex(indexPath).items : [];
  const kbRoot = resolve(join(getConfigRoot(), 'knowledge-base'));
  for (const item of indexItems) assertSafeSourcePath(kbRoot, item.source_path);
  for (const mapping of mappings.values()) {
    for (const source of mappingSourcePaths(mapping)) {
      const fullPath = assertSafeSourcePath(kbRoot, source.path);
      if (!existsSync(fullPath)) throw new Error(`missing mapped source: ${source.path}`);
    }
  }
  for (const selection of selections) {
    if (!activeIds.has(selection.skill_id)) throw new Error(`unknown gold selection: ${selection.skill_id}`);
    const mapping = mappings.get(selection.skill_id);
    if (!mapping) throw new Error(`missing mapping: ${selection.skill_id}`);
    if (seen.has(selection.skill_id)) throw new Error(`duplicate gold selection: ${selection.skill_id}`);
    seen.add(selection.skill_id);
    if (new Set(selection.selected_source_ids).size !== selection.selected_source_ids.length) throw new Error(`duplicate selected source ID: ${selection.skill_id}`);
    const expectedMode = mapping.kb_mode === 'required' ? 'gold' : mapping.kb_mode;
    if (selection.mode !== expectedMode) throw new Error(`gold selection mode mismatch: ${selection.skill_id}`);
    if (expectedMode !== 'gold' && selection.selected_source_ids.length > 0) throw new Error(`non-KB gold selection must be empty: ${selection.skill_id}`);
    if (JSON.stringify(selection.unresolved_items) !== JSON.stringify(mapping.unresolved_items)) throw new Error(`gold unresolved_items mismatch: ${selection.skill_id}`);
    const rules = mappingSourcePaths(mapping);
    const allowed = new Set(rules.map((source) => canonicalSourceId(source.path, indexItems)));
    const sourcePathById = new Map(rules.map((source) => [canonicalSourceId(source.path, indexItems), source.path]));
    for (const sourceId of selection.selected_source_ids) {
      if (!allowed.has(sourceId)) throw new Error(`unresolvable gold source ID: ${selection.skill_id}:${sourceId}`);
      const sourcePath = sourcePathById.get(sourceId);
      if (sourcePath && sourceId.startsWith('path:')) assertSafeSourcePath(kbRoot, sourcePath);
    }
    const required = mapping.required_sources.filter((source) => source.role !== 'one_of').map((source) => canonicalSourceId(source.path, indexItems));
    if (!required.every((sourceId) => selection.selected_source_ids.includes(sourceId))) throw new Error(`gold selection missing required source: ${selection.skill_id}`);
    const oneOfGroups = new Map<string, string[]>();
    for (const source of mapping.required_sources.filter((rule) => rule.role === 'one_of')) {
      const group = source.trigger?.trim() || '__default__';
      const sourceIds = oneOfGroups.get(group) ?? [];
      sourceIds.push(canonicalSourceId(source.path, indexItems));
      oneOfGroups.set(group, sourceIds);
    }
    for (const sourceIds of oneOfGroups.values()) {
      if (!sourceIds.some((sourceId) => selection.selected_source_ids.includes(sourceId))) {
        throw new Error(`gold selection missing one-of source: ${selection.skill_id}`);
      }
    }
  }
  const missing = activeSkills.map((skill) => skill.id).filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`missing gold selection: ${missing.join(', ')}`);
}

export function loadGoldSourceSelections(
  activeSkills: { id: string }[],
  selectionPath?: string,
): Map<string, GoldSourceSelection> {
  const parsed: unknown = JSON.parse(readFileSync(selectionPath ?? defaultGoldPath(), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('invalid gold source selections: expected array');
  const selections = parsed.map(selectionShape);
  validateGoldSelections(selections, activeSkills);
  return new Map(activeSkills.map((skill) => [skill.id, selections.find((selection) => selection.skill_id === skill.id)!]));
}

export function buildKnowledgeSnapshot(indexPath = defaultIndexPath(), sourceRoot?: string): KnowledgeSnapshotResult {
  const absoluteIndex = resolve(indexPath);
  const { bytes, items: indexedItems } = readIndex(absoluteIndex);
  const root = sourceRootFor(absoluteIndex, sourceRoot);
  const items = [...indexedItems];
  const catalogRoot = resolve(join(getConfigRoot(), 'knowledge-base'));
  if (root === catalogRoot && existsSync(defaultMappingPath())) {
    const mappings = loadSkillKnowledgeMappings(new SkillLoader().listActiveSkills());
    for (const mapping of mappings.values()) {
      for (const source of mappingSourcePaths(mapping)) {
        if (items.some((item) => item.source_path === source.path)) continue;
        const fullPath = assertSafeSourcePath(root, source.path);
        if (!existsSync(fullPath)) throw new Error(`missing mapped source: ${source.path}`);
        items.push({ id: `path:${source.path}`, source_path: source.path, status: source.status ?? 'draft' });
      }
    }
  }
  const warnings: string[] = [];
  let pinnedRoot: PinnedSourceRoot | undefined;
  const sourceFiles = [...items].sort((a, b) => a.source_path.localeCompare(b.source_path)).map((item) => {
    const fullPath = assertSafeSourcePath(root, item.source_path);
    if (!existsSync(fullPath)) throw new Error(`missing source: ${item.source_path}`);
    if (item.status === 'deprecated') throw new Error(`deprecated source: ${item.source_path}`);
    if (item.status === 'draft') warnings.push(`draft source: ${item.source_path}`);
    const verified = readVerifiedSourceFile(root, item.source_path, undefined, pinnedRoot);
    pinnedRoot ??= verified.root;
    return { id: item.id, path: item.source_path, content_hash: verified.content_hash, status: item.status };
  });
  const material = [bytes.toString('utf8'), ...sourceFiles.map((source) => `${source.path}\0${source.content_hash}`)].join('\n');
  const snapshot = {
    snapshot_id: hashBytes(material),
    index_path: absoluteIndex,
    index_hash: hashBytes(bytes),
    built_at: new Date().toISOString(),
    source_root: root,
    source_files: sourceFiles,
  };
  return { snapshot, index: new Map(items.map((item) => [item.id, item])), warnings };
}

export function loadKnowledgeSnapshot(indexPath = defaultIndexPath(), sourceRoot?: string): KnowledgeSnapshotResult {
  return buildKnowledgeSnapshot(indexPath, sourceRoot);
}
