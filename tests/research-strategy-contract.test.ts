import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchStrategyReportPayload } from '../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { validateResearchStrategyAnswer } from '../apps/orchestrator-runtime/src/report/answer-quality-validator.ts';
import { collectRequiredRiskDisclosures } from '../apps/orchestrator-runtime/src/report/current-deliverable-service.ts';
import { resolveDeliverable } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';

export function strategyPayload(): ResearchStrategyReportPayload {
  return {
    title: 'Pet strategy', decisionContext: 'Decide next-quarter design priorities', executiveAnswer: 'Trust evidence should precede promotion.',
    directAnswers: [{ questionId: 'Q1', question: 'What should change?', answer: 'Put fit and proof first.', answerStatus: 'supported', evidenceIds: ['E1'], confidence: 0.8, businessImplication: 'Reduce uncertainty', recommendedAction: 'Change PDP hierarchy', validationNeeded: '' }],
    evidenceBackedFindings: [{ id: 'F1', statement: 'Proof improves confidence.', evidenceIds: ['E1'], confidence: 0.8 }],
    dynamicSections: [{ id: 'journey', title: 'Journey strategy', purpose: 'Answer the journey question', blocks: [{ id: 'B1', type: 'narrative', title: 'Purchase', content: 'Lead with fit.', questionIds: ['Q1'], evidenceIds: ['E1'], confidence: 0.8 }] }],
    strategyMap: { title: 'Map', rows: ['Purchase'], columns: ['Trust'], cells: [{ id: 'C1', row: 'Purchase', column: 'Trust', statement: 'Show proof.', evidenceIds: ['E1'], confidence: 0.8 }] },
    mindModel: { title: 'Model', confidence: 0.8, nodes: [{ id: 'N1', label: 'Understand', description: 'Know fit', evidenceIds: ['E1'] }], edges: [] },
    designPrinciples: [{ id: 'P1', title: 'Proof first', statement: 'Show fit and proof before promotion.', evidenceIds: ['E1'], confidence: 0.8 }],
    opportunities: [{ id: 'O1', title: 'Fit card', statement: 'Add a fit card.', evidenceIds: ['E1'], confidence: 0.8, impact: 'Higher confidence' }],
    prioritizedActions: [{ id: 'A1', priority: 'P0', action: 'Ship fit card', ownerType: 'product', rationale: 'Directly addresses uncertainty', evidenceIds: ['E1'], confidence: 0.8, validationMethod: 'Task test' }],
    channelStrategies: [{ id: 'CH1', channel: 'JD', role: 'Purchase proof', strategies: ['Lead with fit'], evidenceIds: ['E1'], confidence: 0.8 }],
    recommendations: ['Ship the fit card.'], limitations: [], openQuestions: [], riskDisclosures: [],
    requestedArtifactBindings: [
      { artifactType: 'strategy_map', sourceField: '/strategyMap', blockIds: ['C1'], questionIds: ['Q1'], evidenceIds: ['E1'], status: 'complete' },
      { artifactType: 'mind_model', sourceField: '/mindModel', blockIds: ['N1'], questionIds: ['Q1'], evidenceIds: ['E1'], status: 'complete' },
      { artifactType: 'design_principles', sourceField: '/designPrinciples', blockIds: ['P1'], questionIds: ['Q1'], evidenceIds: ['E1'], status: 'complete' },
      { artifactType: 'opportunity_backlog', sourceField: '/opportunities', blockIds: ['O1'], questionIds: ['Q1'], evidenceIds: ['E1'], status: 'complete' },
      { artifactType: 'prioritized_actions', sourceField: '/prioritizedActions', blockIds: ['A1'], questionIds: ['Q1'], evidenceIds: ['E1'], status: 'complete' },
    ],
  };
}

const requirement: ResearchTaskV2 = {
  version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer', business_domain: 'pets', research_goal: 'answer strategy', target_audience: ['team'], scope: ['PDP'], constraints: [], success_criteria: [{ id: 'SC1', statement: 'Answer Q1' }], expected_deliverables: ['research_strategy_report'], requested_artifacts: ['strategy_map', 'mind_model', 'design_principles', 'opportunity_backlog', 'prioritized_actions'], assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
};
const graph = { version: 'problem-graph-v1' as const, questions: [{ id: 'Q1', statement: 'What should change?', rationale: 'Decision', priority: 'required' as const, success_criterion_ids: ['SC1'], evidence_requirements: [{ id: 'research-strategy-report', acceptedClasses: ['public_source' as const], minimumCount: 1, required: true }], acceptance_criteria: ['直接答案', '证据', '置信度', '业务含义', '行动'], depends_on: [] }] };

test('risk disclosures preserve requirement, degraded Skill, reviewer, and envelope identities', () => {
  const ambiguousRequirement: ResearchTaskV2 = {
    ...requirement,
    ambiguities: [{ id: 'audience', statement: 'Audience remains uncertain', blocking: false }],
  };
  const disclosures = collectRequiredRiskDisclosures({
    requirement: ambiguousRequirement,
    gaps: ['Skill degraded: missing behavioral data'],
    materials: [{
      stepNo: 3,
      actorType: 'reviewer',
      actorId: 'reviewer.research-lead',
      questionIds: ['Q1'],
      artifactId: 'review-output-1',
      artifactContentSha256: `sha256:${'a'.repeat(64)}`,
      value: {
        version: 'reviewer-step-output-v1',
        review: 'Channel transfer remains lower confidence.',
        verdict: 'pass_with_conditions',
        conditions: [{
          id: 'channel-transfer-triangulation',
          statement: 'Lower confidence for Q1 pending triangulation',
          disposition: 'limitation',
        }],
      },
      semanticRole: 'review',
    }],
    envelopeRisks: ['Envelope-specific risk'],
  });
  assert.deepEqual(disclosures.map(({ sourceType }) => sourceType), [
    'requirement_ambiguity', 'skill_degraded_gap', 'reviewer_condition', 'envelope_risk',
  ]);
  assert.equal(new Set(disclosures.map(({ sourceId }) => sourceId)).size, 4);
});

test('reviewer risk collection uses structured conditions without keyword heuristics', () => {
  const materials = (value: unknown) => [{
    stepNo: 3,
    actorType: 'reviewer' as const,
    actorId: 'reviewer.research-lead',
    questionIds: ['Q1'],
    artifactId: 'review-output-structured',
    artifactContentSha256: `sha256:${'b'.repeat(64)}`,
    value,
    semanticRole: 'review' as const,
  }];
  const keywordless = collectRequiredRiskDisclosures({
    requirement,
    gaps: [],
    materials: materials({
      version: 'reviewer-step-output-v1',
      review: 'One delivery condition remains.',
      verdict: 'pass_with_conditions',
      conditions: [{
        id: 'triangulate-q1',
        statement: 'Lower confidence for Q1 pending triangulation',
        disposition: 'open_question',
      }],
    }),
    envelopeRisks: [],
  });
  assert.deepEqual(keywordless.map(({ statement, disposition }) => ({ statement, disposition })), [{
    statement: 'Lower confidence for Q1 pending triangulation',
    disposition: 'open_question',
  }]);

  const clean = collectRequiredRiskDisclosures({
    requirement,
    gaps: [],
    materials: materials({
      version: 'reviewer-step-output-v1',
      review: 'No unsupported claims remain',
      verdict: 'pass',
      conditions: [],
    }),
    envelopeRisks: [],
  });
  assert.deepEqual(clean, []);
});

test('research strategy payload satisfies its closed schema and answer-quality gate', () => {
  const contract = resolveDeliverable('research_synthesis', ['research_strategy_report']);
  assert.equal(contract.id, 'research_strategy_report');
  const payload = strategyPayload();
  new SchemaValidator().validateFileOrThrow('schemas/deliverables/research-strategy-report.schema.json', payload);
  assert.doesNotThrow(() => validateResearchStrategyAnswer({ payload, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }));
});

test('research strategy schema rejects missing IDs and empty requested structures', () => {
  const validator = new SchemaValidator();
  const missingQuestionId = strategyPayload();
  delete (missingQuestionId.directAnswers[0] as unknown as Record<string, unknown>).questionId;
  assert.throws(() => validator.validateFileOrThrow('schemas/deliverables/research-strategy-report.schema.json', missingQuestionId));

  for (const field of ['cells', 'nodes'] as const) {
    const empty = strategyPayload();
    if (field === 'cells') empty.strategyMap.cells = [];
    else empty.mindModel.nodes = [];
    assert.throws(() => validator.validateFileOrThrow('schemas/deliverables/research-strategy-report.schema.json', empty));
  }

  const invalidAction = strategyPayload();
  delete (invalidAction.prioritizedActions[0] as unknown as Record<string, unknown>).validationMethod;
  assert.throws(() => validator.validateFileOrThrow('schemas/deliverables/research-strategy-report.schema.json', invalidAction));

  for (const mutate of [
    (payload: ResearchStrategyReportPayload) => { delete (payload.mindModel as unknown as Record<string, unknown>).confidence; },
    (payload: ResearchStrategyReportPayload) => { delete (payload.prioritizedActions[0] as unknown as Record<string, unknown>).confidence; },
    (payload: ResearchStrategyReportPayload) => { delete (payload.channelStrategies[0] as unknown as Record<string, unknown>).confidence; },
  ]) {
    const missingConfidence = strategyPayload();
    mutate(missingConfidence);
    assert.throws(() => validator.validateFileOrThrow('schemas/deliverables/research-strategy-report.schema.json', missingConfidence));
  }
});

test('answer quality rejects missing answers, unsupported claims, and missing requested artifacts', () => {
  const missing = strategyPayload();
  missing.directAnswers = [];
  assert.throws(() => validateResearchStrategyAnswer({ payload: missing, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }), /no direct answer/u);
  const unsupported = strategyPayload();
  unsupported.directAnswers[0]!.evidenceIds = [];
  assert.throws(() => validateResearchStrategyAnswer({ payload: unsupported, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }), /no Evidence/u);
  const unbound = strategyPayload();
  unbound.requestedArtifactBindings = unbound.requestedArtifactBindings.filter(({ artifactType }) => artifactType !== 'strategy_map');
  assert.throws(() => validateResearchStrategyAnswer({ payload: unbound, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }), /strategy_map/u);
});

test('answer quality rejects dangling strategy evidence, incomplete bindings, and undisclosed uncertainty', () => {
  const dangling = strategyPayload();
  dangling.prioritizedActions[0]!.evidenceIds = ['E-unknown'];
  assert.throws(
    () => validateResearchStrategyAnswer({ payload: dangling, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }),
    /unknown Evidence E-unknown/u,
  );

  const incomplete = strategyPayload();
  incomplete.requestedArtifactBindings[0]!.evidenceIds = [];
  assert.throws(
    () => validateResearchStrategyAnswer({ payload: incomplete, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }),
    /has no Evidence|incomplete Evidence binding/u,
  );

  const provisional = strategyPayload();
  provisional.directAnswers[0]!.answerStatus = 'provisional';
  provisional.directAnswers[0]!.validationNeeded = 'Interview affected users';
  assert.throws(
    () => validateResearchStrategyAnswer({ payload: provisional, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }),
    /risk disclosures do not exactly match|required sources/u,
  );

  const reviewerCondition = strategyPayload();
  assert.throws(
    () => validateResearchStrategyAnswer({ payload: reviewerCondition, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: ['Reviewer condition: validate the priority externally'] }),
    /envelope risk is not disclosed/u,
  );

  const exactRisk = strategyPayload();
  const requiredRisk = {
    id: 'risk-gap-gap-1', sourceType: 'skill_degraded_gap' as const, sourceId: 'gap-1',
    statement: 'Knowledge coverage degraded', disposition: 'limitation' as const,
  };
  exactRisk.riskDisclosures = [requiredRisk];
  exactRisk.limitations = ['generic limitation'];
  assert.throws(
    () => validateResearchStrategyAnswer({ payload: exactRisk, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: ['Knowledge coverage degraded'], requiredRiskDisclosures: [requiredRisk] }),
    /absent from limitation/u,
  );
  exactRisk.limitations = ['Knowledge coverage degraded'];
  assert.doesNotThrow(
    () => validateResearchStrategyAnswer({ payload: exactRisk, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: ['Knowledge coverage degraded'], requiredRiskDisclosures: [requiredRisk] }),
  );

  const deferred = strategyPayload();
  deferred.directAnswers[0]!.answer = '建议进一步研究';
  assert.throws(
    () => validateResearchStrategyAnswer({ payload: deferred, requirement, problemGraph: graph, evidenceIds: ['E1'], risksAndOpenIssues: [] }),
    /defers to future research/u,
  );
});
