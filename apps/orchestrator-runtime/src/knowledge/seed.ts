import { loadTaxonomy } from './taxonomy.ts';

// 关键词 → tag 种子表(覆盖 decision-graph related_tags 的可召回性)。
const KEYWORD_TAG: Array<[RegExp, string[]]> = [
  [/persona|画像|人群/i, ['persona', 'audience']],
  [/interview|访谈/i, ['qualitative', 'method']],
  [/survey|questionnaire|问卷|量表/i, ['quantitative', 'method']],
  [/competitive|竞品|对标/i, ['business-competitive', 'ui-competitive']],
  [/a11y|accessibility|无障碍/i, ['a11y', 'ux-audit']],
  [/heuristic|usability|可用性|走查|启发/i, ['ux-audit']],
  [/report|报告|pyramid|金字塔/i, ['report', 'output']],
  // 抽样/招募/知情同意天然涉及数据敏感与合规, 一并种 privacy/compliance 供 D6_data_sensitivity 召回
  [/sampling|抽样|recruit|招募|consent|授权|知情/i, ['audience', 'method', 'privacy', 'compliance']],
  [/goal|目标|question|问题定义|5w2h/i, ['research_goal']],
  [/privacy|隐私|compliance|合规/i, ['privacy', 'compliance']],
  [/digital.?human|数字人/i, ['digital_human']],
  [/jtbd|kano|model|模型|framework|框架/i, ['framework']],
];

const TYPE_GUIDE_STAGE: Record<string, string[]> = {
  model: ['need-discovery'],
  standard: ['output-standard'],
  'toolbox-collection': ['method-selection'],
  'toolbox-analysis': ['method-selection'],
  scenario: ['intent', 'goal-definition'],
  skill: [],
};

// 产出受控 guide_tags(对齐 decision-graph related_tags)+ guide_stage。
// 注意:guideTags 是受控引导标签, 与 wiki 原生自由中文 tags 是两个独立字段。
export function seedTagsGuideStage(
  type: string,
  stem: string,
  title: string,
): { guideTags: string[]; guide_stage: string[] } {
  const { tags: vocab, guide_stages } = loadTaxonomy();
  const tagVocab = new Set(vocab);
  const stageVocab = new Set(guide_stages);
  const hay = `${stem} ${title}`;

  const guideTags = new Set<string>();
  for (const [re, ts] of KEYWORD_TAG) {
    if (re.test(hay)) ts.forEach((t) => guideTags.add(t));
  }
  // 归一:丢弃 taxonomy 之外的
  const normTags = [...guideTags].filter((t) => tagVocab.has(t));
  const normStage = (TYPE_GUIDE_STAGE[type] ?? []).filter((s) => stageVocab.has(s));
  return { guideTags: normTags, guide_stage: normStage };
}

// skill 文件名/标题 → ResearchTask.task_type 种子(供 router 精准路由)。
const SKILL_TASK_TYPE: Array<[RegExp, string[]]> = [
  [/competitive|竞品/i, ['competitive_research']],
  [/satisfaction|voc|feedback|满意度|反馈/i, ['voc_diagnosis']],
  [/accessibility|a11y|无障碍/i, ['a11y_audit']],
  [/heuristic|usability|走查|启发|可用性/i, ['design_audit']],
];

export function seedSkillTaskTypes(stem: string, title: string): string[] {
  const hay = `${stem} ${title}`;
  for (const [re, tt] of SKILL_TASK_TYPE) {
    if (re.test(hay)) return tt;
  }
  // 兜底:generate-*、plan、interview、survey、persona、journey… 归 用研规划
  return ['user_research_planning'];
}
