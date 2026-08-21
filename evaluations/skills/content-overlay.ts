import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getConfigRoot } from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { parseFrontmatter } from '../../apps/orchestrator-runtime/src/knowledge/frontmatter.ts';
import { contentHash } from '../../apps/orchestrator-runtime/src/knowledge/normalizer.ts';
import type { LoadedEvaluationCase } from './types.ts';
import type {
  KnowledgeContext,
  KnowledgeContextItem,
  RetrievalRecord,
} from './kb/types.ts';

export const USER_RESEARCH_HUB_C1_OVERLAY_ID = 'user-research-hub-c1';

export type ContentEvaluationVariant = 'baseline' | 'enhanced';
export type ContentOverlayEntryKind = 'method' | 'asset' | 'draft_skill' | 'skill_delta';
export type ContentCriterionStatus = 'pass' | 'fail' | 'not_applicable';

interface OverlayFileReference {
  path: string;
  artifact_hash: string;
}

interface OverlayEntryDefinition {
  id: string;
  kind: ContentOverlayEntryKind;
  path: string;
  status: 'candidate' | 'draft';
  source_hash: string;
  content_hash: string;
  artifact_hash: string;
  canonical_target?: string;
  canonical_hash?: string;
}

interface OverlayBindingDefinition {
  skill_id: string;
  content_ids: string[];
  skill_delta_ids: string[];
}

interface OverlayManifestDefinition {
  version: 1;
  id: typeof USER_RESEARCH_HUB_C1_OVERLAY_ID;
  scope: 'evaluation_only';
  gate: 'gate-3-pending';
  production_search_allowed: false;
  prompt: OverlayFileReference;
  rubric: OverlayFileReference;
  fixed_task: { skill_id: string; case_path: string; case_hash: string };
  production_baseline: {
    planning_policy_path: string;
    planning_policy_hash: string;
    candidate_generation_mode: 'fixed';
    prompt_path: string;
    prompt_hash: string;
    rubric_path: string;
    rubric_hash: string;
  };
  entries: OverlayEntryDefinition[];
  bindings: OverlayBindingDefinition[];
  promotion_set: {
    knowledge_candidate_ids: string[];
    asset_candidate_ids: string[];
    draft_skill_ids: string[];
    skill_delta_ids: string[];
  };
}

interface OverlayRubricDefinition {
  version: 1;
  id: typeof USER_RESEARCH_HUB_C1_OVERLAY_ID;
  scope: 'evaluation_only';
  grounding: Array<{ id: string; criterion: string }>;
  strategy_chain: Array<{ id: string; criterion?: string; field?: string }>;
}

export interface ContentOverlayEntryMetadata {
  id: string;
  kind: ContentOverlayEntryKind;
  path: string;
  status: 'candidate' | 'draft';
  sourceHash: string;
  contentHash: string;
  artifactHash: string;
  canonicalTarget?: string;
  canonicalHash?: string;
  registryStatus?: 'draft';
  runtimeConsumed?: false;
}

export interface ContentEvaluationManifestMetadata {
  overlayId: typeof USER_RESEARCH_HUB_C1_OVERLAY_ID;
  overlayVersion: 1;
  variant: ContentEvaluationVariant;
  scope: 'evaluation_only';
  gate: 'gate-3-pending';
  manifestHash: string;
  contentSetHash: string;
  promptHash: string;
  rubricHash: string;
  criteria: {
    grounding: Array<{ id: string; criterion: string }>;
    strategyChain: Array<{ id: string; criterion?: string; field?: string }>;
  };
  fixedTaskSkillId: string;
  fixedTaskCaseHash: string;
  productionSearchUsed: false;
  candidateGenerationMode: 'fixed';
  entries: ContentOverlayEntryMetadata[];
  promotionSet: {
    knowledgeCandidateIds: string[];
    assetCandidateIds: string[];
    draftSkillIds: string[];
    skillDeltaIds: string[];
  };
  injectedSourceIds: string[];
  appliedSkillDeltaIds: string[];
  productionBaseline: {
    planningPolicyHash: string;
    promptHash: string;
    rubricHash: string;
  };
}

export interface ContentCriterionResult {
  id: string;
  status: ContentCriterionStatus;
  evidence: string[];
}

export interface ContentEvaluationAssessment {
  overlay_id: typeof USER_RESEARCH_HUB_C1_OVERLAY_ID;
  variant: ContentEvaluationVariant;
  grounding_verdict: 'pass' | 'fail';
  strategy_chain_verdict: 'pass' | 'fail';
  grounding_criteria: ContentCriterionResult[];
  strategy_chain_criteria: ContentCriterionResult[];
  chain_count: number;
  candidate_source_ids: string[];
  cited_candidate_source_ids: string[];
  tool_evidence_ids: string[];
  review_notes: string[];
}

export interface EvaluationContentInstructions {
  overlayId: typeof USER_RESEARCH_HUB_C1_OVERLAY_ID;
  prompt: string;
  rubricHash: string;
  sourceIds: string[];
  methodSourceIds: string[];
  skillDeltaIds: string[];
  skillDeltaText: string;
}

interface LoadedOverlayEntry {
  definition: OverlayEntryDefinition;
  metadata: ContentOverlayEntryMetadata;
  title: string;
  content: string;
}

export interface LoadedContentOverlay {
  manifest: OverlayManifestDefinition;
  rubric: OverlayRubricDefinition;
  prompt: string;
  manifestHash: string;
  contentSetHash: string;
  entries: LoadedOverlayEntry[];
  metadata(variant: ContentEvaluationVariant, skillIds: string[]): ContentEvaluationManifestMetadata;
  bindingFor(skillId: string): {
    sourceItems: KnowledgeContextItem[];
    sourceIds: string[];
    methodSourceIds: string[];
    skillDeltaIds: string[];
    skillDeltaText: string;
  } | undefined;
}

interface StrategyChainRecord {
  recommendation?: unknown;
  evidence_refs?: unknown;
  method_source_ids?: unknown;
  phenomenon?: unknown;
  claim_type?: unknown;
  problem_attribution?: unknown;
  insight?: unknown;
  strategy?: unknown;
  design_action?: unknown;
  priority?: unknown;
  metric?: unknown;
  validation_method?: unknown;
}

const EXPECTED_GROUNDING_CRITERIA = [
  'external_evidence_bound',
  'candidate_sources_method_only',
  'candidate_method_citation',
  'source_reference_integrity',
  'claim_type_explicit',
] as const;
const EXPECTED_STRATEGY_CRITERIA = [
  'recommendation_coverage',
  'evidence',
  'phenomenon',
  'problem_attribution',
  'insight',
  'strategy',
  'design_action',
  'priority',
  'metric',
  'validation',
] as const;
const CONTENT_ENTRY_KINDS = new Set<ContentOverlayEntryKind>(['method', 'asset', 'draft_skill', 'skill_delta']);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hash(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function stableHash(value: unknown): string {
  return hash(JSON.stringify(stableValue(value)));
}

function safePath(root: string, logicalPath: string): string {
  if (!logicalPath || isAbsolute(logicalPath) || logicalPath.includes('\\') || logicalPath.includes('\0')) {
    throw new Error(`content overlay path is not a safe repository-relative path: ${logicalPath}`);
  }
  const fullPath = resolve(root, ...logicalPath.split('/'));
  const rel = relative(root, fullPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`content overlay path escapes repository: ${logicalPath}`);
  }
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`content overlay path contains a symlink: ${logicalPath}`);
    }
  }
  const realRoot = realpathSync(root);
  const realFile = realpathSync(fullPath);
  const realRel = relative(realRoot, realFile);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || realRel.startsWith(sep)) {
    throw new Error(`content overlay path escapes repository: ${logicalPath}`);
  }
  return fullPath;
}

function readFrozen(root: string, reference: OverlayFileReference, label: string): string {
  if (!HASH_PATTERN.test(reference.artifact_hash)) throw new Error(`${label} has an invalid artifact hash`);
  const path = safePath(root, reference.path);
  const raw = readFileSync(path, 'utf8');
  const actual = hash(raw);
  if (actual !== reference.artifact_hash) {
    throw new Error(`${label} artifact hash drift: expected ${reference.artifact_hash}, got ${actual}`);
  }
  return raw;
}

function parseManifest(raw: string): OverlayManifestDefinition {
  const value: unknown = JSON.parse(raw);
  if (!record(value)
    || value.version !== 1
    || value.id !== USER_RESEARCH_HUB_C1_OVERLAY_ID
    || value.scope !== 'evaluation_only'
    || value.gate !== 'gate-3-pending'
    || value.production_search_allowed !== false
    || !record(value.prompt)
    || !record(value.rubric)
    || !record(value.fixed_task)
    || !record(value.production_baseline)
    || !Array.isArray(value.entries)
    || !Array.isArray(value.bindings)
    || !record(value.promotion_set)) {
    throw new Error('invalid User Research Hub C1 content overlay manifest');
  }
  return value as unknown as OverlayManifestDefinition;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}

function parseRubric(raw: string): OverlayRubricDefinition {
  const value: unknown = parseYaml(raw);
  if (!record(value)
    || value.version !== 1
    || value.id !== USER_RESEARCH_HUB_C1_OVERLAY_ID
    || value.scope !== 'evaluation_only'
    || !Array.isArray(value.grounding)
    || !Array.isArray(value.strategy_chain)) {
    throw new Error('invalid User Research Hub C1 evaluation rubric');
  }
  const rubric = value as unknown as OverlayRubricDefinition;
  const grounding = rubric.grounding.map(({ id }) => id);
  const strategy = rubric.strategy_chain.map(({ id }) => id);
  if (JSON.stringify(grounding) !== JSON.stringify(EXPECTED_GROUNDING_CRITERIA)
    || JSON.stringify(strategy) !== JSON.stringify(EXPECTED_STRATEGY_CRITERIA)) {
    throw new Error('User Research Hub C1 evaluation rubric criteria drift');
  }
  return rubric;
}

function targetFile(root: string, target: string): string {
  const path = safePath(root, target);
  return lstatSync(path).isDirectory() ? safePath(root, `${target}/SKILL.md`) : path;
}

function assertProductionBaseline(root: string, manifest: OverlayManifestDefinition): void {
  const baseline = manifest.production_baseline;
  for (const [path, expected, label] of [
    [baseline.planning_policy_path, baseline.planning_policy_hash, 'production planning policy'],
    [baseline.prompt_path, baseline.prompt_hash, 'production report prompt'],
    [baseline.rubric_path, baseline.rubric_hash, 'production report rubric'],
  ] as const) {
    const actual = hash(readFileSync(safePath(root, path)));
    if (actual !== expected) throw new Error(`${label} hash drift: expected ${expected}, got ${actual}`);
  }
  const policy = parseYaml(readFileSync(safePath(root, baseline.planning_policy_path), 'utf8')) as { candidate_generation_mode?: unknown };
  if (policy.candidate_generation_mode !== baseline.candidate_generation_mode || policy.candidate_generation_mode !== 'fixed') {
    throw new Error('C1 content evaluation requires production candidate_generation_mode to remain fixed');
  }
}

function loadIndex(root: string): Map<string, { source_path: string; status: string; content_hash?: string }> {
  const value: unknown = JSON.parse(readFileSync(safePath(root, 'knowledge-base/.index/knowledge.json'), 'utf8'));
  if (!Array.isArray(value)) throw new Error('knowledge index must be an array');
  return new Map(value.map((item) => {
    if (!record(item) || !nonBlank(item.id) || !nonBlank(item.source_path) || !nonBlank(item.status)) {
      throw new Error('knowledge index contains a malformed item');
    }
    return [item.id, {
      source_path: item.source_path,
      status: item.status,
      ...(nonBlank(item.content_hash) ? { content_hash: item.content_hash } : {}),
    }];
  }));
}

function loadSkillStatuses(root: string): Map<string, string> {
  const value = parseYaml(readFileSync(safePath(root, 'orchestrator/skill-registry.yaml'), 'utf8')) as { skills?: unknown };
  if (!Array.isArray(value.skills)) throw new Error('Skill Registry must contain skills');
  return new Map(value.skills.map((item) => {
    if (!record(item) || !nonBlank(item.id) || !nonBlank(item.status)) throw new Error('Skill Registry entry is malformed');
    return [item.id, item.status];
  }));
}

function metadataFor(definition: OverlayEntryDefinition): ContentOverlayEntryMetadata {
  return {
    id: definition.id,
    kind: definition.kind,
    path: definition.path,
    status: definition.status,
    sourceHash: definition.source_hash,
    contentHash: definition.content_hash,
    artifactHash: definition.artifact_hash,
    ...(definition.canonical_target ? { canonicalTarget: definition.canonical_target } : {}),
    ...(definition.canonical_hash ? { canonicalHash: definition.canonical_hash } : {}),
    ...(definition.kind === 'draft_skill' ? { registryStatus: 'draft' as const } : {}),
    ...(definition.kind === 'skill_delta' ? { runtimeConsumed: false as const } : {}),
  };
}

function validatePromotionSet(manifest: OverlayManifestDefinition): void {
  const byKind = (kind: ContentOverlayEntryKind): string[] => manifest.entries.filter((entry) => entry.kind === kind).map(({ id }) => id);
  const expected = {
    knowledge_candidate_ids: byKind('method'),
    asset_candidate_ids: byKind('asset'),
    draft_skill_ids: byKind('draft_skill'),
    skill_delta_ids: byKind('skill_delta'),
  };
  for (const [key, ids] of Object.entries(expected) as Array<[keyof typeof expected, string[]]>) {
    if (JSON.stringify(manifest.promotion_set[key]) !== JSON.stringify(ids)) {
      throw new Error(`content overlay promotion set drift: ${key}`);
    }
  }
}

function validateManifestCardinality(manifest: OverlayManifestDefinition): void {
  const counts = new Map<ContentOverlayEntryKind, number>();
  for (const entry of manifest.entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const expected: Record<ContentOverlayEntryKind, number> = { method: 15, asset: 1, draft_skill: 1, skill_delta: 2 };
  for (const [kind, count] of Object.entries(expected) as Array<[ContentOverlayEntryKind, number]>) {
    if (counts.get(kind) !== count) throw new Error(`content overlay requires exactly ${count} ${kind} entries`);
  }
}

function validateEntry(
  root: string,
  definition: OverlayEntryDefinition,
  index: Map<string, { source_path: string; status: string; content_hash?: string }>,
  skillStatuses: Map<string, string>,
): LoadedOverlayEntry {
  if (!CONTENT_ENTRY_KINDS.has(definition.kind)
    || !nonBlank(definition.id)
    || !HASH_PATTERN.test(definition.source_hash)
    || !HASH_PATTERN.test(definition.content_hash)
    || !HASH_PATTERN.test(definition.artifact_hash)) {
    throw new Error(`invalid content overlay entry: ${definition.id}`);
  }
  const raw = readFrozen(root, { path: definition.path, artifact_hash: definition.artifact_hash }, `content overlay entry ${definition.id}`);
  const parsed = parseFrontmatter(raw);
  if (contentHash(parsed.content) !== definition.content_hash) {
    throw new Error(`content hash drift for overlay entry ${definition.id}`);
  }

  if (definition.kind === 'skill_delta') {
    if (parsed.frontmatter.status !== 'draft'
      || parsed.frontmatter.runtime_consumed !== false
      || parsed.frontmatter.distribution_scope !== 'evaluation_only'
      || parsed.frontmatter.source_hash !== definition.source_hash
      || parsed.frontmatter.canonical_target !== definition.canonical_target
      || parsed.frontmatter.canonical_hash !== definition.canonical_hash
      || !definition.canonical_target
      || !definition.canonical_hash) {
      throw new Error(`invalid evaluation-only Skill delta ${definition.id}`);
    }
    const actualCanonicalHash = hash(readFileSync(targetFile(root, definition.canonical_target)));
    if (actualCanonicalHash !== definition.canonical_hash) {
      throw new Error(`canonical Skill changed beneath delta ${definition.id}`);
    }
  } else {
    if (parsed.frontmatter.status !== 'candidate'
      || parsed.frontmatter.distribution_scope !== 'evaluation_only'
      || parsed.frontmatter.hub_source_hash !== definition.source_hash
      || parsed.frontmatter.content_hash !== definition.content_hash
      || parsed.frontmatter.id !== definition.id) {
      throw new Error(`invalid frozen candidate entry ${definition.id}`);
    }
    if (definition.kind === 'method') {
      const indexed = index.get(definition.id);
      const sourcePath = definition.path.replace(/^knowledge-base\//u, '');
      if (!indexed
        || indexed.status !== 'candidate'
        || indexed.source_path !== sourcePath
        || indexed.content_hash !== definition.content_hash) {
        throw new Error(`candidate method is missing from the Evaluation index: ${definition.id}`);
      }
    }
    if (definition.kind === 'draft_skill') {
      const registryId = String(parsed.frontmatter.name ?? '');
      if (registryId !== 'solution-generation' || skillStatuses.get(registryId) !== 'draft') {
        throw new Error('solution-generation must remain a draft Skill');
      }
    }
  }

  return {
    definition,
    metadata: metadataFor(definition),
    title: String(parsed.frontmatter.title ?? parsed.frontmatter.name ?? definition.id),
    content: parsed.content,
  };
}

function deltaBody(content: string): string {
  const marker = '## Proposed canonical delta';
  const start = content.indexOf(marker);
  if (start < 0) throw new Error('Skill delta is missing Proposed canonical delta');
  return content.slice(start + marker.length).trim();
}

function knowledgeItem(entry: LoadedOverlayEntry): KnowledgeContextItem {
  return {
    source_id: entry.definition.id,
    title: entry.title,
    source_path: entry.definition.path.replace(/^knowledge-base\//u, ''),
    content_hash: entry.definition.content_hash,
    status: entry.definition.status,
    role: 'candidate',
    content: entry.content,
  };
}

export function loadContentOverlay(
  id = USER_RESEARCH_HUB_C1_OVERLAY_ID,
  options: { root?: string; manifestPath?: string } = {},
): LoadedContentOverlay {
  if (id !== USER_RESEARCH_HUB_C1_OVERLAY_ID) throw new Error(`unknown content overlay: ${id}`);
  const root = resolve(options.root ?? getConfigRoot());
  const manifestPath = options.manifestPath ?? `evaluations/skills/content/${id}.json`;
  const manifestRaw = readFileSync(safePath(root, manifestPath), 'utf8');
  const manifest = parseManifest(manifestRaw);
  validateManifestCardinality(manifest);
  validatePromotionSet(manifest);
  assertUnique(manifest.entries.map(({ id: entryId }) => entryId), 'content overlay entry IDs');
  assertUnique(manifest.entries.map(({ path }) => path), 'content overlay entry paths');
  assertUnique(manifest.bindings.map(({ skill_id }) => skill_id), 'content overlay Skill bindings');

  const prompt = readFrozen(root, manifest.prompt, 'content evaluation prompt');
  const rubric = parseRubric(readFrozen(root, manifest.rubric, 'content evaluation rubric'));
  const fixedCaseHash = hash(readFileSync(safePath(root, manifest.fixed_task.case_path)));
  if (fixedCaseHash !== manifest.fixed_task.case_hash) throw new Error('fixed content evaluation case hash drift');
  assertProductionBaseline(root, manifest);

  const index = loadIndex(root);
  const skillStatuses = loadSkillStatuses(root);
  const entries = manifest.entries.map((entry) => validateEntry(root, entry, index, skillStatuses));
  const entryById = new Map(entries.map((entry) => [entry.definition.id, entry]));
  const boundEntryIds = new Set<string>();
  for (const binding of manifest.bindings) {
    if (skillStatuses.get(binding.skill_id) !== 'active') throw new Error(`overlay target is not an active Skill: ${binding.skill_id}`);
    assertUnique([...binding.content_ids, ...binding.skill_delta_ids], `overlay binding references for ${binding.skill_id}`);
    for (const contentId of binding.content_ids) {
      const entry = entryById.get(contentId);
      if (!entry || entry.definition.kind === 'skill_delta') throw new Error(`invalid content binding ${binding.skill_id}:${contentId}`);
      boundEntryIds.add(contentId);
    }
    for (const deltaId of binding.skill_delta_ids) {
      if (entryById.get(deltaId)?.definition.kind !== 'skill_delta') throw new Error(`invalid Skill delta binding ${binding.skill_id}:${deltaId}`);
      boundEntryIds.add(deltaId);
    }
  }
  const unbound = manifest.entries.map(({ id: entryId }) => entryId).filter((entryId) => !boundEntryIds.has(entryId));
  if (unbound.length > 0) throw new Error(`content overlay entries have no evaluation binding: ${unbound.join(', ')}`);

  const manifestHash = hash(manifestRaw);
  const contentSetHash = stableHash(entries.map(({ metadata }) => metadata));
  return {
    manifest,
    rubric,
    prompt,
    manifestHash,
    contentSetHash,
    entries,
    metadata(variant, skillIds) {
      const selected = new Set(skillIds);
      const bindings = manifest.bindings.filter(({ skill_id }) => selected.has(skill_id));
      return {
        overlayId: manifest.id,
        overlayVersion: manifest.version,
        variant,
        scope: manifest.scope,
        gate: manifest.gate,
        manifestHash,
        contentSetHash,
        promptHash: manifest.prompt.artifact_hash,
        rubricHash: manifest.rubric.artifact_hash,
        criteria: {
          grounding: rubric.grounding.map((item) => ({ ...item })),
          strategyChain: rubric.strategy_chain.map((item) => ({ ...item })),
        },
        fixedTaskSkillId: manifest.fixed_task.skill_id,
        fixedTaskCaseHash: manifest.fixed_task.case_hash,
        productionSearchUsed: false,
        candidateGenerationMode: 'fixed',
        entries: entries.map(({ metadata }) => metadata),
        promotionSet: {
          knowledgeCandidateIds: [...manifest.promotion_set.knowledge_candidate_ids],
          assetCandidateIds: [...manifest.promotion_set.asset_candidate_ids],
          draftSkillIds: [...manifest.promotion_set.draft_skill_ids],
          skillDeltaIds: [...manifest.promotion_set.skill_delta_ids],
        },
        injectedSourceIds: variant === 'enhanced'
          ? [...new Set(bindings.flatMap(({ content_ids }) => content_ids))]
          : [],
        appliedSkillDeltaIds: variant === 'enhanced'
          ? [...new Set(bindings.flatMap(({ skill_delta_ids }) => skill_delta_ids))]
          : [],
        productionBaseline: {
          planningPolicyHash: manifest.production_baseline.planning_policy_hash,
          promptHash: manifest.production_baseline.prompt_hash,
          rubricHash: manifest.production_baseline.rubric_hash,
        },
      };
    },
    bindingFor(skillId) {
      const binding = manifest.bindings.find(({ skill_id }) => skill_id === skillId);
      if (!binding) return undefined;
      const contentEntries = binding.content_ids.map((contentId) => entryById.get(contentId)!);
      const deltaEntries = binding.skill_delta_ids.map((deltaId) => entryById.get(deltaId)!);
      return {
        sourceItems: contentEntries.map(knowledgeItem),
        sourceIds: [...binding.content_ids],
        methodSourceIds: contentEntries.filter(({ definition }) => definition.kind === 'method').map(({ definition }) => definition.id),
        skillDeltaIds: [...binding.skill_delta_ids],
        skillDeltaText: deltaEntries.map(({ definition, content }) => `### ${definition.id}\n${deltaBody(content)}`).join('\n\n'),
      };
    },
  };
}

export function addContentOverlayToKnowledge(
  context: KnowledgeContext,
  retrieval: RetrievalRecord,
  overlay: LoadedContentOverlay,
  skillId: string,
): { knowledgeContext: KnowledgeContext; retrieval: RetrievalRecord; instructions: EvaluationContentInstructions } | undefined {
  if (context.mode !== 'gold' || retrieval.mode !== 'gold') {
    throw new Error('content-enhanced evaluation requires deterministic gold KB mode');
  }
  const binding = overlay.bindingFor(skillId);
  if (!binding) return undefined;
  const existingIds = new Set(context.items.map(({ source_id }) => source_id));
  const duplicate = binding.sourceItems.find(({ source_id }) => existingIds.has(source_id));
  if (duplicate) throw new Error(`content overlay source collides with baseline KB context: ${duplicate.source_id}`);
  return {
    knowledgeContext: {
      ...context,
      selected_source_ids: [...context.selected_source_ids, ...binding.sourceIds],
      items: [...context.items, ...binding.sourceItems],
    },
    retrieval: {
      ...retrieval,
      candidate_source_ids: [...retrieval.candidate_source_ids, ...binding.sourceIds],
      selected_source_ids: [...retrieval.selected_source_ids, ...binding.sourceIds],
    },
    instructions: {
      overlayId: overlay.manifest.id,
      prompt: overlay.prompt,
      rubricHash: overlay.manifest.rubric.artifact_hash,
      sourceIds: binding.sourceIds,
      methodSourceIds: binding.methodSourceIds,
      skillDeltaIds: binding.skillDeltaIds,
      skillDeltaText: binding.skillDeltaText,
    },
  };
}

function collectIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, ids);
    return;
  }
  if (!record(value)) return;
  if (nonBlank(value.id)) ids.add(value.id);
  for (const child of Object.values(value)) collectIds(child, ids);
}

function strategyChains(output: unknown): StrategyChainRecord[] {
  if (!record(output) || !record(output.payload) || !Array.isArray(output.payload.strategy_chains)) return [];
  return output.payload.strategy_chains.filter(record) as StrategyChainRecord[];
}

function values(value: unknown): string[] {
  return stringArray(value) ? value.filter((item) => item.trim().length > 0) : [];
}

function allChains(chains: StrategyChainRecord[], predicate: (chain: StrategyChainRecord) => boolean): boolean {
  return chains.length > 0 && chains.every(predicate);
}

function criterion(id: string, passed: boolean, evidence: string[], applicable = true): ContentCriterionResult {
  return { id, status: applicable ? (passed ? 'pass' : 'fail') : 'not_applicable', evidence };
}

function pointer(index: number, field: string): string {
  return `/payload/strategy_chains/${index}/${field}`;
}

export function assessContentEvaluation(
  loadedCase: LoadedEvaluationCase,
  output: Record<string, unknown> | undefined,
  overlay: LoadedContentOverlay,
  variant: ContentEvaluationVariant,
): ContentEvaluationAssessment {
  const binding = overlay.bindingFor(loadedCase.data.skill_id);
  const candidateIds = binding?.sourceIds ?? [];
  const candidateIdSet = new Set(candidateIds);
  const methodIdSet = new Set(binding?.methodSourceIds ?? []);
  const toolEvidenceIdSet = new Set<string>();
  collectIds(loadedCase.data.tool_outputs, toolEvidenceIdSet);
  const chains = strategyChains(output);
  const recommendations = record(output) && stringArray(output.recommendations) ? output.recommendations : [];
  const allEvidenceRefs = chains.flatMap(({ evidence_refs }) => values(evidence_refs));
  const allMethodRefs = chains.flatMap(({ method_source_ids }) => values(method_source_ids));
  const unknownEvidenceRefs = allEvidenceRefs.filter((id) => !toolEvidenceIdSet.has(id));
  const unknownMethodRefs = allMethodRefs.filter((id) => !methodIdSet.has(id));
  const candidateIdsUsedAsEvidence = allEvidenceRefs.filter((id) => candidateIdSet.has(id));
  const citedCandidateIds = [...new Set(allMethodRefs.filter((id) => methodIdSet.has(id)))];
  const enhanced = variant === 'enhanced' && binding !== undefined;

  const groundingCriteria = [
    criterion(
      'external_evidence_bound',
      allChains(chains, (chain) => values(chain.evidence_refs).some((id) => toolEvidenceIdSet.has(id))),
      chains.flatMap((_chain, index) => [pointer(index, 'evidence_refs')]),
    ),
    criterion(
      'candidate_sources_method_only',
      candidateIdsUsedAsEvidence.length === 0 && unknownMethodRefs.length === 0,
      candidateIdsUsedAsEvidence.length > 0 ? candidateIdsUsedAsEvidence : citedCandidateIds,
      enhanced,
    ),
    criterion(
      'candidate_method_citation',
      allChains(chains, (chain) => values(chain.method_source_ids).some((id) => methodIdSet.has(id))),
      citedCandidateIds,
      enhanced,
    ),
    criterion(
      'source_reference_integrity',
      chains.length > 0 && unknownEvidenceRefs.length === 0 && (!enhanced || unknownMethodRefs.length === 0),
      [...new Set([...unknownEvidenceRefs, ...unknownMethodRefs])],
    ),
    criterion(
      'claim_type_explicit',
      allChains(chains, ({ claim_type }) => claim_type === 'observed_fact' || claim_type === 'inference' || claim_type === 'hypothesis'),
      chains.flatMap(({ claim_type }, index) => nonBlank(claim_type) ? [`${pointer(index, 'claim_type')}=${claim_type}`] : []),
    ),
  ];

  const recommendationCounts = new Map<string, number>();
  for (const chain of chains) {
    if (nonBlank(chain.recommendation)) recommendationCounts.set(chain.recommendation, (recommendationCounts.get(chain.recommendation) ?? 0) + 1);
  }
  const recommendationCoverage = recommendations.length > 0
    && recommendations.length === chains.length
    && recommendations.every((item) => recommendationCounts.get(item) === 1);
  const fields: Array<[string, keyof StrategyChainRecord]> = [
    ['evidence', 'evidence_refs'],
    ['phenomenon', 'phenomenon'],
    ['problem_attribution', 'problem_attribution'],
    ['insight', 'insight'],
    ['strategy', 'strategy'],
    ['design_action', 'design_action'],
    ['metric', 'metric'],
    ['validation', 'validation_method'],
  ];
  const strategyCriteria: ContentCriterionResult[] = [
    criterion('recommendation_coverage', recommendationCoverage, recommendations),
    ...fields.map(([id, field]) => criterion(
      id,
      allChains(chains, (chain) => field === 'evidence_refs' ? values(chain[field]).length > 0 : nonBlank(chain[field])),
      chains.flatMap((_chain, index) => [pointer(index, field)]),
    )),
    criterion(
      'priority',
      allChains(chains, (chain) => {
        const priority = record(chain.priority) ? chain.priority : undefined;
        return Boolean(priority
          && nonBlank(priority.level)
          && nonBlank(priority.user_impact)
          && nonBlank(priority.business_impact)
          && nonBlank(priority.cost_or_risk));
      }),
      chains.flatMap((_chain, index) => [pointer(index, 'priority')]),
    ),
  ];
  strategyCriteria.sort((left, right) => EXPECTED_STRATEGY_CRITERIA.indexOf(left.id as typeof EXPECTED_STRATEGY_CRITERIA[number]) - EXPECTED_STRATEGY_CRITERIA.indexOf(right.id as typeof EXPECTED_STRATEGY_CRITERIA[number]));

  const failedGrounding = groundingCriteria.filter(({ status }) => status === 'fail').map(({ id }) => id);
  const failedStrategy = strategyCriteria.filter(({ status }) => status === 'fail').map(({ id }) => id);
  return {
    overlay_id: overlay.manifest.id,
    variant,
    grounding_verdict: failedGrounding.length === 0 ? 'pass' : 'fail',
    strategy_chain_verdict: failedStrategy.length === 0 ? 'pass' : 'fail',
    grounding_criteria: groundingCriteria,
    strategy_chain_criteria: strategyCriteria,
    chain_count: chains.length,
    candidate_source_ids: candidateIds,
    cited_candidate_source_ids: citedCandidateIds,
    tool_evidence_ids: [...toolEvidenceIdSet],
    review_notes: [
      ...failedGrounding.map((id) => `grounding criterion failed: ${id}`),
      ...failedStrategy.map((id) => `strategy-chain criterion failed: ${id}`),
    ],
  };
}
