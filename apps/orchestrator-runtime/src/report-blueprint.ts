export interface ReportBlueprint {
  id: string;
  taskType: string;
  title: string;
  requiredDimensions: string[];
  analysisQuestions: string[];
}

const BLUEPRINTS: Record<string, ReportBlueprint> = {
  competitive_research: {
    id: 'competitive-research-v2',
    taskType: 'competitive_research',
    title: '竞品研究报告',
    requiredDimensions: ['对标范围', '能力对比', '体验差异', '机会判断'],
    analysisQuestions: [
      '各对象在哪些能力或体验维度上存在共性、差异和证据缺口？',
      '这些差异对目标业务的影响是什么？',
      '哪些机会适合优先验证，哪些仍只是待验证假设？',
    ],
  },
  design_audit: {
    id: 'design-audit-v2',
    taskType: 'design_audit',
    title: '设计走查报告',
    requiredDimensions: ['视觉层级', '注意力', '美学质量', '品牌一致性'],
    analysisQuestions: [
      '哪些界面问题有明确视觉或量化证据？',
      '问题将如何影响理解、转化或品牌感知？',
      '修复动作的优先级和验证方式是什么？',
    ],
  },
  voc_diagnosis: {
    id: 'voc-diagnosis-v2',
    taskType: 'voc_diagnosis',
    title: '用户之声诊断报告',
    requiredDimensions: ['主题', '人群与频次', '根因假设', '改进路径'],
    analysisQuestions: [
      '哪些反馈主题最突出，影响哪些人群和场景？',
      '哪些根因有证据支持，哪些仍需验证？',
      '改进路线应按什么优先级推进？',
    ],
  },
};

const FALLBACK_BLUEPRINT: ReportBlueprint = {
  id: 'general-research-v2',
  taskType: 'general',
  title: '研究报告',
  requiredDimensions: ['研究范围', '关键发现', '影响评估', '行动建议'],
  analysisQuestions: [
    '证据说明了什么，哪些结论仍属于推断？',
    '这些结论对目标业务有什么影响？',
    '下一步应该优先执行哪些可验证动作？',
  ],
};

export function getReportBlueprint(taskType: string | undefined): ReportBlueprint {
  return BLUEPRINTS[taskType ?? ''] ?? { ...FALLBACK_BLUEPRINT, taskType: taskType || FALLBACK_BLUEPRINT.taskType };
}

export function formatReportBlueprint(blueprint: ReportBlueprint): string {
  return [
    `报告类型：${blueprint.title}（${blueprint.id}）`,
    `维度分析必须覆盖：${blueprint.requiredDimensions.join('、')}。`,
    ...blueprint.analysisQuestions.map((question, index) => `分析问题 ${index + 1}：${question}`),
  ].join('\n');
}
