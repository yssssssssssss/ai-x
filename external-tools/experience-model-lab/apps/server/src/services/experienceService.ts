import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExperienceAnalyzeRequest,
  ExperienceAnalyzeResult,
  ExperienceModelProfile,
  ExperienceModelSelection,
} from '@experience-model-lab/core';
import { env } from '../config/env.js';

const baseProfiles: ExperienceModelProfile[] = [
  { id: 'heart', name: 'HEART 模型', filename: 'HEART模型.pdf', description: '衡量 Happiness、Engagement、Adoption、Retention、Task success。', tags: ['满意度', '留存', '参与', '任务成功', '体验指标'], bestFor: ['产品体验指标', '版本迭代评估', '用户满意度'] },
  { id: 'gsm', name: 'GSM 模型', filename: 'GSM模型.pdf', description: '从 Goal、Signal、Metric 建立指标体系。', tags: ['目标', '信号', '指标', '度量', '北极星'], bestFor: ['指标设计', '目标拆解', '实验评估'] },
  { id: 'jtbd', name: 'Jobs To Be Done', filename: 'Jobs_to_be_Done_Framework模型.pdf', description: '围绕用户要完成的任务理解动机和替代方案。', tags: ['任务', '动机', '场景', '需求', '替代方案'], bestFor: ['需求探索', '机会识别', '新功能定义'] },
  { id: 'kano', name: 'Kano 模型', filename: 'Kano_模型.pdf', description: '区分基本型、期望型、兴奋型需求。', tags: ['需求优先级', '满意', '惊喜', '功能分层'], bestFor: ['需求排序', '功能取舍', '满意度分析'] },
  { id: 'sus', name: 'SUS 模型', filename: 'SUS模型.pdf', description: '快速评估系统可用性。', tags: ['可用性', '易用性', '问卷', '效率'], bestFor: ['可用性测试', '流程优化', '交互评估'] },
  { id: 'nps', name: 'NPS 模型', filename: 'NPS模型.pdf', description: '基于推荐意愿评估口碑和忠诚。', tags: ['推荐', '忠诚', '口碑', '满意度'], bestFor: ['品牌口碑', '用户忠诚', '增长评估'] },
  { id: 'tam', name: 'TAM 模型', filename: 'TAM模型.pdf', description: '从感知有用性和易用性分析技术接受度。', tags: ['接受度', '有用性', '易用性', '技术采纳'], bestFor: ['新产品接受度', 'AI 功能评估', '工具型产品'] },
  { id: 'cognitive_load', name: '认知负荷理论', filename: 'Cognitive_Load_Theory模型.pdf', description: '分析信息复杂度、学习成本和认知压力。', tags: ['认知负荷', '复杂度', '学习成本', '信息架构'], bestFor: ['复杂页面评估', '表单流程', '信息架构'] },
  { id: 'aesthetic_usability', name: '美学可用性效应', filename: 'Aesthetic_Usability_Effect模型.pdf', description: '解释视觉美感对可用性感知的影响。', tags: ['美学', '视觉', '可用性', '设计评审'], bestFor: ['视觉设计评估', '品牌感知', '界面观感'] },
  { id: 'fogg', name: 'Fogg 行为模型', filename: 'Fogg_Behavior_Model模型.pdf', description: '从动机、能力、触发解释用户行为。', tags: ['行为', '转化', '触发', '动机', '能力'], bestFor: ['转化优化', '增长策略', '行为引导'] },
];

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, '');

const scoreProfile = (profile: ExperienceModelProfile, query: string, preferred: string[]): ExperienceModelSelection => {
  const normalizedQuery = normalize(query);
  const reasons: string[] = [];
  let score = 0;
  for (const tag of profile.tags) {
    if (normalizedQuery.includes(normalize(tag))) {
      score += 2;
      reasons.push(`命中关键词「${tag}」`);
    }
  }
  for (const useCase of profile.bestFor) {
    if (normalizedQuery.includes(normalize(useCase))) {
      score += 1.5;
      reasons.push(`匹配场景「${useCase}」`);
    }
  }
  if (preferred.includes(profile.id)) {
    score += 3;
    reasons.push('用户手动偏好');
  }
  if (!reasons.length && ['heart', 'gsm', 'jtbd'].includes(profile.id)) {
    score += 0.8;
    reasons.push('通用体验研究基础模型');
  }
  return { id: profile.id, name: profile.name, filename: profile.filename, score: Number(score.toFixed(2)), reasons };
};

export const listModels = async (): Promise<ExperienceModelProfile[]> => {
  const existing = new Set<string>();
  try {
    const files = await readdir(env.modelDir);
    for (const file of files) {
      const fileStat = await stat(join(env.modelDir, file));
      if (fileStat.isFile()) existing.add(file);
    }
  } catch {
    return baseProfiles;
  }
  return baseProfiles.map((profile) => ({
    ...profile,
    tags: existing.has(profile.filename) ? profile.tags : [...profile.tags, 'missing_pdf'],
  }));
};

export const analyzeExperience = async (request: ExperienceAnalyzeRequest): Promise<ExperienceAnalyzeResult> => {
  const query = request.query?.trim();
  const boundaryNotes = ['体验模型是方法论框架，不是事实证据；输出需要结合真实数据或用户研究验证。'];
  if (!query) {
    return {
      status: 'insufficient_inputs',
      summary: '缺少研究问题，无法推荐体验模型。',
      selectedModels: [],
      rejectedModels: [],
      frameworkSummary: '',
      modelRationale: [],
      questionTemplates: [],
      evidenceChunks: [],
      warnings: ['query is required'],
      boundaryNotes,
    };
  }
  const profiles = await listModels();
  const preferred = [...(request.preferredModelIds || []), ...(request.manualOverrideModelIds || [])];
  const ranked = profiles
    .map((profile) => scoreProfile(profile, query, preferred))
    .sort((left, right) => right.score - left.score);
  const selectedModels = ranked.slice(0, 3);
  const rejectedModels = ranked.slice(3, 8);

  return {
    status: 'available',
    summary: `已为「${query}」推荐 ${selectedModels.length} 个体验模型。`,
    selectedModels,
    rejectedModels,
    frameworkSummary: selectedModels.map((item) => `${item.name}：${item.reasons.join('；')}`).join('\n'),
    modelRationale: selectedModels.flatMap((item) => item.reasons.map((reason) => `${item.name}：${reason}`)),
    questionTemplates: selectedModels.map((item) => `用「${item.name}」分析时，当前方案在哪些场景下会改善或损害用户体验？`),
    evidenceChunks: selectedModels.map((item) => ({
      modelId: item.id,
      filename: item.filename,
      source: 'data/experience-models',
      matchedTerms: item.reasons,
    })),
    warnings: profiles.some((profile) => profile.tags.includes('missing_pdf')) ? ['部分模型 PDF 文件未在本地目录中找到。'] : [],
    boundaryNotes,
  };
};
