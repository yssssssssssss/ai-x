import type {
  IndustryMarketAnalysisPayloadV1,
  IndustryMarketCoverageEntryV1,
} from '../../packages/api-contract/research-deliverable.ts';

function support(status: 'supported' | 'provisional' | 'unavailable' = 'supported') {
  return {
    questionIds: ['question-1'],
    evidenceIds: status === 'supported' ? ['E1-1'] : [],
    status,
    confidence: status === 'supported' ? 0.8 : 0.3,
    validationNeeded: status === 'supported' ? '' : '补充用户或经营数据。',
  };
}

function section(status: 'supported' | 'provisional' | 'unavailable' = 'supported') {
  return {
    status,
    summary: status === 'unavailable' ? '当前没有足够资料。' : '当前材料支持一项领域判断。',
    items: status === 'unavailable' ? [] : [{
      id: 'item-1',
      title: '领域判断',
      statement: '当前样本强调可比较性与证据透明度。',
      support: support(status),
    }],
  };
}

export function validIndustryMarketPayload(): IndustryMarketAnalysisPayloadV1 {
  return {
    schemaVersion: 'industry-market-analysis-v1',
    title: '宠物食品行业与体验策略报告',
    scope: {
      category: '宠物食品',
      subcategories: ['猫用冻干'],
      exclusions: ['线下渠道'],
      analysisDepth: 'medium',
      primaryFocus: '竞品与设计策略',
      secondaryFocuses: ['用户洞察'],
      decisionAudience: ['频道产品与设计团队'],
      decisionGoal: '确定频道改版优先级',
      timeWindow: '最近十二个月',
    },
    coverageLedger: ('ABCDEFGHIJ'.split('') as IndustryMarketCoverageEntryV1['dimension'][]).map((dimension) => ({
      dimension,
      status: dimension === 'B' ? 'unavailable' : 'supported',
      summary: dimension === 'B' ? '缺少真实用户资料。' : `维度 ${dimension} 已覆盖。`,
      evidenceIds: dimension === 'B' ? [] : ['E1-1'],
      gapIds: dimension === 'B' ? ['gap-users'] : [],
    })),
    marketLandscape: section(),
    audienceSegments: {
      ...section('unavailable'),
      basisType: 'qualitative_draft',
      coreVariables: [],
      supportingVariables: [],
      sampleCoverage: '未提供真实用户样本。',
      segments: [],
      personas: [],
      differences: [],
      designImplications: [],
    },
    supplyLandscape: section(),
    competitorAnalysis: {
      ...section(),
      competitorSamples: [{
        id: 'sample-1',
        name: '竞品平台 A',
        rationale: '用户提供截图。',
        evidenceIds: ['E1-1'],
      }],
      dimensionMatrix: [{
        dimension: '信息透明度',
        values: [{ sampleId: 'sample-1', value: '展示配方宣称。', evidenceIds: ['E1-1'] }],
      }],
      differences: [],
      impacts: [],
      visualEvidence: [],
      screenshotComparisons: [],
    },
    jdDiagnosis: section('unavailable'),
    validatedFindings: [{
      id: 'finding-1',
      statement: '当前样本强调冻干与配方宣称。',
      support: support(),
    }],
    gapMatrix: [],
    positioning: {
      statement: '以可信决策辅助形成品类差异。',
      exclusions: ['不把营销宣称当成功效事实。'],
      support: support('provisional'),
    },
    opportunities: [{
      id: 'opportunity-1',
      title: '建立证据卡',
      statement: '统一展示配方、适用对象和来源。',
      priority: 'P0',
      support: support('provisional'),
    }],
    strategyChains: [{
      id: 'strategy-1',
      priority: 'P0',
      opportunityId: 'opportunity-1',
      title: '配方证据链',
      goal: '降低配方理解成本。',
      currentProblem: '标题宣称缺少证据说明。',
      currentEvidenceIds: ['E1-1'],
      currentScreenshotAssetIds: [],
      competitorReference: '竞品平台 A 的标题宣称。',
      competitorEvidenceIds: ['E1-1'],
      designAction: '增加配方证据卡。',
      categoryAssetRefs: ['asset-1'],
      ownerType: '产品与设计',
      measurement: '证据卡点击和理解正确率。',
      validationMethod: '可用性测试与行为埋点。',
      wireframeAssetId: null,
      support: support('provisional'),
    }],
    designLanguage: section('provisional'),
    categoryAssets: [{
      id: 'asset-1',
      family: 'mental_anchor',
      name: '可信喂养决策',
      fitness: 'recommended',
      rationale: '与配方透明和风险判断直接相关。',
      benchmarkEvidenceIds: ['E1-1'],
      collectedAt: '2026-09-03T00:00:00.000Z',
      reviewStatus: 'pending_review',
      platformInheritance: '继承平台基础组件与功能色。',
      categoryDelta: '增加配方和适用对象证据表达。',
      support: support('provisional'),
    }],
    measurementPlan: [{
      id: 'metric-1',
      name: '配方理解正确率',
      definition: '用户能否正确说明适用对象与核心配方。',
      baseline: null,
      target: null,
      validationMethod: '任务测试。',
      support: support('provisional'),
    }],
    dataGaps: [{
      id: 'gap-users',
      dimensionIds: ['B'],
      statement: '缺少真实用户数据。',
      impact: '不能形成真实用户分层。',
      resolutionPath: '提交匿名用户研究 CSV。',
    }],
  };
}
