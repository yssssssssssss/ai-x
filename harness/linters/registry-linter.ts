import {
  loadDecisionGraph,
  loadSkillRegistry,
  loadToolRegistry,
  loadToolManifest,
  fileExists,
  SKILL_RESULT_ENVELOPE_SCHEMA,
  skillCompositionIssues,
  skillOptionalToolIssue,
  skillVisualInputIssue,
  unknownSkillRegistryFields,
  type SkillRegistryEntry,
  type ToolRegistryEntry,
  type DecisionNode,
} from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { inspectDeliverableRegistry } from '../../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import { CONTRIBUTION_ADAPTER_IDS } from '../../apps/orchestrator-runtime/src/skills/contribution-adapter-registry.ts';
import { loadSkillExecutionContract } from '../../apps/orchestrator-runtime/src/skills/skill-execution-contract.ts';

// registry linter(方案 §2.4 校验器之一 · P0-03 门禁):
//   - status=active 的 skill/tool 必须字段完整、schema 文件存在、required_tools 存在
//   - risk_level=high 的 tool 必须有非 none 的 approver_rule,否则只能 draft
//   - decision node 必须含 key/applies_to/tier
// 能机器拦的规则不靠人自觉。返回 issues 列表,空=通过。

export interface LintIssue {
  level: 'error';
  target: string;
  message: string;
}

const SKILL_ACTIVE_REQUIRED: (keyof SkillRegistryEntry)[] = [
  'id', 'name', 'path', 'when_to_use', 'owner', 'risk_level', 'output_schema',
];
const TOOL_ACTIVE_REQUIRED: (keyof ToolRegistryEntry)[] = [
  'id', 'name', 'path', 'adapter_type', 'auth_required', 'risk_level',
];

const CAPABILITY_ARRAY_FIELDS = ['task_types', 'inputs', 'outputs', 'required_tools'] as const;


function lintCapabilityArrays(skill: SkillRegistryEntry, target: string, issues: LintIssue[]): void {
  const knowledgeBaseSkill = skill.entry !== undefined || skill.path?.startsWith('knowledge-base/') === true;
  for (const field of CAPABILITY_ARRAY_FIELDS) {
    const value = skill[field];
    if (knowledgeBaseSkill && value === undefined && field !== 'task_types') continue;
    if (!Array.isArray(value)) {
      issues.push({ level: 'error', target, message: `active skill 的 ${field} 必须是数组` });
      continue;
    }
    if (!knowledgeBaseSkill && value.length === 0) {
      issues.push({ level: 'error', target, message: `active native skill 的 ${field} 不得为空数组` });
    }
    if (field === 'task_types' && value.length === 0) {
      issues.push({ level: 'error', target, message: 'active skill 的 task_types 不得为空数组' });
    }
  }
  const visualInputIssue = skillVisualInputIssue(skill);
  if (visualInputIssue) {
    issues.push({ level: 'error', target, message: `active skill 的 ${visualInputIssue}` });
  }
}

function lintSkills(issues: LintIssue[]): void {
  const { skills } = loadSkillRegistry();
  const toolsById = new Map(loadToolRegistry().tools.map((tool) => [tool.id, tool]));
  const explicitCompositionRequired = skills.some((skill) => (
    skill.status === 'active' && skill.composition !== undefined
  ));
  const activeDeliverableIds = new Set(
    inspectDeliverableRegistry().entries
      .filter(({ status }) => status === 'active')
      .map(({ id }) => id),
  );

  for (const s of skills) {
    const tgt = `skill:${s.id ?? '(no-id)'}`;
    if (s.status !== 'active') continue; // draft/deprecated 不参与自动路由,放宽校验

    const unknownFields = unknownSkillRegistryFields(s);
    if (unknownFields.length > 0) {
      issues.push({
        level: 'error',
        target: tgt,
        message: `active skill 含未知字段: ${unknownFields.join(', ')}`,
      });
    }

    for (const f of SKILL_ACTIVE_REQUIRED) {
      if (s[f] === undefined || s[f] === null || s[f] === '') {
        issues.push({ level: 'error', target: tgt, message: `active skill 缺必填字段 "${String(f)}"` });
      }
    }
    lintCapabilityArrays(s, tgt, issues);
    if (explicitCompositionRequired && s.composition === undefined) {
      issues.push({ level: 'error', target: tgt, message: 'active skill 缺 composition 分类' });
    }
    for (const message of skillCompositionIssues(s)) {
      issues.push({ level: 'error', target: tgt, message });
    }
    if (
      s.composition?.contribution_adapter
      && !(CONTRIBUTION_ADAPTER_IDS as readonly string[]).includes(s.composition.contribution_adapter)
    ) {
      issues.push({
        level: 'error',
        target: tgt,
        message: `composition contribution_adapter 未注册: ${s.composition.contribution_adapter}`,
      });
    }
    if (s.composition?.contribution_schema && !fileExists(s.composition.contribution_schema)) {
      issues.push({
        level: 'error',
        target: tgt,
        message: `composition contribution_schema 不存在: ${s.composition.contribution_schema}`,
      });
    }
    for (const deliverableId of s.composition?.compatible_deliverables ?? []) {
      if (!activeDeliverableIds.has(deliverableId)) {
        issues.push({
          level: 'error',
          target: tgt,
          message: `composition 引用了非 active deliverable: ${deliverableId}`,
        });
      }
    }
    const optionalToolIssue = skillOptionalToolIssue(s);
    if (optionalToolIssue) {
      issues.push({ level: 'error', target: tgt, message: `active skill 的 ${optionalToolIssue}` });
    }
    const skillPath = s.path ?? s.entry;
    if (skillPath && !fileExists(skillPath)) {
      issues.push({ level: 'error', target: tgt, message: `path/entry 不存在: ${skillPath}` });
    }
    if (s.input_schema && !fileExists(s.input_schema)) {
      issues.push({ level: 'error', target: tgt, message: `input_schema 不存在: ${s.input_schema}` });
    }
    if (s.output_schema && !fileExists(s.output_schema)) {
      issues.push({ level: 'error', target: tgt, message: `output_schema 不存在: ${s.output_schema}` });
    }
    if (s.output_schema && s.output_schema !== SKILL_RESULT_ENVELOPE_SCHEMA) {
      issues.push({ level: 'error', target: tgt, message: `active skill 必须使用统一 output_schema: ${SKILL_RESULT_ENVELOPE_SCHEMA}` });
    }
    if (s.payload_schema && !fileExists(s.payload_schema)) {
      issues.push({ level: 'error', target: tgt, message: `payload_schema 不存在: ${s.payload_schema}` });
    }
    const executionMode = s.execution_mode ?? 'legacy_single_call';
    if (executionMode === 'compiled') {
      if (!s.execution_contract) {
        issues.push({ level: 'error', target: tgt, message: 'compiled skill 缺 execution_contract' });
      } else if (!fileExists(s.execution_contract)) {
        issues.push({ level: 'error', target: tgt, message: `execution_contract 不存在: ${s.execution_contract}` });
      } else {
        try {
          const loaded = loadSkillExecutionContract(s.execution_contract, s.id);
          const allowedTools = new Set([...(s.required_tools ?? []), ...(s.optional_tools ?? [])]);
          for (const stage of loaded.contract.stages) {
            if (stage.actor_type === 'tool' && !allowedTools.has(stage.actor_id)) {
              issues.push({
                level: 'error',
                target: tgt,
                message: `execution_contract Tool 不属于该 Skill: ${stage.actor_id}`,
              });
            }
          }
        } catch (error) {
          issues.push({ level: 'error', target: tgt, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } else if (s.execution_contract) {
      issues.push({ level: 'error', target: tgt, message: 'legacy_single_call skill 不得声明 execution_contract' });
    }
    for (const t of s.required_tools ?? []) {
      if (!toolsById.has(t)) {
        issues.push({ level: 'error', target: tgt, message: `required_tools 引用了未登记的 tool: ${t}` });
      }
    }
    if (Array.isArray(s.optional_tools)) {
      for (const toolId of s.optional_tools) {
        const tool = toolsById.get(toolId);
        if (!tool) {
          issues.push({ level: 'error', target: tgt, message: `optional_tools 引用了未登记的 tool: ${toolId}` });
        } else if (tool.tier !== 'optional') {
          issues.push({ level: 'error', target: tgt, message: `optional_tools 只能引用 optional tier tool: ${toolId}` });
        }
      }
    }
  }
}

function lintTools(issues: LintIssue[]): void {
  const { tools } = loadToolRegistry();
  for (const t of tools) {
    const tgt = `tool:${t.id ?? '(no-id)'}`;
    if (t.status !== 'active') continue;

    for (const f of TOOL_ACTIVE_REQUIRED) {
      if (t[f] === undefined || t[f] === null || t[f] === '') {
        issues.push({ level: 'error', target: tgt, message: `active tool 缺必填字段 "${String(f)}"` });
      }
    }
    if (t.tier !== 'core' && t.tier !== 'optional') {
      issues.push({ level: 'error', target: tgt, message: 'active tool 的 tier 必须是 core|optional' });
    }
    if (t.path && !fileExists(t.path)) {
      issues.push({ level: 'error', target: tgt, message: `path 不存在: ${t.path}` });
      continue; // 读不到 manifest,后续 approver 校验跳过
    }
    // 高风险 tool 必须在其 manifest 里配置非 none 的 approver_rule
    if (t.risk_level === 'high') {
      const manifest = loadToolManifest(t.path);
      if (!manifest.approver_rule || manifest.approver_rule === 'none') {
        issues.push({
          level: 'error',
          target: tgt,
          message: `risk_level=high 的 tool 必须配置 approver_rule(非 none),否则只能 draft`,
        });
      }
    }
  }
}

function lintDecisionNodes(issues: LintIssue[]): void {
  const { nodes } = loadDecisionGraph();
  nodes.forEach((n: DecisionNode, i) => {
    const tgt = `decision-node[${i}]:${n.key ?? '(no-key)'}`;
    if (!n.key) issues.push({ level: 'error', target: tgt, message: 'decision node 缺 key' });
    if (!Array.isArray(n.applies_to) || n.applies_to.length === 0) {
      issues.push({ level: 'error', target: tgt, message: 'decision node 缺 applies_to' });
    }
    if (n.tier !== 'core' && n.tier !== 'optional') {
      issues.push({ level: 'error', target: tgt, message: 'decision node 的 tier 必须是 core|optional' });
    }
  });
}
function lintDeliverables(issues: LintIssue[]): void {
  for (const item of inspectDeliverableRegistry().diagnostics) {
    issues.push({ level: 'error', target: item.target, message: item.message });
  }
}


export function lintRegistries(): LintIssue[] {
  const issues: LintIssue[] = [];
  lintSkills(issues);
  lintTools(issues);
  lintDecisionNodes(issues);
  lintDeliverables(issues);
  return issues;
}

// CLI 入口:pnpm lint:registry
if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintRegistries();
  if (issues.length === 0) {
    console.log('registry-linter: OK,无问题。');
    process.exit(0);
  }
  console.error(`registry-linter: 发现 ${issues.length} 个问题:`);
  for (const it of issues) console.error(`  [${it.level}] ${it.target} — ${it.message}`);
  process.exit(1);
}
