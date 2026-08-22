import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { EvidenceClass } from '../../../../packages/api-contract/research-deliverable.ts';

// 配置层统一读取入口。配置是 git/YAML 真相源,不入 DB。
// linter 与 skill-loader 共用此模块,避免重复解析逻辑。
// 默认根 = process.cwd()(命令经 pnpm scripts 从项目根运行);
// 测试可用 setConfigRoot() 指向 fixture 目录。

let root = process.cwd();

export function setConfigRoot(dir: string): void {
  root = dir;
}
export function getConfigRoot(): string {
  return root;
}

function orchestratorPath(file: string): string {
  return join(root, 'orchestrator', file);
}

// 相对项目根的配置路径(用于 hashFile 版本追溯)。
export const CONFIG_PATHS = {
  decisionGraph: 'orchestrator/decision-graph.yaml',
  skillRegistry: 'orchestrator/skill-registry.yaml',
  toolRegistry: 'orchestrator/tool-registry.yaml',
  evidencePolicy: 'orchestrator/evidence-policy.yaml',
  reportTemplates: 'orchestrator/report-templates',
} as const;

export const SKILL_RESULT_ENVELOPE_SCHEMA = 'schemas/skill-result-envelope.schema.json';

export interface EvidencePolicyRequirement {
  id: string;
  accepted_classes: EvidenceClass[];
  minimum_count: number;
  required: boolean;
}

export interface EvidencePolicyEntry {
  task_type: string;
  deliverable_type: string;
  requirements: EvidencePolicyRequirement[];
}

export interface EvidencePolicyConfig {
  version: number;
  policies: EvidencePolicyEntry[];
}

export const REPORT_TEMPLATE_SECTION_IDS = [
  'cover',
  'executive-summary',
  'background',
  'scope-method',
  'key-metrics',
  'findings',
  'question-analysis',
  'visual-evidence',
  'comparison',
  'conclusion',
  'recommendations',
  'risks',
  'appendix',
] as const;

export type ReportTemplateSectionId = typeof REPORT_TEMPLATE_SECTION_IDS[number];

export interface ReportTemplateSection {
  id: ReportTemplateSectionId;
  title: string;
}

export interface ReportTemplateConfig {
  version: 1;
  id: string;
  subtitle: string;
  sections: ReportTemplateSection[];
}

function reportTemplateError(field: string, detail: string): Error {
  return new Error(`Report Template ${field}: ${detail}`);
}

function strictRecord(value: unknown, field: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw reportTemplateError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unexpected) throw reportTemplateError(field, `contains unsupported field ${unexpected}`);
  return record;
}

function nonEmptyTemplateString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw reportTemplateError(field, 'must be a non-empty string');
  }
  return value;
}

function parseReportTemplate(value: unknown, expectedId: string): ReportTemplateConfig {
  const config = strictRecord(value, 'root', ['version', 'id', 'subtitle', 'sections']);
  if (config.version !== 1) throw reportTemplateError('version', 'must equal 1');
  const id = nonEmptyTemplateString(config.id, 'id');
  if (id !== expectedId) throw reportTemplateError('id', `must equal ${expectedId}`);
  const subtitle = nonEmptyTemplateString(config.subtitle, 'subtitle');
  if (!Array.isArray(config.sections)) throw reportTemplateError('sections', 'must be an array');
  if (config.sections.length !== REPORT_TEMPLATE_SECTION_IDS.length) {
    throw reportTemplateError('sections', `must contain ${REPORT_TEMPLATE_SECTION_IDS.length} ordered sections`);
  }
  const sections = config.sections.map((value, index): ReportTemplateSection => {
    const section = strictRecord(value, `sections[${index}]`, ['id', 'title']);
    const sectionId = nonEmptyTemplateString(section.id, `sections[${index}].id`);
    const expectedSectionId = REPORT_TEMPLATE_SECTION_IDS[index]!;
    if (sectionId !== expectedSectionId) {
      throw reportTemplateError(`sections[${index}].id`, `must equal ${expectedSectionId}`);
    }
    return {
      id: expectedSectionId,
      title: nonEmptyTemplateString(section.title, `sections[${index}].title`),
    };
  });
  return { version: 1, id, subtitle, sections };
}
const SUPPORTED_EVIDENCE_CLASSES: Readonly<Record<EvidenceClass, true>> = {
  public_source: true,
  screenshot: true,
  user_input: true,
  knowledge: true,
  dataset: true,
  simulation: true,
  derived: true,
};

function evidencePolicyError(field: string, detail: string): Error {
  return new Error(`Evidence Policy ${field}: ${detail}`);
}

function parseEvidencePolicy(value: unknown): EvidencePolicyConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw evidencePolicyError('root', 'must be an object');
  }
  const root = value as { version?: unknown; policies?: unknown };
  if (root.version !== 1) {
    throw evidencePolicyError('version', 'must equal 1');
  }
  if (!Array.isArray(root.policies)) {
    throw evidencePolicyError('policies', 'must be an array');
  }

  const policyKeys = new Set<string>();
  const policies = root.policies.map((rawPolicy, policyIndex): EvidencePolicyEntry => {
    const policyPath = `policies[${policyIndex}]`;
    if (rawPolicy === null || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
      throw evidencePolicyError(policyPath, 'must be an object');
    }
    const policy = rawPolicy as {
      task_type?: unknown;
      deliverable_type?: unknown;
      requirements?: unknown;
    };
    const taskType = policy.task_type;
    const deliverableType = policy.deliverable_type;
    if (typeof taskType !== 'string' || taskType.trim().length === 0) {
      throw evidencePolicyError(`${policyPath}.task_type`, 'must be a non-empty string');
    }
    if (typeof deliverableType !== 'string' || deliverableType.trim().length === 0) {
      throw evidencePolicyError(`${policyPath}.deliverable_type`, 'must be a non-empty string');
    }

    const policyKey = JSON.stringify([taskType, deliverableType]);
    if (policyKeys.has(policyKey)) {
      throw evidencePolicyError(
        'duplicate task_type/deliverable_type',
        `${taskType}/${deliverableType}`,
      );
    }
    policyKeys.add(policyKey);

    if (!Array.isArray(policy.requirements) || policy.requirements.length === 0) {
      throw evidencePolicyError(`${policyPath}.requirements`, 'must be a non-empty array');
    }

    const requirementIds = new Set<string>();
    const requirements = policy.requirements.map(
      (rawRequirement, requirementIndex): EvidencePolicyRequirement => {
        const requirementPath = `${policyPath}.requirements[${requirementIndex}]`;
        if (
          rawRequirement === null
          || typeof rawRequirement !== 'object'
          || Array.isArray(rawRequirement)
        ) {
          throw evidencePolicyError(requirementPath, 'must be an object');
        }
        const requirement = rawRequirement as {
          id?: unknown;
          accepted_classes?: unknown;
          minimum_count?: unknown;
          required?: unknown;
        };
        const requirementId = requirement.id;
        if (typeof requirementId !== 'string' || requirementId.trim().length === 0) {
          throw evidencePolicyError(`${requirementPath}.id`, 'must be a non-empty string');
        }
        if (requirementIds.has(requirementId)) {
          throw evidencePolicyError(
            `duplicate requirement id in ${policyPath}.requirements`,
            requirementId,
          );
        }
        requirementIds.add(requirementId);

        const acceptedClasses = requirement.accepted_classes;
        if (
          !Array.isArray(acceptedClasses)
          || acceptedClasses.length === 0
          || !acceptedClasses.every(
            (evidenceClass): evidenceClass is EvidenceClass =>
              typeof evidenceClass === 'string'
              && SUPPORTED_EVIDENCE_CLASSES[evidenceClass as EvidenceClass] === true,
          )
        ) {
          throw evidencePolicyError(
            `${requirementPath}.accepted_classes`,
            'must be a non-empty array of supported EvidenceClass values',
          );
        }
        const minimumCount = requirement.minimum_count;
        if (
          typeof minimumCount !== 'number'
          || !Number.isInteger(minimumCount)
          || minimumCount < 0
        ) {
          throw evidencePolicyError(
            `${requirementPath}.minimum_count`,
            'must be a non-negative integer',
          );
        }
        const required = requirement.required;
        if (typeof required !== 'boolean') {
          throw evidencePolicyError(`${requirementPath}.required`, 'must be a boolean');
        }

        return {
          id: requirementId,
          accepted_classes: acceptedClasses,
          minimum_count: minimumCount,
          required,
        };
      },
    );

    return { task_type: taskType, deliverable_type: deliverableType, requirements };
  });

  return { version: 1, policies };
}

// ---- 类型 ----
export interface DecisionNode {
  key: string;
  question: string;
  applies_to: string[];
  tier: 'core' | 'optional';
  trigger_conditions?: string[];
  related_tags?: string[];
  risk_policy?: string;
}

export interface SkillRegistryEntry {
  id: string;
  name: string;
  path: string;
  when_to_use: string;
  owner: string;
  status: 'draft' | 'active' | 'deprecated';
  task_types?: string[];
  intent_tags?: string[];
  inputs?: string[];
  visual_inputs?: string[];
  multiple_visual_inputs?: string[];
  outputs?: string[];
  input_schema?: string; // KB skill 为 markdown 过程式, 无 JSON schema
  output_schema?: string;
  payload_schema?: string;
  entry?: string; // SKILL.md 文件夹路径(KB 派生)
  required_tools?: string[];
  optional_tools?: string[];
  execution_mode?: 'legacy_single_call' | 'compiled';
  execution_contract?: string;
  cost_level?: string;
  risk_level: 'low' | 'medium' | 'high';
}

const SKILL_REGISTRY_ENTRY_KEYS = new Set<keyof SkillRegistryEntry>([
  'id',
  'name',
  'path',
  'when_to_use',
  'owner',
  'status',
  'task_types',
  'intent_tags',
  'inputs',
  'visual_inputs',
  'multiple_visual_inputs',
  'outputs',
  'input_schema',
  'output_schema',
  'payload_schema',
  'entry',
  'required_tools',
  'optional_tools',
  'execution_mode',
  'execution_contract',
  'cost_level',
  'risk_level',
]);

export function unknownSkillRegistryFields(skill: SkillRegistryEntry): string[] {
  return Object.keys(skill).filter((key) => !SKILL_REGISTRY_ENTRY_KEYS.has(key as keyof SkillRegistryEntry));
}

export function skillOptionalToolIssue(skill: SkillRegistryEntry): string | null {
  const record = skill as unknown as Record<string, unknown>;
  const optionalTools = record.optional_tools;
  if (optionalTools === undefined) return null;
  if (
    !Array.isArray(optionalTools)
    || optionalTools.some((toolId) => (
      typeof toolId !== 'string'
      || toolId.trim().length === 0
      || toolId.trim() !== toolId
    ))
    || new Set(optionalTools).size !== optionalTools.length
  ) {
    return 'optional_tools must be a unique array of canonical non-empty tool ids';
  }
  const requiredTools = record.required_tools;
  if (!Array.isArray(requiredTools)) return 'optional_tools requires a required_tools array';
  const overlap = optionalTools.find((toolId) => requiredTools.includes(toolId));
  return overlap === undefined
    ? null
    : `optional_tools overlaps required_tools: ${overlap}`;
}

export function skillVisualInputIssue(skill: SkillRegistryEntry): string | null {
  const record = skill as unknown as Record<string, unknown>;
  const visualInputs = record.visual_inputs;
  const multipleVisualInputs = record.multiple_visual_inputs;
  if (visualInputs === undefined) {
    return multipleVisualInputs === undefined
      ? null
      : 'multiple_visual_inputs requires a visual_inputs array';
  }
  if (
    !Array.isArray(visualInputs)
    || visualInputs.some((role) => (
      typeof role !== 'string'
      || role.trim().length === 0
      || role.trim() !== role
    ))
    || new Set(visualInputs).size !== visualInputs.length
  ) {
    return 'visual_inputs must be a unique array of canonical non-empty strings';
  }
  const inputs = record.inputs;
  if (!Array.isArray(inputs)) return 'visual_inputs requires an inputs array';
  const missingRole = visualInputs.find((role) => !inputs.includes(role));
  if (missingRole !== undefined) return `visual_inputs references an undeclared input: ${missingRole}`;
  if (multipleVisualInputs === undefined) return null;
  if (
    !Array.isArray(multipleVisualInputs)
    || multipleVisualInputs.some((role) => (
      typeof role !== 'string'
      || role.trim().length === 0
      || role.trim() !== role
    ))
    || new Set(multipleVisualInputs).size !== multipleVisualInputs.length
  ) {
    return 'multiple_visual_inputs must be a unique array of canonical non-empty strings';
  }
  const nonVisualRole = multipleVisualInputs.find((role) => !visualInputs.includes(role));
  return nonVisualRole === undefined
    ? null
    : `multiple_visual_inputs references a non-visual input: ${nonVisualRole}`;
}

export interface ToolRegistryEntry {
  id: string;
  name: string;
  path: string;
  adapter_type: 'o2' | 'internal_api' | 'rest_json' | 'mcp' | 'script' | 'fake' | 'tavily' | 'playwright';
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  status: 'draft' | 'active' | 'deprecated';
  // 可用性层级(与 decision-node 同词汇):
  //   core     = 平台托管、常在的能力(公开网页检索 o2/tavily),失败按 infra 处理、可重试。
  //   optional = 依赖外部后端的增强能力(截图库/labs),缺失不应阻断报告——规划不得作唯一证据,
  //              金标运行遇其失败自动跳过成缺口。缺省视为 optional(增强,保守不阻断)。
  tier?: 'core' | 'optional';
}

export interface ToolManifest {
  id: string;
  name: string;
  adapter_type: 'o2' | 'internal_api' | 'rest_json' | 'mcp' | 'script' | 'fake' | 'tavily' | 'playwright';
  entrypoint?: string;
  base_url_env?: string;
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  approver_rule?: 'none' | 'owner' | 'security' | 'legal';
  timeout_seconds?: number;
  retry_policy?: { max_attempts: number; backoff_seconds: number };
  input_schema: string;
  output_schema: string;
  redaction_policy?: Record<string, string>;
  // 声明该 tool 的图像入参字段,供编排在"确认计划"闸门向用户收图并回填 step.input。
  // role:同一 role 的字段共享一次上传(如 design=主设计稿),用户传一次回填到所有步骤。
  image_input_fields?: Array<{ field: string; multiple?: boolean; role?: string }>;
}

export interface SkillManifest {
  id: string;
  name: string;
  path: string;
  when_to_use: string;
  owner: string;
  status: 'draft' | 'active' | 'deprecated';
  inputs?: string[];
  outputs?: string[];
  input_schema: string;
  output_schema: string;
  required_tools?: string[];
  risk_level: 'low' | 'medium' | 'high';
  [k: string]: unknown;
}

// ---- 读取 ----
export function loadYaml<T>(absPath: string): T {
  return parseYaml(readFileSync(absPath, 'utf8')) as T;
}

export function loadDecisionGraph(): { version: number; nodes: DecisionNode[] } {
  return loadYaml(orchestratorPath('decision-graph.yaml'));
}

export function loadSkillRegistry(): { version: number; skills: SkillRegistryEntry[] } {
  return loadYaml(orchestratorPath('skill-registry.yaml'));
}

export function loadToolRegistry(): { version: number; tools: ToolRegistryEntry[] } {
  return loadYaml(orchestratorPath('tool-registry.yaml'));
}

export function loadEvidencePolicy(): EvidencePolicyConfig {
  let value: unknown;
  try {
    value = loadYaml<unknown>(orchestratorPath('evidence-policy.yaml'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw evidencePolicyError('YAML', detail);
  }
  return parseEvidencePolicy(value);
}

export function loadReportTemplate(templateId: string): ReportTemplateConfig {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(templateId)) {
    throw reportTemplateError('id', 'contains unsafe path characters');
  }
  let value: unknown;
  try {
    value = loadYaml<unknown>(orchestratorPath(`report-templates/${templateId}.yaml`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw reportTemplateError('YAML', detail);
  }
  return parseReportTemplate(value, templateId);
}

// 读取某个 tool/skill 的完整 manifest(相对项目根的 path)。
export function loadToolManifest(relPath: string): ToolManifest {
  return loadYaml(join(root, relPath));
}

export function loadSkillManifest(relPath: string): SkillManifest {
  return loadYaml(join(root, relPath));
}

// 读某个 tool 的 input.schema(相对项目根路径,如 tools/xxx/input.schema.json)。
// 规划阶段喂给 LLM,让它按 schema 为 tool 步生成 input 入参。
export function loadToolInputSchema(inputSchemaRelPath: string): object {
  return JSON.parse(readFileSync(join(root, inputSchemaRelPath), 'utf8')) as object;
}

// 版本追溯:文件内容 sha256,写入 execution_log 的 *_manifest_hashes / decision_graph_hash。
export function hashFile(relOrAbsPath: string): string {
  const p = relOrAbsPath.startsWith('/') ? relOrAbsPath : join(root, relOrAbsPath);
  return 'sha256:' + createHash('sha256').update(readFileSync(p)).digest('hex');
}

export function fileExists(relPath: string): boolean {
  return existsSync(join(root, relPath));
}
