import {
  fileExists,
  loadDecisionGraph,
  loadSkillBindings,
  loadToolManifest,
  loadToolRegistry,
  skillCompositionIssues,
  type DecisionNode,
  type ToolRegistryEntry,
} from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { inspectDeliverableRegistry } from '../../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import { InstalledSkillCatalog } from '../../apps/orchestrator-runtime/src/runtime/installed-skill-catalog.ts';
import { SkillLoader } from '../../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

export interface LintIssue {
  level: 'error';
  target: string;
  message: string;
}

const TOOL_ACTIVE_REQUIRED: (keyof ToolRegistryEntry)[] = [
  'id', 'name', 'path', 'adapter_type', 'auth_required', 'risk_level',
];

function lintSkills(issues: LintIssue[]): void {
  const bindings = loadSkillBindings().skills;
  const packageIds = new Set(new InstalledSkillCatalog().scan().skills.map(({ id }) => id));
  if (new Set(bindings.map(({ id }) => id)).size !== bindings.length) {
    issues.push({ level: 'error', target: 'skill-bindings', message: 'Skill binding id 必须唯一' });
  }
  for (const binding of bindings) {
    if (!packageIds.has(binding.id)) {
      issues.push({ level: 'error', target: `skill:${binding.id}`, message: 'binding 未找到已安装原版 Skill 包' });
    }
  }

  let skills: ReturnType<SkillLoader['listCapabilitySkills']> = [];
  try {
    skills = new SkillLoader().listCapabilitySkills();
  } catch (error) {
    issues.push({
      level: 'error',
      target: 'skill-bindings',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const toolsById = new Map(loadToolRegistry().tools.map((tool) => [tool.id, tool]));
  const activeDeliverableIds = new Set(
    inspectDeliverableRegistry().entries
      .filter(({ status }) => status === 'active')
      .map(({ id }) => id),
  );
  for (const skill of skills) {
    const target = `skill:${skill.id}`;
    for (const message of skillCompositionIssues(skill)) {
      issues.push({ level: 'error', target, message });
    }
    for (const deliverableId of skill.composition?.compatible_deliverables ?? []) {
      if (!activeDeliverableIds.has(deliverableId)) {
        issues.push({ level: 'error', target, message: `composition 引用了非 active deliverable: ${deliverableId}` });
      }
    }
    for (const toolId of skill.required_tools ?? []) {
      if (!toolsById.has(toolId)) {
        issues.push({ level: 'error', target, message: `required_tools 引用了未登记的 tool: ${toolId}` });
      }
    }
    for (const toolId of skill.optional_tools ?? []) {
      const tool = toolsById.get(toolId);
      if (!tool) issues.push({ level: 'error', target, message: `optional_tools 引用了未登记的 tool: ${toolId}` });
      else if (tool.tier !== 'optional') {
        issues.push({ level: 'error', target, message: `optional_tools 只能引用 optional tier tool: ${toolId}` });
      }
    }
  }
}

function lintTools(issues: LintIssue[]): void {
  const { tools } = loadToolRegistry();
  for (const tool of tools) {
    const target = `tool:${tool.id ?? '(no-id)'}`;
    if (tool.status !== 'active') continue;
    for (const field of TOOL_ACTIVE_REQUIRED) {
      if (tool[field] === undefined || tool[field] === null || tool[field] === '') {
        issues.push({ level: 'error', target, message: `active tool 缺必填字段 "${String(field)}"` });
      }
    }
    if (tool.tier !== 'core' && tool.tier !== 'optional') {
      issues.push({ level: 'error', target, message: 'active tool 的 tier 必须是 core|optional' });
    }
    if (tool.path && !fileExists(tool.path)) {
      issues.push({ level: 'error', target, message: `path 不存在: ${tool.path}` });
      continue;
    }
    if (tool.risk_level === 'high') {
      const manifest = loadToolManifest(tool.path);
      if (!manifest.approver_rule || manifest.approver_rule === 'none') {
        issues.push({
          level: 'error',
          target,
          message: 'risk_level=high 的 tool 必须配置 approver_rule(非 none),否则只能 draft',
        });
      }
    }
  }
}

function lintDecisionNodes(issues: LintIssue[]): void {
  const { nodes } = loadDecisionGraph();
  nodes.forEach((node: DecisionNode, index) => {
    const target = `decision-node[${index}]:${node.key ?? '(no-key)'}`;
    if (!node.key) issues.push({ level: 'error', target, message: 'decision node 缺 key' });
    if (!Array.isArray(node.applies_to) || node.applies_to.length === 0) {
      issues.push({ level: 'error', target, message: 'decision node 缺 applies_to' });
    }
    if (node.tier !== 'core' && node.tier !== 'optional') {
      issues.push({ level: 'error', target, message: 'decision node 的 tier 必须是 core|optional' });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintRegistries();
  if (issues.length === 0) {
    console.log('registry-linter: OK,无问题。');
    process.exit(0);
  }
  console.error(`registry-linter: 发现 ${issues.length} 个问题:`);
  for (const issue of issues) console.error(`  [${issue.level}] ${issue.target} — ${issue.message}`);
  process.exit(1);
}
