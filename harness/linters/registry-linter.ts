import {
  loadDecisionGraph,
  loadSkillRegistry,
  loadToolRegistry,
  loadToolManifest,
  fileExists,
  type SkillRegistryEntry,
  type ToolRegistryEntry,
  type DecisionNode,
} from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';

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

function lintSkills(issues: LintIssue[]): void {
  const { skills } = loadSkillRegistry();
  const knownTools = new Set(loadToolRegistry().tools.map((t) => t.id));

  for (const s of skills) {
    const tgt = `skill:${s.id ?? '(no-id)'}`;
    if (s.status !== 'active') continue; // draft/deprecated 不参与自动路由,放宽校验

    for (const f of SKILL_ACTIVE_REQUIRED) {
      if (s[f] === undefined || s[f] === null || s[f] === '') {
        issues.push({ level: 'error', target: tgt, message: `active skill 缺必填字段 "${String(f)}"` });
      }
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
    if (s.payload_schema && !fileExists(s.payload_schema)) {
      issues.push({ level: 'error', target: tgt, message: `payload_schema 不存在: ${s.payload_schema}` });
    }
    for (const t of s.required_tools ?? []) {
      if (!knownTools.has(t)) {
        issues.push({ level: 'error', target: tgt, message: `required_tools 引用了未登记的 tool: ${t}` });
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
    if (t.path && !fileExists(t.path)) {
      issues.push({ level: 'error', target: tgt, message: `path 不存在: ${t.path}` });
      continue; // 读不到 manifest,后续 approver 校验跳过
    }
    const manifest = loadToolManifest(t.path);
    for (const field of manifest.image_input_fields ?? []) {
      const fieldTarget = `${tgt}.image_input_fields.${field.field ?? '(no-field)'}`;
      if (!field.field || !field.role) {
        issues.push({ level: 'error', target: fieldTarget, message: '图片字段必须声明 field 和 role' });
      }
      const min = field.min_items ?? (field.required ? 1 : 0);
      const max = field.max_items ?? (field.multiple ? 10 : 1);
      if (min < 0 || max < 1 || min > max) {
        issues.push({ level: 'error', target: fieldTarget, message: '图片字段数量约束非法(min_items/max_items)' });
      }
      if (!field.multiple && max > 1) {
        issues.push({ level: 'error', target: fieldTarget, message: 'multiple=false 时 max_items 不能大于 1' });
      }
      if (field.accepted_mime_types?.some((mime) => !mime.startsWith('image/'))) {
        issues.push({ level: 'error', target: fieldTarget, message: 'accepted_mime_types 当前仅允许 image/*' });
      }
    }
    // 高风险 tool 必须在其 manifest 里配置非 none 的 approver_rule
    if (t.risk_level === 'high') {
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

export function lintRegistries(): LintIssue[] {
  const issues: LintIssue[] = [];
  lintSkills(issues);
  lintTools(issues);
  lintDecisionNodes(issues);
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
