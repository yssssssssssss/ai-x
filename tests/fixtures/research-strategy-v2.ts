import type {
  FindingGraph,
  ReportLayoutBlueprintV1,
  ResearchDeliverableCoverage,
  ResearchStrategyReportPayloadV2,
} from '../../packages/api-contract/research-deliverable.ts';

const support = {
  questionIds: ['Q1'],
  evidenceIds: ['E1'],
  confidence: 0.8,
  status: 'supported' as const,
  validationNeeded: '',
};

export function researchStrategyPayloadV2(): ResearchStrategyReportPayloadV2 {
  return {
    schemaVersion: 'research-strategy-content-v2',
    title: 'Open strategy report',
    decisionContext: 'Choose the next product investment.',
    executiveAnswer: 'Lead with verifiable trust signals.',
    directAnswers: [{
      questionId: 'Q1',
      question: 'What should change?',
      answer: 'Lead with verifiable trust signals.',
      answerStatus: 'supported',
      evidenceIds: ['E1'],
      confidence: 0.8,
      businessImplication: 'Reduce decision uncertainty.',
      recommendedAction: 'Ship a source-backed trust card.',
      validationNeeded: '',
    }],
    evidenceFindings: [{
      id: 'evidence-finding-001',
      statement: 'Verified source information is a decision signal.',
      support,
    }],
    contentBlocks: [{
      id: 'content-block-001',
      kind: 'strategy_map',
      title: 'Trust strategy map',
      rows: ['Trust'],
      columns: ['Purchase'],
      cells: [{
        id: 'content-block-001-item-001',
        row: 'Trust',
        column: 'Purchase',
        statement: 'Expose source evidence before value claims.',
        support,
      }],
    }, {
      id: 'content-block-002',
      kind: 'prioritized_actions',
      title: 'Priority actions',
      items: [{
        id: 'content-block-002-item-001',
        priority: 'P0',
        action: 'Ship a trust card.',
        ownerType: 'product',
        rationale: 'It exposes the strongest evidence early.',
        validationMethod: 'A/B test conversion and evidence-detail opens.',
        support,
      }],
    }],
    limitations: [],
    openQuestions: [],
    riskDisclosures: [],
    requestedArtifactBindings: [{
      artifactType: 'executive_answers',
      sourceField: '/directAnswers',
      blockIds: ['answer-Q1'],
      questionIds: ['Q1'],
      evidenceIds: ['E1'],
      status: 'complete',
    }, {
      artifactType: 'strategy_map',
      sourceField: '/contentBlocks',
      blockIds: ['content-block-001'],
      questionIds: ['Q1'],
      evidenceIds: ['E1'],
      status: 'complete',
    }, {
      artifactType: 'prioritized_actions',
      sourceField: '/contentBlocks',
      blockIds: ['content-block-002'],
      questionIds: ['Q1'],
      evidenceIds: ['E1'],
      status: 'complete',
    }],
  };
}

export function researchStrategyFindingGraphV2(): FindingGraph {
  return {
    findings: [{
      id: 'evidence-finding-001',
      kind: 'fact',
      evidenceIds: ['E1'],
      statement: 'Verified source information is a decision signal.',
    }],
    analyses: [{
      id: 'analysis-content-block-001',
      findingIds: ['evidence-finding-001'],
      statement: 'Trust strategy map',
    }, {
      id: 'analysis-content-block-002',
      findingIds: ['evidence-finding-001'],
      statement: 'Priority actions',
    }],
    subQuestionSummaries: [{
      id: 'summary-Q1',
      findingIds: ['evidence-finding-001'],
      analysisIds: ['analysis-content-block-001', 'analysis-content-block-002'],
      summary: 'Lead with verifiable trust signals.',
    }],
    overallConclusions: [{
      id: 'conclusion-Q1',
      summaryIds: ['summary-Q1'],
      statement: 'Lead with verifiable trust signals.',
    }],
  };
}

export function researchStrategyCoverageV2(): ResearchDeliverableCoverage {
  return {
    questionBindings: [{ questionId: 'Q1', summaryIds: ['summary-Q1'] }],
    successCriterionBindings: [{
      successCriterionId: 'SC1',
      conclusionIds: ['conclusion-Q1'],
      recommendationIds: ['recommendation-Q1'],
    }],
  };
}

export function researchStrategyLayoutV1(): ReportLayoutBlueprintV1 {
  return {
    version: 'report-layout-blueprint-v1',
    sections: [{
      title: 'Act first',
      purpose: 'Put the immediate decision first.',
      prominence: 'primary',
      blockRefs: ['content-block-002'],
    }, {
      title: 'Why it works',
      purpose: 'Explain the strategy model.',
      prominence: 'supporting',
      blockRefs: ['content-block-001'],
    }],
  };
}
