import type { Report } from '../../../packages/api-contract/http.ts';

// 来源类型 → 中文标签。网页渲染与 Markdown 导出共用,保证所见即所得。
export const SOURCE_LABEL: Record<string, string> = {
  user_input: '用户输入',
  knowledge_base: '知识库',
  tool_result: 'Tool 结果',
  llm_inference: 'LLM 推断',
  pending_human_review: '待人工确认',
};

// report → Markdown 纯函数。网页版式与导出同源:同一 report 对象、同一章节顺序、同一证据编号。
// 历史降级:旧报告缺 sub_questions / method_summary / overall_conclusion 时,对应节自然略过,仍列出扁平发现。
export function reportToMarkdown(report: Report): string {
  const lines: string[] = [];

  lines.push('# 研究报告', '');
  lines.push('## 研究背景与目标', '', report.research_goal, '');

  if (report.method_summary) {
    lines.push('## 研究方法', '', report.method_summary, '');
    if (report.capability_orchestration.length > 0) {
      for (const c of report.capability_orchestration) {
        lines.push(`- **${c.capability_type.toUpperCase()}** \`${c.capability_id}\` — ${c.purpose}`);
      }
      lines.push('');
    }
  }

  // 全局证据池:每条带证据编号 [F1] + 中文来源标签 + 可反查引用。
  lines.push('## 关键发现', '');
  for (const f of report.findings) {
    const label = SOURCE_LABEL[f.source] ?? f.source;
    const ref = f.source_ref ? ` · ${f.source_ref}` : '';
    const num = f.id ? `**[${f.id}]** ` : '';
    lines.push(`- ${num}${f.statement} _(${label}${ref})_`);
  }
  lines.push('');

  // 子问题:发现 → 分析(引用 [F1][F3]) → 小结。历史报告无子问题时整节略过。
  for (const sq of report.sub_questions ?? []) {
    lines.push(`## ${sq.question}`, '');
    if (sq.finding_ids.length > 0) {
      lines.push(`相关发现:${sq.finding_ids.map((id) => `[${id}]`).join('')}`, '');
    }
    for (const a of sq.analysis) {
      const cites = a.based_on.map((id) => `[${id}]`).join('');
      lines.push(`- ${a.statement} ${cites}`);
    }
    lines.push('', `**小结:** ${sq.summary}`, '');
  }

  if ((report.overall_conclusion?.length ?? 0) > 0) {
    lines.push('## 总体结论与建议', '');
    for (const c of report.overall_conclusion) lines.push(`- ${c}`);
    lines.push('');
  }

  if (report.risks_and_open_issues && report.risks_and_open_issues.length > 0) {
    lines.push('## 风险与待验证假设', '');
    for (const r of report.risks_and_open_issues) lines.push(`- ${r}`);
    lines.push('');
  }

  if (report.deliverables.length > 0) {
    lines.push('## 产出物清单', '');
    for (const d of report.deliverables) lines.push(`- ${d}`);
    lines.push('');
  }

  if (report.timeline.length > 0) {
    lines.push('## 执行时间线', '');
    for (const t of report.timeline) lines.push(`- \`${t.phase}\` · ${t.activity}`);
    lines.push('');
  }

  return lines.join('\n');
}
