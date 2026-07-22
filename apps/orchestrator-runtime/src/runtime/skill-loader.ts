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

export class SkillLoader {
  // 第一层:发现所有 active skill 的轻量索引(供 LLM 语义选择)
  listActiveSkills(): SkillRegistryEntry[] {
    return loadSkillRegistry().skills.filter((s) => s.status === 'active');
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

  // 第三层:执行期加载 skill 的 input/output schema。
  // KB 派生 skill 无 JSON schema(markdown 过程式),对应字段返回 undefined,不抛。
  loadSkillSchemas(id: string): { input?: object; output?: object; payload?: object } {
    const entry = this.getSkill(id);
    if (!entry) throw new Error(`skill 未找到或非 active: ${id}`);
    const root = getConfigRoot();
    return {
      input: entry.input_schema ? JSON.parse(readFileSync(join(root, entry.input_schema), 'utf8')) : undefined,
      output: entry.output_schema ? JSON.parse(readFileSync(join(root, entry.output_schema), 'utf8')) : undefined,
      payload: entry.payload_schema ? JSON.parse(readFileSync(join(root, entry.payload_schema), 'utf8')) : undefined,
    };
  }
}
