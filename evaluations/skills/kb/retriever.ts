import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getEntry, searchKnowledge, type SearchOpts } from '../../../apps/orchestrator-runtime/src/knowledge/index.ts';
import type {
  GoldSourceSelection,
  KnowledgeContext,
  KnowledgeContextItem,
  KnowledgeIndexItem,
  KnowledgeRetrievalResult,
  KnowledgeSnapshot,
  KnowledgeSourceRule,
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

function sourceFileByPath(snapshot: KnowledgeSnapshot): Map<string, { path: string; content_hash: string; status: string }> {
  return new Map(snapshot.source_files.map((source) => [source.path, source]));
}

function sourceIdByPath(index: Map<string, KnowledgeIndexItem>): Map<string, string> {
  return new Map([...index.values()].map((item) => [item.source_path, item.id]));
}

function requiredIds(mapping: SkillKnowledgeMapping, index: Map<string, KnowledgeIndexItem>): string[] {
  const byPath = sourceIdByPath(index);
  return mapping.required_sources.map((source) => byPath.get(source.path) ?? `path:${source.path}`);
}

function roleByPath(mapping: SkillKnowledgeMapping): Map<string, RetrievalRole> {
  const roles = new Map<string, RetrievalRole>();
  for (const source of mapping.optional_sources) roles.set(source.path, 'optional');
  for (const source of mapping.conditional_sources) roles.set(source.path, 'conditional');
  for (const source of mapping.required_sources) roles.set(source.path, 'required');
  return roles;
}

function availableRequiredIds(mapping: SkillKnowledgeMapping, index: Map<string, KnowledgeIndexItem>, snapshot: KnowledgeSnapshot): string[] {
  const byPath = sourceIdByPath(index);
  const files = sourceFileByPath(snapshot);
  return unique(mapping.required_sources.flatMap((source) => {
    const id = byPath.get(source.path) ?? `path:${source.path}`;
    const item = index.get(id);
    const status = item?.status ?? files.get(source.path)?.status;
    return status === 'deprecated' ? [] : [id];
  }));
}

function recall(selectedIds: string[], availableRequired: string[]): number | null {
  if (availableRequired.length === 0) return null;
  const selected = new Set(selectedIds);
  return availableRequired.filter((id) => selected.has(id)).length / availableRequired.length;
}

function missingRequired(selectedIds: string[], required: string[], availableRequired: string[]): string[] {
  const selected = new Set(selectedIds);
  const available = new Set(availableRequired);
  return required.filter((id) => !selected.has(id) && !available.has(id));
}

function itemFromIndex(
  sourceId: string,
  indexItem: KnowledgeIndexItem,
  snapshot: KnowledgeSnapshot,
  role: RetrievalRole,
  content: string,
): KnowledgeContextItem {
  const snapshotFile = sourceFileByPath(snapshot).get(indexItem.source_path);
  return {
    source_id: sourceId,
    title: indexItem.title ?? indexItem.source_path,
    source_path: indexItem.source_path,
    content_hash: snapshotFile?.content_hash ?? indexItem.content_hash ?? '',
    status: snapshotFile?.status ?? indexItem.status,
    role,
    content,
  };
}

function warningForDraft(item: KnowledgeContextItem): string[] {
  return item.status === 'draft' ? [`draft source: ${item.source_path}`] : [];
}

function sourceRootFor(snapshot: KnowledgeSnapshot, sourceRoot?: string): string {
  return sourceRoot ? resolve(sourceRoot) : resolve(dirname(snapshot.index_path), '..');
}

function readGoldContent(snapshot: KnowledgeSnapshot, indexItem: KnowledgeIndexItem, sourceRoot?: string): string | null {
  try {
    return readFileSync(join(sourceRootFor(snapshot, sourceRoot), indexItem.source_path), 'utf8');
  } catch {
    return null;
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
  query?: string,
): KnowledgeRetrievalResult {
  const required = requiredIds(mapping, index);
  const context: KnowledgeContext = {
    mode,
    snapshot_id: snapshot.snapshot_id,
    required_source_ids: required,
    selected_source_ids: selectedIds,
    items,
  };
  const availableRequired = availableRequiredIds(mapping, index, snapshot);
  const record: RetrievalRecord = {
    mode,
    snapshot_id: snapshot.snapshot_id,
    guide_tags: [...mapping.retrieval_tags],
    query,
    candidate_source_ids: candidateIds,
    selected_source_ids: selectedIds,
    required_source_recall: recall(selectedIds, availableRequired),
    missing_required_source_ids: selectedIds.filter((sourceId) => failures.includes(`missing body: ${sourceId}`)),
    unresolved_items: unresolved,
  };
  return { context, record, warnings: unique(items.flatMap(warningForDraft)), failures };
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
  for (const sourceId of selectedIds) {
    const indexItem = index.get(sourceId);
    if (!indexItem) {
      const message = `missing index item: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      continue;
    }
    if (indexItem.status === 'deprecated') {
      const message = `deprecated required source: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      continue;
    }
    const content = readGoldContent(snapshot, indexItem, options.sourceRoot);
    if (content === null) {
      const message = `missing body: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      continue;
    }
    items.push(itemFromIndex(sourceId, indexItem, snapshot, roles.get(indexItem.source_path) ?? 'candidate', content));
  }
  return buildResult('gold', snapshot, mapping, index, selectedIds, selectedIds, items, unresolved, failures);
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
  return search({ guide_tags: [...mapping.retrieval_tags], query: options.query });
}

function selectLiveIds(mapping: SkillKnowledgeMapping, candidates: KnowledgeIndexItem[]): string[] {
  const candidateIds = new Set(candidates.map((item) => item.id));
  const byPath = new Map(candidates.map((item) => [item.source_path, item.id]));
  const selected: string[] = [];
  for (const source of [...mapping.required_sources, ...mapping.conditional_sources]) {
    const id = byPath.get(source.path);
    if (id && candidateIds.has(id)) selected.push(id);
  }
  return unique(selected);
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
  const get = options.get ?? getEntry;
  const roles = roleByPath(mapping);
  const required = requiredIds(mapping, index);
  const candidates = unique(liveCandidates(mapping, index, options)).filter((item) => item.status !== 'deprecated');
  const candidateIds = candidates.map((item) => item.id);
  const selectedIds = selectLiveIds(mapping, candidates);
  const selected = new Set(selectedIds);
  const items: KnowledgeContextItem[] = [];
  const unresolved = [...mapping.unresolved_items];
  const failures: string[] = [];

  for (const sourceId of required) {
    const indexItem = index.get(sourceId);
    if (indexItem?.status === 'deprecated') {
      const message = `deprecated required source: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
    }
  }

  for (const sourceId of selectedIds) {
    const indexItem = index.get(sourceId);
    if (!indexItem) continue;
    const entry = get(sourceId);
    if (!entry) {
      const message = `missing body: ${sourceId}`;
      unresolved.push(message);
      failures.push(message);
      continue;
    }
    items.push(itemFromIndex(sourceId, indexItem, snapshot, roles.get(indexItem.source_path) ?? 'candidate', entry.content));
  }

  const availableRequired = availableRequiredIds(mapping, index, snapshot);
  const missing = [...missingRequired(selectedIds, required, availableRequired), ...selectedIds.filter((sourceId) => failures.includes(`missing body: ${sourceId}`))];
  const context: KnowledgeContext = {
    mode: 'live',
    snapshot_id: snapshot.snapshot_id,
    required_source_ids: required,
    selected_source_ids: selectedIds,
    items,
  };
  const record: RetrievalRecord = {
    mode: 'live',
    snapshot_id: snapshot.snapshot_id,
    guide_tags: [...mapping.retrieval_tags],
    query: options.query,
    candidate_source_ids: candidateIds,
    selected_source_ids: selectedIds,
    required_source_recall: recall(selectedIds.filter((sourceId) => !failures.includes(`missing body: ${sourceId}`)), availableRequired),
    missing_required_source_ids: unique(missing),
    unresolved_items: unresolved,
  };
  void selected;
  return { context, record, warnings: unique(items.flatMap(warningForDraft)), failures };
}

export type { KnowledgeRetrievalResult } from './types.ts';
