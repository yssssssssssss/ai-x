import { isP0EligibleBatch, loadGoldPolicy } from './gold-policy.ts';
import type { GoldPolicy } from './gold-policy.ts';

// 批次聚合(纯函数层)。三次金标真实运行 → batch.md。
// 机器只填客观计数(infra 失败数、能力产出数、schema 通过数);
// 「本批次是否 P0 通过」这句结论必须由研究员写(可用性判定不可自动化)。

export type RunOutcome = 'capability_run' | 'infra_failed' | 'disabled_workflow';

export interface BatchRunLine {
  run_id: string;
  outcome: RunOutcome; // 能力样本、基础设施失败，或不计入 P0 的 disabled 命令验证
  status: string; // completed / completed_with_gaps / paused / failed
  schema_valid: boolean;
  infra_retries: number; // 该 run 因 infra 失败重试的次数(透明留痕)
  note?: string; // infra 失败原因等
}

export interface BatchInput {
  batch_id: string;
  scenario: string; // 金标场景名
  scenario_input: string; // 固定输入原文
  runs: BatchRunLine[];
}

export interface BatchCounts {
  capabilityRuns: number; // 计入批次的能力样本数(目标 3)
  infraFailures: number; // infra 失败次数(不占名额)
  totalInfraRetries: number;
  disabledWorkflows: number;
  schemaPassed: number; // 能力样本中 schema 通过数
}

export function countBatch(input: BatchInput): BatchCounts {
  const cap = input.runs.filter((r) => r.outcome === 'capability_run');
  return {
    capabilityRuns: cap.length,
    infraFailures: input.runs.filter((r) => r.outcome === 'infra_failed').length,
    disabledWorkflows: input.runs.filter((r) => r.outcome === 'disabled_workflow').length,
    totalInfraRetries: input.runs.reduce((n, r) => n + r.infra_retries, 0),
    schemaPassed: cap.filter((r) => r.schema_valid).length,
  };
}

export function countP0EligibleRuns(input: BatchInput, policy: GoldPolicy): number {
  if (!isP0EligibleBatch(input.batch_id, policy)) return 0;
  return countBatch(input).capabilityRuns;
}

export function buildBatchSummary(input: BatchInput, policy: GoldPolicy = loadGoldPolicy()): string {
  const c = countBatch(input);
  const p0EligibleRuns = countP0EligibleRuns(input, policy);
  const L: string[] = [];
  L.push(`# 批次审计 — ${input.batch_id}`, '');
  L.push(`- 金标场景: ${input.scenario}`);
  L.push(`- 固定输入: ${input.scenario_input}`);
  L.push('');

  L.push('## 客观计数（机器填）', '');
  L.push(`- 可信 P0 资格计数: ${p0EligibleRuns} / 3`);
  L.push(`- 计入批次的能力样本: ${c.capabilityRuns} / 3`);
  L.push(`- 基础设施失败（不占名额）: ${c.infraFailures}`);
  L.push(`- disabled Workflow 命令验证（不计入 P0）: ${c.disabledWorkflows}`);
  L.push(`- infra 失败重试合计: ${c.totalInfraRetries}`);
  L.push(`- 能力样本中 schema 通过: ${c.schemaPassed} / ${c.capabilityRuns}`);
  L.push('');

  L.push('## 各次运行', '');
  L.push('| run | 类型 | 状态 | schema | infra重试 | 备注 |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of input.runs) {
    const kind = r.outcome === 'capability_run' ? '能力样本' : r.outcome === 'infra_failed' ? 'infra失败' : 'disabled命令验证';
    const note = (r.note ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '); // 转义竖线/换行,防表格串列
    L.push(`| ${r.run_id} | ${kind} | ${r.status} | ${r.schema_valid ? '通过' : '未通过'} | ${r.infra_retries} | ${note} |`);
  }
  L.push('');

  L.push('## P0 判定（研究员填 — 不可自动化）', '');
  L.push('P0 通过批次要求：3 次能力样本均经独立研究员评审，≥2 次判定「可用」，且任一次不得出现来源伪造 / 敏感信息泄漏 / 确认门绕过。');
  L.push('');
  L.push(`- 就绪状态（机器）: ${c.capabilityRuns >= 3 ? '3 次能力样本已齐，待评审' : `能力样本不足 3（当前 ${c.capabilityRuns}），需补齐真跑`}`);
  L.push('- 独立研究员评审汇总（每次 run 的评审表单判定）: ');
  L.push('- 可用次数: ');
  L.push('- 是否出现 P0 硬失败: ');
  L.push('- **本批次是否 P0 通过（研究员结论）**: ');
  L.push('');
  return L.join('\n');
}
