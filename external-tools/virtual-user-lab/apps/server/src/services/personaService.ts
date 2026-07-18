import type { PersonaProfile, PersonaReview, VirtualUserSimulateRequest, VirtualUserSimulateResult } from '@virtual-user-lab/core';
import { chatJSON, isLLMEnabled } from './llmClient.js';

const builtInPersonas: PersonaProfile[] = [
  {
    id: 'price_sensitive',
    name: '林敏',
    type: '价格敏感型用户',
    description: '重视性价比和明确收益，对复杂促销和隐性成本敏感。',
    goals: ['快速判断是否值得买', '减少比价成本', '找到可信优惠'],
    concerns: ['价格不透明', '信息过载', '优惠规则复杂'],
  },
  {
    id: 'content_driven',
    name: '周祺',
    type: '内容消费型用户',
    description: '容易被真实场景、达人内容和故事化表达影响。',
    goals: ['获得购买灵感', '看到真实使用场景', '确认商品风格是否匹配自己'],
    concerns: ['内容像广告', '缺少真实细节', '推荐不够个性化'],
  },
  {
    id: 'efficiency_first',
    name: '陈睿',
    type: '效率优先型用户',
    description: '目标明确，关注路径短、信息清楚和操作效率。',
    goals: ['快速找到目标商品', '减少跳转', '明确下一步动作'],
    concerns: ['入口分散', '视觉干扰', '核心动作不突出'],
  },
  {
    id: 'trust_cautious',
    name: '许安',
    type: '信任谨慎型用户',
    description: '对平台背书、评价质量和风险提示高度敏感。',
    goals: ['确认平台可信', '降低踩坑风险', '理解售后保障'],
    concerns: ['评价失真', '品牌背书不足', '风险说明不清楚'],
  },
];

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const average = (values: Array<number | undefined>) => {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return undefined;
  return round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
};

const hit = (text: string, terms: string[]) => terms.some((term) => text.includes(term));

const scoreForPersona = (text: string, persona: PersonaProfile) => {
  let score = 0.55;
  if (hit(text, persona.goals)) score += 0.18;
  if (hit(text, persona.concerns)) score -= 0.16;
  if (hit(text, ['信任', '保障', '评价', '真实'])) score += persona.id === 'trust_cautious' ? 0.16 : 0.04;
  if (hit(text, ['优惠', '价格', '性价比'])) score += persona.id === 'price_sensitive' ? 0.14 : 0.02;
  if (hit(text, ['内容', '种草', '场景', '达人'])) score += persona.id === 'content_driven' ? 0.16 : 0.03;
  if (hit(text, ['效率', '快速', '路径', '入口'])) score += persona.id === 'efficiency_first' ? 0.15 : 0.03;
  return clamp(score, 0.18, 0.92);
};

const stanceFromScore = (score: number): PersonaReview['stance'] => {
  if (score >= 0.72) return 'positive';
  if (score <= 0.42) return 'negative';
  return 'mixed';
};

const buildReview = (persona: PersonaProfile, text: string): PersonaReview => {
  const base = scoreForPersona(text, persona);
  const usability = clamp(base + (persona.id === 'efficiency_first' ? 0.05 : 0));
  const attractiveness = clamp(base + (persona.id === 'content_driven' ? 0.08 : -0.01));
  const trust = clamp(base + (persona.id === 'trust_cautious' ? 0.04 : 0));
  const conversionIntent = clamp(base + (persona.id === 'price_sensitive' ? 0.03 : 0));
  const emotionalResonance = clamp(base + (persona.id === 'content_driven' ? 0.06 : -0.02));
  const overallScore = round(average([usability, attractiveness, trust, conversionIntent, emotionalResonance]) || base);
  const concern = persona.concerns.find((item) => text.includes(item)) || persona.concerns[0];
  const goal = persona.goals.find((item) => text.includes(item)) || persona.goals[0];

  return {
    profileId: persona.id,
    personaName: persona.name,
    personaType: persona.type,
    firstImpression: overallScore >= 0.7 ? `这个方案能帮助我${goal}。` : `这个方案有价值，但我会先担心${concern}。`,
    detailedExperience: `从「${persona.type}」视角看，当前方案最相关的目标是「${goal}」，主要阻力是「${concern}」。`,
    scores: {
      usability: round(usability),
      attractiveness: round(attractiveness),
      trust: round(trust),
      conversionIntent: round(conversionIntent),
      emotionalResonance: round(emotionalResonance),
    },
    overallScore,
    topChangeRequest: `补强「${concern}」相关说明，降低决策阻力。`,
    stance: stanceFromScore(overallScore),
    isSimulated: true,
  };
};

export const listPersonas = () => builtInPersonas;

// LLM 扮演全部人格,一次调用生成评审。返回规整后的 PersonaReview[];失败由调用方降级。
async function buildReviewsViaLLM(
  personas: PersonaProfile[],
  materials: string,
  dimensions: string[],
): Promise<PersonaReview[]> {
  const dims = dimensions.length ? dimensions.join('、') : 'usability、attractiveness、trust、conversionIntent、emotionalResonance';
  const messages = [
    {
      role: 'system',
      content:
        '你是用户体验研究中的「数字用户」模拟器。你将分别扮演给定的多个用户人格,基于产品素材以第一人称给出真实、具体、差异化的体验评审。' +
        '不同人格的关注点和结论要有明显差异,结合素材细节,勿套话。只输出 JSON,不要 markdown。',
    },
    {
      role: 'user',
      content:
        `产品/场景素材:\n${materials}\n\n` +
        `评审维度:${dims}\n\n` +
        `需要扮演的人格:\n${personas
          .map((p) => `- ${p.id} ${p.name}(${p.type}):${p.description};目标:${p.goals.join('/')};顾虑:${p.concerns.join('/')}`)
          .join('\n')}\n\n` +
        `为每个人格输出一条评审,返回 JSON:\n` +
        `{"reviews":[{"profileId":"<人格id>","firstImpression":"一句话初印象","detailedExperience":"结合素材的详细体验(2-4句)","scores":{"usability":0-1,"attractiveness":0-1,"trust":0-1,"conversionIntent":0-1,"emotionalResonance":0-1},"overallScore":0-1,"topChangeRequest":"最想要的一个改进","stance":"positive|mixed|negative"}]}\n` +
        `所有分值为 0~1 小数;profileId 必须用上面给的 id;评审要体现该人格独有视角。`,
    },
  ];
  const out = await chatJSON<{ reviews?: Array<Record<string, unknown>> }>(messages);
  const arr = Array.isArray(out?.reviews) ? out.reviews : [];
  const num = (v: unknown, d = 0.6) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v) : d);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return personas.map((p) => {
    const r = (arr.find((x) => x?.profileId === p.id) ?? {}) as Record<string, unknown>;
    const s = (r.scores ?? {}) as Record<string, unknown>;
    const scores = {
      usability: round(num(s.usability)),
      attractiveness: round(num(s.attractiveness)),
      trust: round(num(s.trust)),
      conversionIntent: round(num(s.conversionIntent)),
      emotionalResonance: round(num(s.emotionalResonance)),
    };
    const overallScore = round(
      typeof r.overallScore === 'number' && Number.isFinite(r.overallScore)
        ? clamp(r.overallScore as number)
        : average(Object.values(scores)) || 0.6,
    );
    const stance = (['positive', 'mixed', 'negative'] as const).includes(r.stance as PersonaReview['stance'])
      ? (r.stance as PersonaReview['stance'])
      : stanceFromScore(overallScore);
    return {
      profileId: p.id,
      personaName: p.name,
      personaType: p.type,
      firstImpression: str(r.firstImpression) || `作为「${p.type}」,我的初步印象比较一般。`,
      detailedExperience: str(r.detailedExperience) || `从「${p.type}」视角看,该方案与我的目标和顾虑相关。`,
      scores,
      overallScore,
      topChangeRequest: str(r.topChangeRequest) || `优化与「${p.concerns[0]}」相关的体验。`,
      stance,
      isSimulated: true,
    };
  });
}

export const simulateVirtualUsers = async (request: VirtualUserSimulateRequest): Promise<VirtualUserSimulateResult> => {
  const scenario = request.scenario?.trim();
  const text = [request.scenario, request.productDescription, request.artifactText, ...(request.targetUserGroups || [])]
    .filter(Boolean)
    .join(' ');
  const boundaryNotes = [
    '本结果是虚拟用户模拟，不是真实用户访谈、问卷或实验数据。',
    '评审由 LLM 扮演数字人格生成（LLM 不可用时降级为规则模拟），仍非真实用户数据。',
    '建议把输出作为假设和评审线索，再用真实用户研究验证。',
  ];
  if (!scenario) {
    return {
      status: 'insufficient_inputs',
      isSimulated: true,
      summary: '缺少模拟场景，无法生成虚拟用户反馈。',
      digitalPersonas: [],
      reviews: [],
      aggregate: { scoreSummary: {}, sharedPainPoints: [], sharedHighlights: [], divergences: [], churnRisks: [] },
      recommendations: ['补充产品场景或评审对象。'],
      warnings: ['scenario is required'],
      boundaryNotes,
    };
  }
  const personas = request.personaProfiles?.length ? request.personaProfiles : builtInPersonas;
  // 优先 LLM 扮演人格生成评审;未配置或调用失败 → 降级现有规则模拟(不阻断)。
  let reviews: PersonaReview[];
  if (isLLMEnabled()) {
    try {
      reviews = await buildReviewsViaLLM(personas, text, request.reviewDimensions ?? []);
    } catch {
      reviews = personas.map((persona) => buildReview(persona, text));
    }
  } else {
    reviews = personas.map((persona) => buildReview(persona, text));
  }
  const aggregate = {
    scoreSummary: {
      usability: average(reviews.map((review) => review.scores.usability)),
      attractiveness: average(reviews.map((review) => review.scores.attractiveness)),
      trust: average(reviews.map((review) => review.scores.trust)),
      conversionIntent: average(reviews.map((review) => review.scores.conversionIntent)),
      emotionalResonance: average(reviews.map((review) => review.scores.emotionalResonance)),
    },
    sharedPainPoints: reviews.map((review) => review.topChangeRequest).slice(0, 3),
    sharedHighlights: reviews.map((review) => review.firstImpression).filter((item) => item.includes('帮助')).slice(0, 3),
    divergences: ['不同 persona 对效率、内容吸引和信任背书的权重不同。'],
    churnRisks: reviews.filter((review) => review.stance !== 'positive').map((review) => review.detailedExperience).slice(0, 3),
  };
  return {
    status: 'available',
    isSimulated: true,
    summary: `已生成 ${reviews.length} 个虚拟用户模拟反馈。`,
    digitalPersonas: personas,
    reviews,
    aggregate,
    recommendations: aggregate.sharedPainPoints,
    warnings: [],
    boundaryNotes,
  };
};
