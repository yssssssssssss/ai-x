import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

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
} as const;

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
  input_schema: string;
  output_schema: string;
  required_tools?: string[];
  cost_level?: string;
  risk_level: 'low' | 'medium' | 'high';
}

export interface ToolRegistryEntry {
  id: string;
  name: string;
  path: string;
  adapter_type: 'o2' | 'internal_api' | 'rest_json' | 'mcp' | 'script' | 'fake';
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  status: 'draft' | 'active' | 'deprecated';
}

export interface ToolManifest {
  id: string;
  name: string;
  adapter_type: 'o2' | 'internal_api' | 'rest_json' | 'mcp' | 'script' | 'fake';
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
  image_input_fields?: Array<{ field: string; multiple?: boolean }>;
}

export interface SkillManifest {
  id: string;
  name: string;
  path: string;
  when_to_use: string;
  owner: string;
  status: 'draft' | 'active' | 'deprecated';
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
