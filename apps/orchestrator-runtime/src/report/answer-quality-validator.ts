import type { RequestedArtifact, ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type {
  ProblemGraph,
  ResearchStrategyReportPayload,
  ResearchStrategyRiskDisclosure,
} from '../../../../packages/api-contract/research-deliverable.ts';

export class AnswerQualityValidationError extends Error {
  constructor(message: string) {
    super(`Answer quality validation failed: ${message}`);
    this.name = 'AnswerQualityValidationError';
  }
}

function fail(message: string): never {
  throw new AnswerQualityValidationError(message);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} IDs must be unique`);
}

function assertKnownEvidence(
  evidenceIds: readonly string[],
  knownEvidence: ReadonlySet<string>,
  label: string,
  required = true,
): void {
  assertUnique(evidenceIds, `${label} Evidence`);
  if (required && evidenceIds.length === 0) fail(`${label} has no Evidence`);
  for (const evidenceId of evidenceIds) {
    if (!knownEvidence.has(evidenceId)) fail(`${label} references unknown Evidence ${evidenceId}`);
  }
}

function assertKnownQuestions(
  questionIds: readonly string[],
  knownQuestions: ReadonlySet<string>,
  label: string,
  required = false,
): void {
  assertUnique(questionIds, `${label} question`);
  if (required && questionIds.length === 0) fail(`${label} has no question binding`);
  for (const questionId of questionIds) {
    if (!knownQuestions.has(questionId)) fail(`${label} references unknown question ${questionId}`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => new Set(right).has(id));
}

function isResearchDeferralOnly(answer: string): boolean {
  const normalized = answer.trim().replace(/[。.!！?？]+$/gu, '');
  return /^(?:(?:建议|需要|应当|必须)(?:先|后续|进一步)?(?:开展|进行|补充)?(?:用户)?(?:研究|调研|访谈|问卷)|(?:further|additional) research (?:is )?(?:needed|required|recommended))$/iu.test(normalized);
}

function normalizedRisk(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function disclosureIdentity(disclosure: ResearchStrategyRiskDisclosure): string {
  return `${disclosure.sourceType}:${disclosure.sourceId}`;
}

interface ArtifactProjection {
  sourceField: string;
  blockIds: string[];
  questionIds: string[];
  evidenceIds: string[];
}

function artifactProjection(
  artifact: RequestedArtifact,
  payload: ResearchStrategyReportPayload,
): ArtifactProjection {
  switch (artifact) {
    case 'executive_answers':
      return {
        sourceField: '/directAnswers',
        blockIds: payload.directAnswers.map(({ questionId }) => questionId),
        questionIds: payload.directAnswers.map(({ questionId }) => questionId),
        evidenceIds: payload.directAnswers.flatMap(({ evidenceIds }) => evidenceIds),
      };
    case 'research_report':
      return {
        sourceField: '/dynamicSections',
        blockIds: payload.dynamicSections.flatMap(({ blocks }) => blocks.map(({ id }) => id)),
        questionIds: payload.dynamicSections.flatMap(({ blocks }) => blocks.flatMap(({ questionIds }) => questionIds)),
        evidenceIds: payload.dynamicSections.flatMap(({ blocks }) => blocks.flatMap(({ evidenceIds }) => evidenceIds)),
      };
    case 'strategy_map':
      return {
        sourceField: '/strategyMap',
        blockIds: payload.strategyMap.cells.map(({ id }) => id),
        questionIds: [],
        evidenceIds: payload.strategyMap.cells.flatMap(({ evidenceIds }) => evidenceIds),
      };
    case 'mind_model':
      return {
        sourceField: '/mindModel',
        blockIds: payload.mindModel.nodes.map(({ id }) => id),
        questionIds: [],
        evidenceIds: payload.mindModel.nodes.flatMap(({ evidenceIds }) => evidenceIds),
      };
    case 'design_principles':
      return {
        sourceField: '/designPrinciples',
        blockIds: payload.designPrinciples.map(({ id }) => id),
        questionIds: [],
        evidenceIds: payload.designPrinciples.flatMap(({ evidenceIds }) => evidenceIds),
      };
    case 'opportunity_backlog':
      return {
        sourceField: '/opportunities',
        blockIds: payload.opportunities.map(({ id }) => id),
        questionIds: [],
        evidenceIds: payload.opportunities.flatMap(({ evidenceIds }) => evidenceIds),
      };
    case 'prioritized_actions':
    case 'action_plan':
      return {
        sourceField: '/prioritizedActions',
        blockIds: payload.prioritizedActions.map(({ id }) => id),
        questionIds: [],
        evidenceIds: payload.prioritizedActions.flatMap(({ evidenceIds }) => evidenceIds),
      };
    case 'channel_strategies':
      return {
        sourceField: '/channelStrategies',
        blockIds: payload.channelStrategies.map(({ id }) => id),
        questionIds: [],
        evidenceIds: payload.channelStrategies.flatMap(({ evidenceIds }) => evidenceIds),
      };
  }
}

export function validateResearchStrategyAnswer(input: {
  payload: ResearchStrategyReportPayload;
  requirement: ResearchTaskV2;
  problemGraph: ProblemGraph;
  evidenceIds: readonly string[];
  risksAndOpenIssues: readonly string[];
  requiredRiskDisclosures?: readonly ResearchStrategyRiskDisclosure[];
}): void {
  const { payload, requirement, problemGraph } = input;
  const evidence = new Set(input.evidenceIds);
  const knownQuestions = new Set(problemGraph.questions.map(({ id }) => id));
  const requiredQuestions = problemGraph.questions.filter(({ priority }) => priority === 'required');
  const answers = new Map(payload.directAnswers.map((answer) => [answer.questionId, answer]));
  if (answers.size !== payload.directAnswers.length) fail('direct answer question IDs must be unique');

  for (const answer of payload.directAnswers) {
    assertKnownQuestions([answer.questionId], knownQuestions, `direct answer ${answer.questionId}`);
    if (isResearchDeferralOnly(answer.answer)) fail(`direct answer ${answer.questionId} defers to future research without an answer`);
    if (answer.answerStatus === 'supported') {
      assertKnownEvidence(answer.evidenceIds, evidence, `supported answer ${answer.questionId}`);
    } else {
      assertKnownEvidence(answer.evidenceIds, evidence, `answer ${answer.questionId}`, false);
    }
    if (answer.answerStatus !== 'supported' && !answer.validationNeeded.trim()) {
      fail(`${answer.answerStatus} answer ${answer.questionId} has no validation need`);
    }
  }
  for (const question of requiredQuestions) {
    const answer = answers.get(question.id);
    if (!answer) fail(`required question ${question.id} has no direct answer`);
    if (answer.answerStatus === 'unanswered') fail(`required question ${question.id} remains unanswered`);
  }

  assertUnique(payload.evidenceBackedFindings.map(({ id }) => id), 'finding');
  for (const finding of payload.evidenceBackedFindings) {
    assertKnownEvidence(finding.evidenceIds, evidence, `finding ${finding.id}`);
  }
  assertUnique(payload.dynamicSections.map(({ id }) => id), 'dynamic section');
  const dynamicBlockIds = payload.dynamicSections.flatMap(({ blocks }) => blocks.map(({ id }) => id));
  assertUnique(dynamicBlockIds, 'dynamic block');
  for (const section of payload.dynamicSections) {
    for (const block of section.blocks) {
      assertKnownQuestions(block.questionIds, knownQuestions, `dynamic block ${block.id}`, true);
      assertKnownEvidence(block.evidenceIds, evidence, `dynamic block ${block.id}`);
    }
  }

  assertUnique(payload.strategyMap.cells.map(({ id }) => id), 'strategy map cell');
  for (const cell of payload.strategyMap.cells) {
    if (!payload.strategyMap.rows.includes(cell.row) || !payload.strategyMap.columns.includes(cell.column)) {
      fail(`strategy map cell ${cell.id} is outside the declared rows or columns`);
    }
    assertKnownEvidence(cell.evidenceIds, evidence, `strategy map cell ${cell.id}`);
  }
  assertUnique(payload.mindModel.nodes.map(({ id }) => id), 'mind model node');
  const mindNodeIds = new Set(payload.mindModel.nodes.map(({ id }) => id));
  for (const node of payload.mindModel.nodes) assertKnownEvidence(node.evidenceIds, evidence, `mind model node ${node.id}`);
  for (const edge of payload.mindModel.edges) {
    if (!mindNodeIds.has(edge.from) || !mindNodeIds.has(edge.to)) fail('mind model edge references an unknown node');
  }

  const evidenceBoundCollections = [
    ['design principle', payload.designPrinciples],
    ['opportunity', payload.opportunities],
    ['prioritized action', payload.prioritizedActions],
    ['channel strategy', payload.channelStrategies],
  ] as const;
  for (const [label, items] of evidenceBoundCollections) {
    assertUnique(items.map(({ id }) => id), label);
    for (const item of items) assertKnownEvidence(item.evidenceIds, evidence, `${label} ${item.id}`);
  }

  const requested = new Set<RequestedArtifact>(requirement.requested_artifacts ?? []);
  const bindings = new Map(payload.requestedArtifactBindings.map((binding) => [binding.artifactType, binding]));
  if (bindings.size !== payload.requestedArtifactBindings.length) fail('requested artifact bindings must be unique');
  for (const artifact of requested) {
    const binding = bindings.get(artifact);
    if (!binding || binding.status !== 'complete' || binding.blockIds.length === 0) {
      fail(`requested artifact ${artifact} is not materialized`);
    }
    const projection = artifactProjection(artifact, payload);
    if (binding.sourceField !== projection.sourceField) fail(`requested artifact ${artifact} has the wrong source field`);
    if (!sameIds([...new Set(binding.blockIds)], [...new Set(projection.blockIds)])) {
      fail(`requested artifact ${artifact} has incomplete content binding`);
    }
    assertKnownQuestions(binding.questionIds, knownQuestions, `requested artifact ${artifact}`, true);
    assertKnownEvidence(binding.evidenceIds, evidence, `requested artifact ${artifact}`);
    if (!new Set(projection.evidenceIds).size || !sameIds([...new Set(binding.evidenceIds)], [...new Set(projection.evidenceIds)])) {
      fail(`requested artifact ${artifact} has incomplete Evidence binding`);
    }
  }

  const expectedRiskDisclosures: ResearchStrategyRiskDisclosure[] = [
    ...(input.requiredRiskDisclosures ?? []),
    ...payload.directAnswers.flatMap((answer): ResearchStrategyRiskDisclosure[] => (
      answer.answerStatus === 'supported'
        ? []
        : [{
            id: `answer-uncertainty:${answer.questionId}`,
            sourceType: 'answer_uncertainty',
            sourceId: answer.questionId,
            statement: answer.validationNeeded,
            disposition: 'open_question',
          }]
    )),
  ];
  const disclosuresByIdentity = new Map(payload.riskDisclosures.map((item) => [disclosureIdentity(item), item]));
  if (disclosuresByIdentity.size !== payload.riskDisclosures.length) fail('risk disclosure identities must be unique');
  const expectedByIdentity = new Map(expectedRiskDisclosures.map((item) => [disclosureIdentity(item), item]));
  if (expectedByIdentity.size !== expectedRiskDisclosures.length) fail('required risk disclosure identities must be unique');
  if (disclosuresByIdentity.size !== expectedByIdentity.size) {
    fail(`risk disclosures do not exactly match required sources: ${JSON.stringify(expectedRiskDisclosures)}`);
  }
  for (const [identity, expected] of expectedByIdentity) {
    const disclosure = disclosuresByIdentity.get(identity);
    if (!disclosure) fail(`risk disclosure ${identity} is missing; expected ${JSON.stringify(expected)}`);
    if (
      disclosure.id !== expected.id
      || normalizedRisk(disclosure.statement) !== normalizedRisk(expected.statement)
      || disclosure.disposition !== expected.disposition
    ) fail(`risk disclosure ${identity} does not preserve its source identity and content`);
    const destination = disclosure.disposition === 'limitation' ? payload.limitations : payload.openQuestions;
    if (!destination.some((statement) => normalizedRisk(statement) === normalizedRisk(disclosure.statement))) {
      fail(`risk disclosure ${identity} is absent from ${disclosure.disposition}`);
    }
  }
  for (const risk of input.risksAndOpenIssues) {
    if (!payload.riskDisclosures.some(({ statement }) => normalizedRisk(statement) === normalizedRisk(risk))) {
      fail(`envelope risk is not disclosed: ${risk}`);
    }
  }
}
