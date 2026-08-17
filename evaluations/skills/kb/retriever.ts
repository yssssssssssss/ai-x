import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseFrontmatter } from '../../../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { searchKnowledge, type SearchOpts } from '../../../apps/orchestrator-runtime/src/knowledge/index.ts';
import { readVerifiedSourceFile, type PinnedSourceRoot } from './snapshot.ts';
import type {
  GoldSourceSelection,
  KnowledgeContext,
  KnowledgeContextItem,
  KnowledgeIndexItem,
  KnowledgeRetrievalResult,
  KnowledgeSnapshot,
  RetrievalRecord,
  SkillKnowledgeMapping,
} from './types.ts';

export type KnowledgeSearch = (opts: SearchOpts) => KnowledgeIndexItem[];
export type KnowledgeGet = (id: string) => { frontmatter: Record<string, unknown>; content: string } | null;

type RetrievalRole = KnowledgeContextItem['role'];

interface GoldOptions {
  sourceRoot?: string;
}

interface LiveOptions {
  query?: string;
  search?: KnowledgeSearch;
  get?: KnowledgeGet;
}

function emptyResult(mode: 'gold' | 'live', snapshot: KnowledgeSnapshot, mapping: SkillKnowledgeMapping, query?: string): KnowledgeRetrievalResult {
  const context: KnowledgeContext = {
    mode,
    snapshot_id: snapshot.snapshot_id,
    required_source_ids: [],
    selected_source_ids: [],
    items: [],
  };
  const record: RetrievalRecord = {
    mode,
    snapshot_id: snapshot.snapshot_id,
    guide_tags: [...mapping.retrieval_tags],
    query,
    candidate_source_ids: [],
    selected_source_ids: [],
    required_source_recall: null,
    missing_required_source_ids: [],
    unresolved_items: [...mapping.unresolved_items],
  };
  return { context, record, warnings: [], failures: [] };
}

function unique<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sourceFileByPath(snapshot: KnowledgeSnapshot): Map<string, KnowledgeSnapshot['source_files'][number]> {
  return new Map(snapshot.source_files.map((source) => [source.path, source]));
}

function sourceIdByPath(index: Map<string, KnowledgeIndexItem>): Map<string, string> {
  return new Map([...index.values()].map((item) => [item.source_path, item.id]));
}

interface RequiredGroup {
  ids: string[];
  oneOf: boolean;
}

function requiredGroups(mapping: SkillKnowledgeMapping, index: Map<string, KnowledgeIndexItem>): RequiredGroup[] {
  const byPath = sourceIdByPath(index);
  const groups: RequiredGroup[] = [];
  const oneOf = new Map<string, string[]>();
  for (const source of mapping.required_sources) {
    const id = byPath.get(source.path) ?? `path:${source.path}`;
    if (source.role !== 'one_of') {
      groups.push({ ids: [id], oneOf: false });
      continue;
    }
    const key = source.trigger?.trim() || '__default__';
    const ids = oneOf.get(key) ?? [];
    ids.push(id);
    oneOf.set(key, ids);
  }
  for (const ids of oneOf.values()) groups.push({ ids: unique(ids), oneOf: true });
  return groups;
}

function requiredIds(mapping: SkillKnowledgeMapping, index: Map<string, KnowledgeIndexItem>, usableSelected: string[]): string[] {
  const selected = new Set(usableSelected);
  return requiredGroups(mapping, index).flatMap((group) => {
    if (!group.oneOf) return group.ids;
    const selectedAlternatives = group.ids.filter((id) => selected.has(id));
    return selectedAlternatives.length > 0 ? selectedAlternatives : group.ids.slice(0, 1);
  });
}

function roleByPath(mapping: SkillKnowledgeMapping): Map<string, RetrievalRole> {
  const roles = new Map<string, RetrievalRole>();
  for (const source of mapping.optional_sources) roles.set(source.path, 'optional');
  for (const source of mapping.conditional_sources) roles.set(source.path, 'conditional');
  for (const source of mapping.required_sources) roles.set(source.path, 'required');
  return roles;
}

function availableIds(group: RequiredGroup, index: Map<string, KnowledgeIndexItem>, snapshot: KnowledgeSnapshot): string[] {
  const files = sourceFileByPath(snapshot);
  return group.ids.filter((id) => {
    const item = index.get(id);
    const status = item?.status ?? (item ? files.get(item.source_path)?.status : undefined);
    return status !== 'deprecated';
  });
}

function recall(selectedIds: string[], groups: RequiredGroup[], index: Map<string, KnowledgeIndexItem>, snapshot: KnowledgeSnapshot): number | null {
  const available = groups.filter((group) => availableIds(group, index, snapshot).length > 0);
  if (available.length === 0) return null;
  const selected = new Set(selectedIds);
  return available.filter((group) => group.ids.some((id) => selected.has(id))).length / available.length;
}

function missingRequired(
  selectedIds: string[],
  unusableIds: Set<string>,
  groups: RequiredGroup[],
  index: Map<string, KnowledgeIndexItem>,
  snapshot: KnowledgeSnapshot,
): string[] {
  const selected = new Set(selectedIds);
  return unique(groups.flatMap((group) => {
    if (group.ids.some((id) => selected.has(id) && !unusableIds.has(id))) return [];
    const unusableSelected = group.ids.filter((id) => selected.has(id) && unusableIds.has(id));
    if (unusableSelected.length > 0) return unusableSelected;
    if (group.oneOf) return group.ids.slice(0, 1);
    return availableIds(group, index, snapshot).length === 0 ? group.ids : [];
  }));
}

function itemFromIndex(
  sourceId: string,
  indexItem: KnowledgeIndexItem,
  snapshot: KnowledgeSnapshot,
  role: RetrievalRole,
  content: string,
): KnowledgeContextItem {
  const snapshotFile = sourceFileByPath(snapshot).get(indexItem.source_path);
  const frozenHash = snapshotFile?.content_hash;
  const contentHash = frozenHash !== undefined && /^sha256:[0-9a-f]{64}$/.test(frozenHash)
    ? frozenHash
    : `sha256:${createHash('sha256').update(content).digest('hex')}`;
  return {
    source_id: sourceId,
    title: indexItem.title ?? indexItem.source_path,
    source_path: indexItem.source_path,
    content_hash: contentHash,
    status: snapshotFile?.status ?? indexItem.status,
    role,
    content,
  };
}

function warningForDraft(item: KnowledgeContextItem): string[] {
  return item.status === 'draft' ? [`draft source: ${item.source_path}`] : [];
}

function sourceRootFor(snapshot: KnowledgeSnapshot, sourceRoot?: string): string {
  return resolve(sourceRoot ?? snapshot.source_root ?? resolve(dirname(snapshot.index_path), '..'));
}

type FrozenRead = { content: string; root?: PinnedSourceRoot } | { kind: 'missing' | 'invalid'; detail: string };

function readFrozenSource(
  sourceId: string,
  indexItem: KnowledgeIndexItem,
  snapshot: KnowledgeSnapshot,
  sourceRoot?: string,
  expectedRoot?: PinnedSourceRoot,
): FrozenRead {
  const snapshotSources = snapshot.source_files.filter((source) => source.path === indexItem.source_path);
  if (snapshotSources.length !== 1) return { kind: 'invalid', detail: `snapshot path membership mismatch: ${indexItem.source_path}` };
  const snapshotSource = snapshotSources[0]!;
  if (snapshotSource.id !== undefined && snapshotSource.id !== sourceId) {
    return { kind: 'invalid', detail: `snapshot source id mismatch: expected ${snapshotSource.id}` };
  }
  if (snapshotSource.status !== indexItem.status) {
    return { kind: 'invalid', detail: `snapshot source status mismatch: expected ${snapshotSource.status}, got ${indexItem.status}` };
  }
  const root = sourceRootFor(snapshot, sourceRoot);
  if (snapshot.source_root !== undefined && sourceRoot !== undefined && root !== resolve(snapshot.source_root)) {
    return { kind: 'invalid', detail: 'source root differs from frozen snapshot root' };
  }
  try {
    const expectedHash = /^sha256:[0-9a-f]{64}$/.test(snapshotSource.content_hash)
      ? snapshotSource.content_hash
      : undefined;
    const verified = readVerifiedSourceFile(root, indexItem.source_path, expectedHash, expectedRoot);
    return { content: verified.bytes.toString('utf8'), root: verified.root };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: code === 'ENOENT' ? 'missing' : 'invalid',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildResult(
  mode: 'gold' | 'live',
  snapshot: KnowledgeSnapshot,
  mapping: SkillKnowledgeMapping,
  index: Map<string, KnowledgeIndexItem>,
  candidateIds: string[],
  selectedIds: string[],
  items: KnowledgeContextItem[],
  unresolved: string[],
  failures: string[],
  unusableIds: Set<string>,
  query?: string,
): KnowledgeRetrievalResult {
  const groups = requiredGroups(mapping, index);
  const usableSelected = selectedIds.filter((sourceId) => !unusableIds.has(sourceId));
  const required = requiredIds(mapping, index, selectedIds);
  const context: KnowledgeContext = {
    mode,
    snapshot_id: snapshot.snapshot_id,
    required_source_ids: required,
    selected_source_ids: selectedIds,
    items,
  };
  const record: RetrievalRecord = {
    mode,
    snapshot_id: snapshot.snapshot_id,
    guide_tags: [...mapping.retrieval_tags],
    query,
    candidate_source_ids: candidateIds,
    selected_source_ids: selectedIds,
    required_source_recall: recall(usableSelected, groups, index, snapshot),
    missing_required_source_ids: missingRequired(selectedIds, unusableIds, groups, index, snapshot),
    unresolved_items: unique(unresolved),
  };
  return { context, record, warnings: unique(items.flatMap(warningForDraft)), failures: unique(failures) };
}

export function loadGoldKnowledgeContext(
  skillId: string,
  snapshot: KnowledgeSnapshot,
  index: Map<string, KnowledgeIndexItem>,
  mapping: SkillKnowledgeMapping,
  goldSelection: GoldSourceSelection,
  options: GoldOptions = {},
): KnowledgeRetrievalResult {
  if (mapping.skill_id !== skillId || goldSelection.skill_id !== skillId) throw new Error(`skill mismatch: ${skillId}`);
  if (mapping.kb_mode === 'not_applicable') return emptyResult('gold', snapshot, mapping);
  const roles = roleByPath(mapping);
  const selectedIds = unique(goldSelection.selected_source_ids);
  const items: KnowledgeContextItem[] = [];
  const unresolved = [...goldSelection.unresolved_items];
  const failures: string[] = [];
  const unusableIds = new Set<string>();
  let pinnedRoot: PinnedSourceRoot | undefined;
  for (const sourceId of selectedIds) {
    const indexItem = index.get(sourceId);
    if (!indexItem) {
      const message = `missing index item: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(sourceId);
      continue;
    }
    if (indexItem.status === 'deprecated') {
      const message = `deprecated required source: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(sourceId);
      continue;
    }
    const frozen = readFrozenSource(sourceId, indexItem, snapshot, options.sourceRoot, pinnedRoot);
    if ('kind' in frozen) {
      const message = frozen.kind === 'missing'
        ? `missing body: ${sourceId}`
        : `snapshot verification failed: ${sourceId}: ${frozen.detail}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(sourceId);
      continue;
    }
    pinnedRoot ??= frozen.root;
    try {
      const canonicalContent = parseFrontmatter(frozen.content).content;
      items.push(itemFromIndex(sourceId, indexItem, snapshot, roles.get(indexItem.source_path) ?? 'candidate', canonicalContent));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `snapshot verification failed: ${sourceId}: ${detail}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(sourceId);
    }
  }
  return buildResult('gold', snapshot, mapping, index, selectedIds, selectedIds, items, unresolved, failures, unusableIds);
}

function mappingCandidates(mapping: SkillKnowledgeMapping, index: Map<string, KnowledgeIndexItem>): KnowledgeIndexItem[] {
  const byPath = new Map([...index.values()].map((item) => [item.source_path, item]));
  return [...mapping.required_sources, ...mapping.conditional_sources, ...mapping.optional_sources]
    .map((source) => byPath.get(source.path))
    .filter((item): item is KnowledgeIndexItem => Boolean(item));
}

function liveCandidates(mapping: SkillKnowledgeMapping, index: Map<string, KnowledgeIndexItem>, options: LiveOptions): KnowledgeIndexItem[] {
  if (mapping.retrieval_tags.length === 0) return mappingCandidates(mapping, index);
  const search = options.search ?? searchKnowledge;
  const rawQuery = options.query?.trim();
  const isSearchTerm = rawQuery !== undefined
    && rawQuery.length <= 32
    && rawQuery.split(/\s+/u).length <= 3
    && !/[。！？!?；;\n]/u.test(rawQuery);
  const searchOptions: SearchOpts = { guide_tags: [...mapping.retrieval_tags] };
  if (isSearchTerm) searchOptions.query = rawQuery;
  return search(searchOptions);
}

function selectLiveIds(mapping: SkillKnowledgeMapping, candidates: KnowledgeIndexItem[]): string[] {
  const candidateIds = new Set(candidates.map((item) => item.id));
  const byPath = new Map(candidates.map((item) => [item.source_path, item.id]));
  const selected: string[] = [];
  const selectedOneOfGroups = new Set<string>();
  for (const source of [...mapping.required_sources, ...mapping.conditional_sources]) {
    const id = byPath.get(source.path);
    if (!id || !candidateIds.has(id)) continue;
    if (source.role !== 'one_of') {
      selected.push(id);
      continue;
    }
    const group = source.trigger?.trim() || '__default__';
    if (selectedOneOfGroups.has(group)) continue;
    selectedOneOfGroups.add(group);
    selected.push(id);
  }
  return unique(selected);
}

function hasFrozenBinding(snapshot: KnowledgeSnapshot, indexItem: KnowledgeIndexItem): boolean {
  const snapshotSource = snapshot.source_files.find((source) => source.path === indexItem.source_path);
  return snapshot.source_root !== undefined
    || snapshotSource?.id !== undefined
    || (snapshotSource !== undefined && /^sha256:[0-9a-f]{64}$/.test(snapshotSource.content_hash));
}

function verifyLiveContent(
  sourceId: string,
  indexItem: KnowledgeIndexItem,
  snapshot: KnowledgeSnapshot,
  content: string,
  expectedRoot?: PinnedSourceRoot,
): FrozenRead {
  try {
    if (!hasFrozenBinding(snapshot, indexItem)) {
      return { content: parseFrontmatter(content).content };
    }
    const frozen = readFrozenSource(sourceId, indexItem, snapshot, undefined, expectedRoot);
    if ('kind' in frozen) return frozen;
    const parsedContent = parseFrontmatter(frozen.content).content;
    if (content !== frozen.content && content !== parsedContent) {
      return { kind: 'missing', detail: 'retrieved body differs from frozen snapshot source' };
    }
    return { content: parsedContent, root: frozen.root };
  } catch (error) {
    return { kind: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function loadLiveKnowledgeContext(
  skillId: string,
  snapshot: KnowledgeSnapshot,
  index: Map<string, KnowledgeIndexItem>,
  mapping: SkillKnowledgeMapping,
  options: LiveOptions = {},
): KnowledgeRetrievalResult {
  if (mapping.skill_id !== skillId) throw new Error(`skill mismatch: ${skillId}`);
  if (mapping.kb_mode === 'not_applicable') return emptyResult('live', snapshot, mapping, options.query);
  const get = options.get;
  const roles = roleByPath(mapping);
  const seenCandidates = new Set<string>();
  const candidates = liveCandidates(mapping, index, options).filter((item) => {
    if (seenCandidates.has(item.id)) return false;
    seenCandidates.add(item.id);
    return (index.get(item.id)?.status ?? item.status) !== 'deprecated';
  });
  const candidateIds = candidates.map((item) => item.id);
  const selectedIds = selectLiveIds(mapping, candidates);
  const selected = new Set(selectedIds);
  const oneOfPaths = new Set(mapping.required_sources.filter((source) => source.role === 'one_of').map((source) => source.path));
  const items: KnowledgeContextItem[] = [];
  const unresolved = [...mapping.unresolved_items];
  const failures: string[] = [];
  const unusableIds = new Set<string>();
  let pinnedRoot: PinnedSourceRoot | undefined;

  for (const group of requiredGroups(mapping, index)) {
    if (availableIds(group, index, snapshot).length > 0) continue;
    for (const sourceId of group.ids) {
      if (index.get(sourceId)?.status !== 'deprecated') continue;
      const message = `deprecated required source: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(sourceId);
    }
  }

  for (const candidate of candidates) {
    const indexItem = index.get(candidate.id);
    if (!indexItem) {
      const message = `missing index item: ${candidate.id}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(candidate.id);
      continue;
    }
    if (candidate.source_path !== indexItem.source_path || candidate.status !== indexItem.status) {
      const message = `snapshot verification failed: ${candidate.id}: candidate identity differs from frozen index`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(candidate.id);
      continue;
    }
    if (oneOfPaths.has(indexItem.source_path) && !selected.has(candidate.id)) continue;
    let frozenBeforeGet: { content: string; root?: PinnedSourceRoot } | undefined;
    if (hasFrozenBinding(snapshot, indexItem)) {
      const frozen = readFrozenSource(candidate.id, indexItem, snapshot, undefined, pinnedRoot);
      if ('kind' in frozen) {
        const message = frozen.kind === 'missing'
          ? `missing body: ${candidate.id}`
          : `snapshot verification failed: ${candidate.id}: ${frozen.detail}`;
        unresolved.push(message);
        failures.push(message);
        unusableIds.add(candidate.id);
        continue;
      }
      pinnedRoot ??= frozen.root;
      frozenBeforeGet = frozen;
    }

    let verified: FrozenRead;
    if (get) {
      const entry = get(candidate.id);
      if (!entry) {
        const message = `missing body: ${candidate.id}`;
        unresolved.push(message);
        failures.push(message);
        unusableIds.add(candidate.id);
        continue;
      }
      verified = verifyLiveContent(candidate.id, indexItem, snapshot, entry.content, frozenBeforeGet?.root);
    } else if (frozenBeforeGet) {
      try {
        verified = { content: parseFrontmatter(frozenBeforeGet.content).content, root: frozenBeforeGet.root };
      } catch (error) {
        verified = { kind: 'invalid', detail: error instanceof Error ? error.message : String(error) };
      }
    } else {
      verified = { kind: 'missing', detail: 'no frozen source body or injected getter' };
    }

    if ('kind' in verified) {
      const message = verified.kind === 'missing'
        ? `missing body: ${candidate.id}`
        : `snapshot verification failed: ${candidate.id}: ${verified.detail}`;
      unresolved.push(message);
      failures.push(message);
      unusableIds.add(candidate.id);
      continue;
    }
    if (!selected.has(candidate.id)) continue;
    items.push(itemFromIndex(candidate.id, indexItem, snapshot, roles.get(indexItem.source_path) ?? 'candidate', verified.content));
  }

  return buildResult(
    'live',
    snapshot,
    mapping,
    index,
    candidateIds,
    selectedIds,
    items,
    unresolved,
    failures,
    unusableIds,
    options.query,
  );
}

export type { KnowledgeRetrievalResult } from './types.ts';
