import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  InputSourceKind,
  MissingInputPolicy,
  OrchestrationMode,
  SkillDefinition,
  SkillInputDefinition,
  SkillKnowledgeDefinition,
  SkillResourceDefinition,
  SolutionDefinition,
  SolutionSkillDefinition,
} from '../../../../packages/api-contract/skill-native.ts';
import { parseFrontmatter } from '../knowledge/frontmatter.ts';
import { getEntry, loadRuntimeKnowledgeIndex } from '../knowledge/index.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';

const INPUT_SOURCES = new Set<InputSourceKind>([
  'conversation',
  'upload',
  'database',
  'knowledge',
  'tool',
]);
const MISSING_POLICIES = new Set<MissingInputPolicy>(['stop', 'replace', 'gap']);

export interface UnavailableSkill {
  id: string;
  sourcePath: string;
  reason: string;
}

export interface SkillNativeCatalogSnapshot {
  skills: SkillDefinition[];
  unavailableSkills: UnavailableSkill[];
  solutions: SolutionDefinition[];
  invalidSolutions: Array<{ sourcePath: string; reason: string }>;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates`);
  return normalized;
}

function hash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function filesNamed(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function parseInput(value: unknown, index: number): SkillInputDefinition {
  const input = record(value, `native_delivery.inputs[${index}]`);
  const sources = stringArray(input.accepted_sources, `native_delivery.inputs[${index}].accepted_sources`);
  if (sources.some((source) => !INPUT_SOURCES.has(source as InputSourceKind))) {
    throw new Error(`native_delivery.inputs[${index}].accepted_sources contains an unknown source`);
  }
  const missingPolicy = stringValue(
    input.missing_policy,
    `native_delivery.inputs[${index}].missing_policy`,
  );
  if (!MISSING_POLICIES.has(missingPolicy as MissingInputPolicy)) {
    throw new Error(`native_delivery.inputs[${index}].missing_policy is unsupported`);
  }
  const toolIds = input.tool_ids === undefined
    ? []
    : stringArray(input.tool_ids, `native_delivery.inputs[${index}].tool_ids`);
  if (toolIds.length > 0 && !sources.includes('tool')) {
    throw new Error(`native_delivery.inputs[${index}].tool_ids requires tool in accepted_sources`);
  }
  return {
    id: stringValue(input.id, `native_delivery.inputs[${index}].id`),
    label: stringValue(input.label, `native_delivery.inputs[${index}].label`),
    description: stringValue(input.description, `native_delivery.inputs[${index}].description`),
    required: booleanValue(input.required, `native_delivery.inputs[${index}].required`),
    multiple: input.multiple === undefined
      ? false
      : booleanValue(input.multiple, `native_delivery.inputs[${index}].multiple`),
    acceptedSources: sources as InputSourceKind[],
    toolIds,
    question: stringValue(input.question, `native_delivery.inputs[${index}].question`),
    missingPolicy: missingPolicy as MissingInputPolicy,
  };
}

function parseResources(value: unknown, field: string): SkillResourceDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const resources = value.map((item, index) => {
    const resource = record(item, `${field}[${index}]`);
    return {
      id: stringValue(resource.id, `${field}[${index}].id`),
      required: booleanValue(resource.required, `${field}[${index}].required`),
    };
  });
  if (new Set(resources.map(({ id }) => id)).size !== resources.length) {
    throw new Error(`${field} must not contain duplicate ids`);
  }
  return resources;
}

function parseKnowledgeResources(
  value: unknown,
  root: string,
): SkillKnowledgeDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('native_delivery.knowledge must be an array');
  const knowledgeRoot = resolve(root, 'knowledge-base');
  const index = loadRuntimeKnowledgeIndex(knowledgeRoot);
  const resources = value.map((item, position) => {
    const field = `native_delivery.knowledge[${position}]`;
    const resource = record(item, field);
    const id = stringValue(resource.id, `${field}.id`);
    const required = booleanValue(resource.required, `${field}.required`);
    const indexed = index.find((entry) => entry.id === id || entry.source_path === id);
    if (!indexed) {
      if (required) throw new Error(`${field} references unavailable Knowledge ${id}`);
      return null;
    }
    const entry = getEntry(indexed.id, knowledgeRoot);
    if (!entry) {
      if (required) throw new Error(`${field} references unavailable Knowledge ${id}`);
      return null;
    }
    const title = typeof entry.frontmatter.title === 'string' && entry.frontmatter.title.trim()
      ? entry.frontmatter.title.trim()
      : indexed.title;
    return {
      id: indexed.id,
      required,
      title,
      sourcePath: indexed.source_path,
      contentHash: indexed.content_hash,
      status: indexed.status as 'approved' | 'draft',
      content: entry.content,
      ...(resource.input_id === undefined
        ? {}
        : { inputId: stringValue(resource.input_id, `${field}.input_id`) }),
    };
  }).filter((item): item is SkillKnowledgeDefinition => item !== null);
  if (new Set(resources.map(({ id }) => id)).size !== resources.length) {
    throw new Error('native_delivery.knowledge must not contain duplicate ids');
  }
  return resources;
}

function parseSkill(
  root: string,
  path: string,
  activeToolIds: ReadonlySet<string>,
): SkillDefinition | UnavailableSkill {
  const sourcePath = portablePath(root, path);
  let fallbackId = sourcePath.replace(/\/SKILL\.md$/u, '').split('/').at(-1) ?? sourcePath;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = parseFrontmatter(raw);
    if (typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name.trim()) {
      fallbackId = parsed.frontmatter.name.trim();
    }
    const native = record(parsed.frontmatter.native_delivery, 'native_delivery');
    if (native.version !== 1) throw new Error('native_delivery.version must equal 1');
    const id = stringValue(native.id, 'native_delivery.id');
    const inputs = Array.isArray(native.inputs)
      ? native.inputs.map(parseInput)
      : (() => { throw new Error('native_delivery.inputs must be an array'); })();
    if (new Set(inputs.map((input) => input.id)).size !== inputs.length) {
      throw new Error('native_delivery.inputs must not contain duplicate ids');
    }
    const report = record(native.report, 'native_delivery.report');
    const sections = stringArray(report.sections, 'native_delivery.report.sections');
    if (sections.length === 0) throw new Error('native_delivery.report.sections must not be empty');
    const knowledge = parseKnowledgeResources(native.knowledge, root);
    const tools = parseResources(native.tools, 'native_delivery.tools');
    const declaredToolIds = new Set(tools.map(({ id: toolId }) => toolId));
    for (const input of inputs) {
      if (input.acceptedSources.includes('tool') && input.toolIds.length === 0) {
        throw new Error(`input ${input.id} accepts tool but does not declare tool_ids`);
      }
      const undeclaredTool = input.toolIds.find((toolId) => !declaredToolIds.has(toolId));
      if (undeclaredTool) throw new Error(`input ${input.id} references undeclared Tool ${undeclaredTool}`);
    }
    for (const item of knowledge) {
      if (item.inputId === undefined) continue;
      const declaredInput = inputs.find(({ id: inputId }) => inputId === item.inputId);
      if (!declaredInput) throw new Error(`Knowledge ${item.id} references unknown input ${item.inputId}`);
      if (!declaredInput.acceptedSources.includes('knowledge')) {
        throw new Error(`input ${item.inputId} does not accept Knowledge ${item.id}`);
      }
    }
    const unavailableTool = tools.find(({ id: toolId, required }) => required && !activeToolIds.has(toolId));
    if (unavailableTool) throw new Error(`native_delivery.tools references inactive Tool ${unavailableTool.id}`);
    return {
      version: 'skill-definition-v1',
      id,
      name: stringValue(parsed.frontmatter.name, 'name'),
      description: stringValue(parsed.frontmatter.description, 'description'),
      whenToUse: stringValue(
        parsed.frontmatter.when_to_use ?? parsed.frontmatter.description,
        'when_to_use or description',
      ),
      inputs,
      knowledge,
      tools,
      report: {
        title: stringValue(report.title, 'native_delivery.report.title'),
        summaryInstruction: stringValue(
          report.summary_instruction,
          'native_delivery.report.summary_instruction',
        ),
        sections,
      },
      allowPartial: booleanValue(native.allow_partial, 'native_delivery.allow_partial'),
      body: stringValue(parsed.content, 'body'),
      sourcePath,
      contentHash: hash(`${raw}\n${knowledge.map(({ id: knowledgeId, contentHash }) => `${knowledgeId}:${contentHash}`).join('\n')}`),
    };
  } catch (error) {
    return {
      id: fallbackId,
      sourcePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertSharedInputSources(
  solution: SolutionDefinition,
  skills: ReadonlyMap<string, SkillDefinition>,
): void {
  const contractsByInput = new Map<string, { sources: Set<InputSourceKind>; multiple: boolean }>();
  const possibleSkillIds = new Set(solution.skills.flatMap(({ skillId, replacementSkillId }) => (
    replacementSkillId ? [skillId, replacementSkillId] : [skillId]
  )));
  for (const skillId of possibleSkillIds) {
    const skill = skills.get(skillId);
    if (!skill) continue;
    for (const input of skill.inputs) {
      const current = contractsByInput.get(input.id);
      if (!current) {
        contractsByInput.set(input.id, { sources: new Set(input.acceptedSources), multiple: input.multiple });
        continue;
      }
      if (current.multiple !== input.multiple) {
        throw new Error(`shared input ${input.id} has inconsistent cardinality`);
      }
      const shared = new Set([...current.sources].filter((source) => input.acceptedSources.includes(source)));
      if (shared.size === 0) {
        throw new Error(`shared input ${input.id} has no source accepted by every consuming Skill`);
      }
      current.sources = shared;
    }
  }
}

function parseSolutionSkill(value: unknown, index: number): SolutionSkillDefinition {
  const skill = record(value, `skills[${index}]`);
  const failurePolicy = stringValue(skill.failure_policy, `skills[${index}].failure_policy`);
  if (failurePolicy !== 'stop' && failurePolicy !== 'replace' && failurePolicy !== 'gap') {
    throw new Error(`skills[${index}].failure_policy must be stop, replace, or gap`);
  }
  const replacementSkillId = skill.replacement_skill_id === undefined
    ? undefined
    : stringValue(skill.replacement_skill_id, `skills[${index}].replacement_skill_id`);
  if (failurePolicy === 'replace' && !replacementSkillId) {
    throw new Error(`skills[${index}].replacement_skill_id is required for replace`);
  }
  if (failurePolicy !== 'replace' && replacementSkillId) {
    throw new Error(`skills[${index}].replacement_skill_id is allowed only for replace`);
  }
  return {
    skillId: stringValue(skill.skill_id, `skills[${index}].skill_id`),
    dependsOn: stringArray(skill.depends_on ?? [], `skills[${index}].depends_on`),
    failurePolicy,
    ...(replacementSkillId ? { replacementSkillId } : {}),
  };
}

function assertReplacementContracts(
  solution: SolutionDefinition,
  skills: ReadonlyMap<string, SkillDefinition>,
): void {
  const activeIds = new Set(solution.skills.map(({ skillId }) => skillId));
  for (const definition of solution.skills) {
    const primary = skills.get(definition.skillId);
    if (!primary) continue;
    if (primary.inputs.some(({ missingPolicy }) => missingPolicy === 'replace') && definition.failurePolicy !== 'replace') {
      throw new Error(`skill ${primary.id} has replace input but no replacement_skill_id`);
    }
    if (!definition.replacementSkillId) continue;
    if (definition.replacementSkillId === definition.skillId) {
      throw new Error(`skill ${definition.skillId} cannot replace itself`);
    }
    if (activeIds.has(definition.replacementSkillId)) {
      throw new Error(`replacement skill ${definition.replacementSkillId} must not also be an active solution skill`);
    }
    const replacement = skills.get(definition.replacementSkillId);
    if (!replacement) throw new Error(`replacement skill ${definition.replacementSkillId} is unavailable`);
    if (replacement.inputs.some(({ missingPolicy }) => missingPolicy === 'replace')) {
      throw new Error(`replacement skill ${replacement.id} cannot require another replacement`);
    }
    for (const input of primary.inputs.filter(({ missingPolicy }) => missingPolicy === 'stop')) {
      if (!replacement.inputs.some(({ id }) => id === input.id)) {
        throw new Error(`replacement skill ${replacement.id} does not accept required input ${input.id}`);
      }
    }
    for (const input of replacement.inputs) {
      const existing = primary.inputs.find(({ id }) => id === input.id);
      if (!existing) {
        if (input.required || input.missingPolicy !== 'gap') {
          throw new Error(`replacement skill ${replacement.id} introduces unsupported input ${input.id}`);
        }
        continue;
      }
      if (
        (input.required && !existing.required)
        || (input.missingPolicy === 'stop' && existing.missingPolicy !== 'stop')
      ) {
        throw new Error(`replacement input ${input.id} is stricter than the primary input`);
      }
      if (existing.multiple !== input.multiple) {
        throw new Error(`replacement input ${input.id} has inconsistent cardinality`);
      }
      if (existing.acceptedSources.some((source) => !input.acceptedSources.includes(source))) {
        throw new Error(`replacement input ${input.id} does not accept every primary source`);
      }
    }
  }
}

function parseSolution(root: string, path: string): SolutionDefinition {
  const sourcePath = portablePath(root, path);
  const raw = readFileSync(path, 'utf8');
  const value = record(parseYaml(raw), sourcePath);
  if (value.version !== 1) throw new Error('version must equal 1');
  const mode = stringValue(value.mode, 'mode');
  if (mode !== 'single_skill' && mode !== 'multi_skill') throw new Error('mode is unsupported');
  if (!Array.isArray(value.skills) || value.skills.length === 0) throw new Error('skills must be non-empty');
  const skills = value.skills.map(parseSolutionSkill);
  const skillIds = skills.map(({ skillId }) => skillId);
  if (new Set(skillIds).size !== skillIds.length) throw new Error('skills must not contain duplicate skill ids');
  if (mode === 'single_skill' && skills.length !== 1) throw new Error('single_skill solution must contain one skill');
  if (mode === 'multi_skill' && skills.length < 2) throw new Error('multi_skill solution must contain at least two skills');
  for (const skill of skills) {
    if (skill.dependsOn.includes(skill.skillId)) throw new Error(`${skill.skillId} cannot depend on itself`);
    for (const dependency of skill.dependsOn) {
      if (!skillIds.includes(dependency)) throw new Error(`${skill.skillId} depends on unknown skill ${dependency}`);
    }
  }
  const finalReportSkillId = stringValue(value.final_report_skill_id, 'final_report_skill_id');
  if (!skillIds.includes(finalReportSkillId)) throw new Error('final_report_skill_id is not in skills');
  return {
    version: 'solution-definition-v1',
    id: stringValue(value.id, 'id'),
    title: stringValue(value.title, 'title'),
    description: stringValue(value.description, 'description'),
    whenToUse: stringValue(value.when_to_use, 'when_to_use'),
    mode: mode as OrchestrationMode,
    recommended: value.recommended === undefined ? false : booleanValue(value.recommended, 'recommended'),
    skills,
    finalReportSkillId,
    sourcePath,
    contentHash: hash(raw),
  };
}

function assertAcyclic(solution: SolutionDefinition): void {
  const byId = new Map(solution.skills.map((skill) => [skill.skillId, skill]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (skillId: string): void => {
    if (visiting.has(skillId)) throw new Error(`solution ${solution.id} contains a dependency cycle`);
    if (visited.has(skillId)) return;
    visiting.add(skillId);
    for (const dependency of byId.get(skillId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(skillId);
    visited.add(skillId);
  };
  for (const skill of solution.skills) visit(skill.skillId);
}

function assertFinalReachability(solution: SolutionDefinition): void {
  if (solution.mode !== 'multi_skill') return;
  const byId = new Map(solution.skills.map((skill) => [skill.skillId, skill]));
  const reachable = new Set<string>();
  const visit = (skillId: string): void => {
    for (const dependency of byId.get(skillId)?.dependsOn ?? []) {
      if (reachable.has(dependency)) continue;
      reachable.add(dependency);
      visit(dependency);
    }
  };
  visit(solution.finalReportSkillId);
  const disconnected = solution.skills.find(({ skillId }) => (
    skillId !== solution.finalReportSkillId && !reachable.has(skillId)
  ));
  if (disconnected) {
    throw new Error(`final report skill does not depend on ${disconnected.skillId}`);
  }
}

export class SkillNativeCatalog {
  constructor(private readonly root = getConfigRoot()) {}

  load(): SkillNativeCatalogSnapshot {
    const toolRegistryPath = resolve(this.root, 'orchestrator', 'tool-registry.yaml');
    const activeToolIds = existsSync(toolRegistryPath)
      ? new Set((record(parseYaml(readFileSync(toolRegistryPath, 'utf8')), 'tool registry').tools as unknown[] ?? [])
        .map((item, index) => record(item, `tool registry tools[${index}]`))
        .filter(({ status }) => status === 'active')
        .map(({ id }, index) => stringValue(id, `tool registry active tools[${index}].id`)))
      : new Set<string>();
    const paths = [
      ...filesNamed(resolve(this.root, 'skills'), 'SKILL.md'),
      ...filesNamed(resolve(this.root, 'knowledge-base', 'skills'), 'SKILL.md'),
    ];
    const parsed = paths.map((path) => parseSkill(this.root, path, activeToolIds));
    const skills = parsed.filter((item): item is SkillDefinition => 'version' in item);
    const unavailableSkills = parsed.filter((item): item is UnavailableSkill => !('version' in item));
    const duplicateIds = new Set(
      skills.map(({ id }) => id).filter((id, index, ids) => ids.indexOf(id) !== index),
    );
    const uniqueSkills = skills.filter((skill) => !duplicateIds.has(skill.id));
    for (const skill of skills.filter(({ id }) => duplicateIds.has(id))) {
      unavailableSkills.push({
        id: skill.id,
        sourcePath: skill.sourcePath,
        reason: `duplicate native_delivery.id ${skill.id}`,
      });
    }
    const availableSkills = new Map(uniqueSkills.map((skill) => [skill.id, skill]));
    const availableIds = new Set(availableSkills.keys());
    const solutionRoot = resolve(this.root, 'orchestrator', 'solutions');
    const solutions: SolutionDefinition[] = [];
    const invalidSolutions: Array<{ sourcePath: string; reason: string }> = [];
    if (existsSync(solutionRoot)) {
      for (const entry of readdirSync(solutionRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || (extname(entry.name) !== '.yaml' && extname(entry.name) !== '.yml')) continue;
        const path = join(solutionRoot, entry.name);
        try {
          if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(`${realpathSync(solutionRoot)}${sep}`)) {
            throw new Error('solution path escapes its root');
          }
          const solution = parseSolution(this.root, path);
          assertAcyclic(solution);
          assertFinalReachability(solution);
          const unavailable = solution.skills.find(({ skillId }) => !availableIds.has(skillId));
          if (unavailable) throw new Error(`skill ${unavailable.skillId} is unavailable`);
          assertReplacementContracts(solution, availableSkills);
          assertSharedInputSources(solution, availableSkills);
          solutions.push(solution);
        } catch (error) {
          invalidSolutions.push({
            sourcePath: portablePath(this.root, path),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const duplicateSolutionIds = new Set(
      solutions.map(({ id }) => id).filter((id, index, ids) => ids.indexOf(id) !== index),
    );
    for (const solution of solutions.filter(({ id }) => duplicateSolutionIds.has(id))) {
      invalidSolutions.push({ sourcePath: solution.sourcePath, reason: `duplicate solution id ${solution.id}` });
    }
    return {
      skills: uniqueSkills,
      unavailableSkills: unavailableSkills.sort((a, b) => a.id.localeCompare(b.id)),
      solutions: solutions.filter(({ id }) => !duplicateSolutionIds.has(id)),
      invalidSolutions,
    };
  }
}
