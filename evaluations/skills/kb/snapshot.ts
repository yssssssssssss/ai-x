import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getConfigRoot, type SkillRegistryEntry } from '../../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import type {
  GoldSourceSelection,
  KnowledgeIndexItem,
  KnowledgeSnapshotResult,
  KnowledgeSourceRule,
  SkillKnowledgeMapping,
} from './types.ts';

const DEFAULT_MAPPING_PATH = join(getConfigRoot(), 'evaluations/skills/kb/skill-knowledge-mapping.json');
const DEFAULT_GOLD_PATH = join(getConfigRoot(), 'evaluations/skills/kb/gold-source-selections.json');
const DEFAULT_INDEX_PATH = join(getConfigRoot(), 'knowledge-base/.index/knowledge.json');

function hashBytes(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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
  return absolute.endsWith('/.index/knowledge.json')
    ? dirname(dirname(absolute))
    : dirname(absolute);
}

function readIndex(indexPath: string): { bytes: Buffer; items: KnowledgeIndexItem[] } {
  const bytes = readFileSync(indexPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`invalid knowledge index JSON: ${indexPath}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`invalid knowledge index: expected array in ${indexPath}`);
  const items = parsed.map((item, position) => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.source_path !== 'string' || typeof item.status !== 'string') {
      throw new Error(`invalid knowledge index item at position ${position}`);
    }
    return item as KnowledgeIndexItem;
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
  if (!['draft_allowed_with_warning', 'reviewed_required', 'not_applicable'].includes(value.source_status_policy)) throw new Error(`invalid mapping ${value.skill_id}: invalid source_status_policy`);
  for (const key of required) {
    for (const source of value[key] as unknown[]) {
      if (!record(source) || typeof source.path !== 'string' || typeof source.role !== 'string') throw new Error(`invalid source rule in mapping ${value.skill_id}`);
    }
  }
  return value as unknown as SkillKnowledgeMapping;
}

export function loadSkillKnowledgeMappings(
  activeSkills: SkillRegistryEntry[],
  mappingPath = DEFAULT_MAPPING_PATH,
): Map<string, SkillKnowledgeMapping> {
  const parsed: unknown = JSON.parse(readFileSync(mappingPath, 'utf8'));
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

export function loadGoldSourceSelections(
  activeSkills: SkillRegistryEntry[],
  selectionPath = DEFAULT_GOLD_PATH,
): Map<string, GoldSourceSelection> {
  const parsed: unknown = JSON.parse(readFileSync(selectionPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('invalid gold source selections: expected array');
  const selections = parsed.map(selectionShape);
  const activeIds = new Set(activeSkills.map((skill) => skill.id));
  const unknown = selections.map((selection) => selection.skill_id).filter((id) => !activeIds.has(id));
  if (unknown.length) throw new Error(`unknown gold selection: ${unknown.join(', ')}`);
  const seen = new Set(selections.map((selection) => selection.skill_id));
  const missing = activeSkills.map((skill) => skill.id).filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`missing gold selection: ${missing.join(', ')}`);
  return new Map(activeSkills.map((skill) => [skill.id, selections.find((selection) => selection.skill_id === skill.id)!]));
}

export function buildKnowledgeSnapshot(indexPath = DEFAULT_INDEX_PATH, sourceRoot?: string): KnowledgeSnapshotResult {
  const absoluteIndex = resolve(indexPath);
  const { bytes, items } = readIndex(absoluteIndex);
  const root = sourceRootFor(absoluteIndex, sourceRoot);
  const warnings: string[] = [];
  const sourceFiles = [...items].sort((a, b) => a.source_path.localeCompare(b.source_path)).map((item) => {
    const fullPath = join(root, item.source_path);
    if (!existsSync(fullPath)) throw new Error(`missing source: ${item.source_path}`);
    if (item.status === 'deprecated') throw new Error(`deprecated source: ${item.source_path}`);
    if (item.status === 'draft') warnings.push(`draft source: ${item.source_path}`);
    return { path: item.source_path, content_hash: hashBytes(readFileSync(fullPath)), status: item.status };
  });
  const material = [bytes.toString('utf8'), ...sourceFiles.map((source) => `${source.path}\0${source.content_hash}`)].join('\n');
  const snapshot = {
    snapshot_id: hashBytes(material),
    index_path: absoluteIndex,
    index_hash: hashBytes(bytes),
    built_at: new Date().toISOString(),
    source_files: sourceFiles,
  };
  return { snapshot, index: new Map(items.map((item) => [item.id, item])), warnings };
}

export function loadKnowledgeSnapshot(indexPath = DEFAULT_INDEX_PATH, sourceRoot?: string): KnowledgeSnapshotResult {
  return buildKnowledgeSnapshot(indexPath, sourceRoot);
}
