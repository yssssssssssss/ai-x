import type { Report } from '../../../../packages/api-contract/http.ts';
import { SOURCE_LABEL, reportToMarkdown } from '../../../web/src/report-markdown.ts';

// 金标批次审计包(纯函数层)。ADR-0001/0002 + CONTEXT「批次审计包 / 评审表单」。
// 只做数据 → 文本,不碰 IO / env / 网络,便于离线自测。
// 归档裁剪遵 CONTEXT「长期审计包」清单:不含原始材料 / Base64 / 完整提示词。

export interface RunModelMeta {
  model_name: string;
  model_version: string;
  prompt_hash?: string;
  trace_id?: string;
}

// 单次金标真实运行落审计包所需的裁剪后事实(调用方从 DB / workspace 收集后传入)。
export interface GoldRunRecord {
  run_id: string; // run-1 / run-2 / run-3
  task_id: string;
  batch_id: string;
  scenario_input: string; // 固定金标输入原文(非敏感,可长期留存)
  status: 'completed' | 'completed_with_gaps' | 'paused' | 'failed';
  report: Report | null; // 能力失败 / infra 失败时可能缺
  model: RunModelMeta;
  schema_valid: boolean;
  exec_log: Array<{ step_no: number; actor_type: string; actor_id: string; status: string }>;
  started_at: string;
  finished_at: string;
}

export interface SourceRefRow {
  finding_id: string;
  statement: string;
  source_ref: string;
}

// 报告里所有 tool_result 结论 → 来源核验矩阵行(评审员逐条打开确认的对象)。
export function toolResultSourceRefs(report: Report): SourceRefRow[] {
  return report.findings
    .filter((f) => f.source === 'tool_result')
    .map((f) => ({
      finding_id: f.id,
      statement: f.statement,
      source_ref: f.source_ref ?? '（缺 source_ref — 视为不可核验）',
    }));
}

function trunc(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function findingCountBySource(report: Report): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const f of report.findings) acc[f.source] = (acc[f.source] ?? 0) + 1;
  return acc;
}

// 评审表单:机器预填客观字段,判定与结论字段留空(只能由独立研究员填写)。
export function buildReviewForm(rec: GoldRunRecord): string {
  const L: string[] = [];
  L.push(`# 评审表单 — ${rec.run_id}`, '');
  L.push('> 本表单机器仅预填客观字段。四条最低线判定、来源核验结果、总判定与理由，', '');
  L.push('> 只能由**独立研究员**（不负责本次 Skill/Tool 的用研人员）填写。模型代填即 P0 违规。', '');

  L.push('## 运行客观事实（机器预填）', '');
  L.push(`- batch_id: ${rec.batch_id}`);
  L.push(`- task_id: ${rec.task_id}`);
  L.push(`- 运行状态: ${rec.status}`);
  L.push(`- 模型: ${rec.model.model_name} @ ${rec.model.model_version}`);
  if (rec.model.trace_id) L.push(`- trace_id: ${rec.model.trace_id}`);
  L.push(`- schema 校验: ${rec.schema_valid ? '通过' : '未通过'}`);
  L.push(`- 输入: ${rec.scenario_input}`);
  L.push('');

  if (!rec.report) {
    L.push('## 无报告产出', '');
    L.push('本次运行未产出报告，无法评审可用性。若为基础设施失败，按机制不占批次名额（见 batch.md）。', '');
    return L.join('\n');
  }

  const bySource = findingCountBySource(rec.report);
  L.push('- 结论来源分布: ' +
    Object.entries(bySource).map(([s, n]) => `${SOURCE_LABEL[s] ?? s}=${n}`).join(' | '));
  const gaps = rec.report.risks_and_open_issues ?? [];
  L.push(`- 数据缺口/风险声明: ${gaps.length > 0 ? `已声明 ${gaps.length} 条` : '报告未声明任何缺口（需研究员判断是否真无缺口）'}`);
  L.push('');

  L.push('## 来源核验矩阵（逐条打开确认）', '');
  const rows = toolResultSourceRefs(rec.report);
  if (rows.length === 0) {
    L.push('报告无 tool_result 结论 — 全真闭环下这本身可疑，研究员需判断检索是否真的被使用。', '');
  } else {
    L.push('| finding | 结论（截断） | source_ref | 核验结果（研究员填：可核验/失效/不支持） |');
    L.push('| --- | --- | --- | --- |');
    for (const r of rows) {
      L.push(`| ${r.finding_id} | ${trunc(r.statement)} | ${r.source_ref} | |`);
    }
    L.push('');
  }

  L.push('## 可用性最低线（研究员逐条勾选）', '');
  L.push('- [ ] 关键竞品事实可核验（上表每条 source_ref 均已打开确认）');
  L.push('- [ ] 研究方案可执行');
  L.push('- [ ] 对京东的建议有观察事实或待验证假设支撑');
  L.push('- [ ] 数据缺口与风险未被隐藏');
  L.push('');

  L.push('## 总判定（研究员填写）', '');
  L.push('- 判定（可用 / 需重大修改 / 不可用）: ');
  L.push('- 是否发现 P0 硬失败（来源伪造 / 敏感信息泄漏 / 确认门绕过）: ');
  L.push('- 评审人: ');
  L.push('- 理由: ');
  L.push('');
  return L.join('\n');
}

// 报告 Markdown（复用网页同源导出，保证所见即所得）。
export function buildReportMarkdown(report: Report): string {
  return reportToMarkdown(report);
}
