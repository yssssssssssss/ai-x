// 规则种子:type/文件名/标题 → tags + guide_stage(归一到 taxonomy)。Task 4 充实。
export function seedTagsGuideStage(
  type: string,
  _stem: string,
  _title: string,
): { tags: string[]; guide_stage: string[] } {
  const guide_stage =
    type === 'model' ? ['need-discovery']
    : type === 'standard' ? ['output-standard']
    : type.startsWith('toolbox') ? ['method-selection']
    : type === 'scenario' ? ['intent', 'goal-definition']
    : [];
  return { tags: [], guide_stage };
}

// skill → task_types 种子。Task 4 充实。
export function seedSkillTaskTypes(_stem: string, _title: string): string[] {
  return [];
}
