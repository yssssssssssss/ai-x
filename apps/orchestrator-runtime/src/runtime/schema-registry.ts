import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchemaName } from '../schema/validator.ts';

// schemaName 命名空间的唯一事实源(issue #5)。
// 收敛此前散在 gateway-llm-client(schemaHint / decision-states 特判 / envelope-unwrap)
// 与 llm-client 里的魔法字符串:一次描述「一个 schemaName 意味着什么」。
// - 项目 schema:由 SchemaName 联合类型和下方列表集中注册。
// - decision-states:decision-state 的数组,网关用 {items:[...]} envelope 包裹。
// - skill:*:运行时动态名,output schema 由调用方以 schema 对象直接传入,不查 schemas/。
// - 其它未知名(如 execution-plan-candidates):无独立文件,调用方降级为通用提示。

export interface SchemaSpec {
  id: string;
  file?: string; // schemas/ 下文件名;无则运行时构造名 / 动态名
  isArrayEnvelope?: boolean; // 顶层是数组,网关需 {items:[...]} 包裹
  arrayItemFile?: string; // 数组项的 schema 文件(仅 envelope)
}

const PROJECT_SCHEMAS: readonly (SchemaName | 'current-plan-candidates' | 'current-execution-plan' | 'current-execution-plan-v3' | 'research-task-v2' | 'problem-graph' | 'capability-demand-graph-v1' | 'research-contribution-v1' | 'research-contribution-artifact-v1' | 'research-contribution-bundle-v1' | 'cross-skill-review-v1' | 'contribution-summary-v1' | 'contribution-ledger-v1' | 'scenario-guidance' | 'report-review')[] = [
  'research-task',
  'research-task-v2',
  'decision-state',
  'problem-graph',
  'capability-demand-graph-v1',
  'scenario-guidance',
  'execution-plan',
  'current-execution-plan',
  'current-execution-plan-v3',
  'current-plan-candidates',
  'skill-manifest',
  'tool-manifest',
  'research-report',
  'research-contribution-v1',
  'research-contribution-artifact-v1',
  'research-contribution-bundle-v1',
  'cross-skill-review-v1',
  'contribution-summary-v1',
  'contribution-ledger-v1',
  'report-review',
];

// 命令经 pnpm scripts 从项目根运行,cwd 恒为项目根(与 validator.ts 一致)。
const schemasDir = join(process.cwd(), 'schemas');
const textCache = new Map<string, string>();

export function resolveSchema(schemaName: string): SchemaSpec {
  if (schemaName === 'decision-states') {
    return {
      id: schemaName,
      isArrayEnvelope: true,
      arrayItemFile: 'decision-state.schema.json',
    };
  }
  if (schemaName.startsWith('skill:')) {
    return { id: schemaName };
  }
  if ((PROJECT_SCHEMAS as readonly string[]).includes(schemaName)) {
    return { id: schemaName, file: `${schemaName}.schema.json` };
  }
  return { id: schemaName };
}

// 读 schema 文件文本并缓存(移出 LLM 调用热路径)。无文件的 spec 返回 null。
export function loadSchemaText(spec: SchemaSpec): string | null {
  const file = spec.arrayItemFile ?? spec.file;
  if (!file) return null;
  const cached = textCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(schemasDir, file), 'utf8');
  textCache.set(file, text);
  return text;
}
