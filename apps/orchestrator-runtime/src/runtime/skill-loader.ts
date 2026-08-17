import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSkillRegistry,
  loadToolRegistry,
  getConfigRoot,
  hashFile,
  type SkillRegistryEntry,
  type ToolRegistryEntry,
} from './config-loader.ts';

// 三层渐进加载(方案 §2.3):
//   第一层 轻量索引:registry 摘要字段 → 发现候选,避免上下文膨胀
//   第二层 候选能力:命中的 SKILL.md 全文 → 理解边界/步骤/输入输出
//   第三层 执行期资源:input/output schema、examples → 真正执行
// 只加载 active 能力;draft/deprecated 不参与自动路由。

export interface SkillCandidate {
  entry: SkillRegistryEntry;
  manifestHash: string;
}

type CapabilityArrays = {
  task_types: string[];
  inputs: string[];
  outputs: string[];
  required_tools: string[];
};

type ActiveCapabilitySkillRegistryEntry = Omit<
  SkillRegistryEntry,
  'status' | keyof CapabilityArrays
> & CapabilityArrays & { status: 'active' };

type InactiveCapabilitySkillRegistryEntry = Partial<Omit<
  SkillRegistryEntry,
  'status' | keyof CapabilityArrays
>> & CapabilityArrays & { status: 'draft' | 'deprecated' };

export type CapabilitySkillRegistryEntry =
  | ActiveCapabilitySkillRegistryEntry
  | InactiveCapabilitySkillRegistryEntry;

export interface LoadedSkillSchemas {
  input?: object;
  output: object;
}

export function composeSkillOutputSchema(envelope: object, payload?: object): object {
  const output = structuredClone(envelope) as Record<string, unknown>;
  delete output.$id;
  if (!payload) return output;
  const properties = output.properties;
  if (
    properties === null
    || typeof properties !== 'object'
    || Array.isArray(properties)
    || !Object.hasOwn(properties, 'payload')
  ) {
    throw new Error('Skill output envelope must declare a payload property');
  }
  Reflect.set(properties, 'payload', structuredClone(payload));
  return output;
}

export class SkillLoader {
  // 第一层:发现所有 active skill 的轻量索引(供 LLM 语义选择)
  listActiveSkills(): SkillRegistryEntry[] {
    return loadSkillRegistry().skills.filter((s) => s.status === 'active');
  }

  listCapabilitySkills(): CapabilitySkillRegistryEntry[] {
    return loadSkillRegistry().skills.map((skill): CapabilitySkillRegistryEntry => {
      const taskTypes = skill.task_types ?? [];
      const inputs = skill.inputs ?? [];
      const outputs = skill.outputs ?? [];
      const requiredTools = skill.required_tools ?? [];
      if (skill.status !== 'active') {
        return {
          ...skill,
          status: skill.status,
          task_types: Array.isArray(taskTypes) ? taskTypes : [],
          inputs: Array.isArray(inputs) ? inputs : [],
          outputs: Array.isArray(outputs) ? outputs : [],
          required_tools: Array.isArray(requiredTools) ? requiredTools : [],
        };
      }

      const knowledgeBaseSkill = skill.entry !== undefined || skill.path?.startsWith('knowledge-base/') === true;
      if (
        !Array.isArray(taskTypes)
        || !Array.isArray(inputs)
        || !Array.isArray(outputs)
        || !Array.isArray(requiredTools)
        || taskTypes.length === 0
        || (!knowledgeBaseSkill && (inputs.length === 0 || outputs.length === 0 || requiredTools.length === 0))
      ) {
        throw new Error(`active skill capability metadata invalid: ${skill.id}`);
      }
      return {
        ...skill,
        status: 'active',
        task_types: taskTypes,
        inputs,
        outputs,
        required_tools: requiredTools,
      };
    });
  }

  listActiveTools(): ToolRegistryEntry[] {
    return loadToolRegistry().tools.filter((t) => t.status === 'active');
  }

  getSkill(id: string): SkillRegistryEntry | null {
    return this.listActiveSkills().find((s) => s.id === id) ?? null;
  }

  getTool(id: string): ToolRegistryEntry | null {
    return this.listActiveTools().find((t) => t.id === id) ?? null;
  }

  // 第二层:读命中的 SKILL.md 全文。
  // 原生 skill 的 path 直接指向 SKILL.md;KB 派生 skill 的 path 是目录、entry 才是 SKILL.md。
  loadSkillBody(id: string): { body: string; hash: string; path: string } {
    const entry = this.getSkill(id);
    if (!entry) throw new Error(`skill 未找到或非 active: ${id}`);
    const rel = entry.entry ?? entry.path;
    const body = readFileSync(join(getConfigRoot(), rel), 'utf8');
    return { body, hash: hashFile(rel), path: rel };
  }

  // 第三层:执行期加载 Skill 输入与统一输出信封；有领域 payload 时内联为同一有效合同。
  loadSkillSchemas(id: string): LoadedSkillSchemas {
    const entry = this.getSkill(id);
    if (!entry) throw new Error(`skill 未找到或非 active: ${id}`);
    if (!entry.output_schema) throw new Error(`active skill 缺 output_schema: ${id}`);
    const root = getConfigRoot();
    const envelope = JSON.parse(readFileSync(join(root, entry.output_schema), 'utf8')) as object;
    const payload = entry.payload_schema
      ? JSON.parse(readFileSync(join(root, entry.payload_schema), 'utf8')) as object
      : undefined;
    return {
      input: entry.input_schema ? JSON.parse(readFileSync(join(root, entry.input_schema), 'utf8')) : undefined,
      output: composeSkillOutputSchema(envelope, payload),
    };
  }
}
