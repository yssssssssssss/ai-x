import type { ContributionType, RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type {
  ContributionUnitKind,
  EvidenceManifest,
  ResearchContributionArtifactV1,
  ResearchContributionUnit,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { stableJsonHash, stableJsonStringify } from '../runtime/stable-json.ts';
import { validateResearchContribution } from './research-contribution.ts';

export type ContributionAdapterErrorCode =
  | 'adapter_not_registered'
  | 'source_envelope_invalid'
  | 'ambiguous_question_scope'
  | 'no_contribution_units';

export class ContributionAdapterError extends Error {
  constructor(
    public readonly code: ContributionAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContributionAdapterError';
  }
}

interface SkillEnvelopeFinding {
  id: string;
  statement: string;
  confidence: number;
}

interface SkillOutputEnvelope {
  version: 'skill-output-v2';
  status: 'succeeded' | 'degraded';
  summary: string;
  findings: SkillEnvelopeFinding[];
  assumptions: string[];
  limitations: string[];
  recommendations: string[];
  payload: Record<string, unknown>;
}

export interface ContributionAdapterInput {
  adapterId: string;
  source: unknown;
  sourceArtifact: {
    id: string;
    contentSha256: string;
    schemaVersion: string;
  };
  taskId: string;
  planVersionId: string;
  attemptId: string;
  invocationId: string;
  skillId: string;
  contributionTypes: ContributionType[];
  questionIds: string[];
  requestedArtifactTypes: RequestedArtifact[];
  evidenceManifest: EvidenceManifest;
}

type Adapter = (input: ContributionAdapterInput) => ResearchContributionArtifactV1;

export const SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID = 'skill-envelope-provisional-v1';
export const VIRTUAL_USER_TOOL_ADAPTER_ID = 'virtual-user-tool-v1';
export const CONTRIBUTION_ADAPTER_IDS = [
  SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID,
  VIRTUAL_USER_TOOL_ADAPTER_ID,
] as const;
const ADAPTER_VERSION = '1.0.0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function contextOnlyContributionUnitKeys(
  artifact: ResearchContributionArtifactV1,
): string[] {
  if (artifact.source.adapterId !== SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID) return [];
  const unitsByKey = new Map(artifact.contribution.units.map((unit) => [unit.key, unit]));
  const keys = new Set<string>();
  for (const mapping of artifact.source.unitMappings) {
    if (!mapping.sourceJsonPointer.startsWith('/payload/')) continue;
    const unit = unitsByKey.get(mapping.targetUnitKey);
    if (!unit) continue;
    try {
      const value: unknown = JSON.parse(unit.statement);
      if (
        (Array.isArray(value) || isRecord(value))
        && stableJsonHash(value) === mapping.sourceSemanticHash
      ) {
        keys.add(unit.key);
      }
    } catch {
      // Scalar payload text remains an attributable Contribution unit.
    }
  }
  return [...keys].sort();
}

function parseEnvelope(value: unknown): SkillOutputEnvelope {
  if (!isRecord(value)) {
    throw new ContributionAdapterError('source_envelope_invalid', 'Skill output envelope must be an object');
  }
  if (
    value.version !== 'skill-output-v2'
    || (value.status !== 'succeeded' && value.status !== 'degraded')
    || typeof value.summary !== 'string'
    || !Array.isArray(value.findings)
    || !Array.isArray(value.assumptions)
    || !Array.isArray(value.limitations)
    || !Array.isArray(value.recommendations)
    || !isRecord(value.payload)
  ) {
    throw new ContributionAdapterError('source_envelope_invalid', 'Skill output envelope is malformed');
  }
  const findings = value.findings.map((finding, index): SkillEnvelopeFinding => {
    if (
      !isRecord(finding)
      || typeof finding.id !== 'string'
      || !finding.id.trim()
      || typeof finding.statement !== 'string'
      || !finding.statement.trim()
      || typeof finding.confidence !== 'number'
      || finding.confidence < 0
      || finding.confidence > 1
    ) throw new ContributionAdapterError('source_envelope_invalid', `Skill finding ${index + 1} is malformed`);
    return { id: finding.id, statement: finding.statement, confidence: finding.confidence };
  });
  const strings = (field: unknown, name: string): string[] => {
    if (!Array.isArray(field) || !field.every((item) => typeof item === 'string' && item.trim())) {
      throw new ContributionAdapterError('source_envelope_invalid', `Skill ${name} is malformed`);
    }
    return field;
  };
  return {
    version: 'skill-output-v2',
    status: value.status,
    summary: value.summary,
    findings,
    assumptions: strings(value.assumptions, 'assumptions'),
    limitations: strings(value.limitations, 'limitations'),
    recommendations: strings(value.recommendations, 'recommendations'),
    payload: value.payload,
  };
}

function unitKind(type: ContributionType): ContributionUnitKind {
  if (type === 'persona') return 'persona';
  if (type === 'jobs_to_be_done') return 'job';
  if (type === 'journey') return 'journey_stage';
  if (type === 'metrics' || type === 'funnel' || type === 'feature_adoption' || type === 'satisfaction') return 'metric';
  if (type === 'research_method') return 'method';
  if (type === 'prioritization') return 'priority';
  if (type === 'action_plan') return 'action';
  if (type === 'virtual_user_hypothesis') return 'hypothesis';
  if (type === 'qualitative_insight' || type === 'voc') return 'insight';
  return 'finding';
}

function provisionalSupport(input: ContributionAdapterInput, confidence: number) {
  return {
    questionIds: [...input.questionIds],
    evidenceIds: [] as string[],
    status: 'provisional' as const,
    confidence,
    validationNeeded: `使用与 ${input.questionIds.join('、')} 对应的真实用户或可核验数据验证该贡献。`,
  };
}

function contributionSupport(
  input: ContributionAdapterInput,
  primaryType: ContributionType,
  confidence: number,
) {
  if (input.skillId === 'generate-persona' && primaryType === 'persona') {
    const profileEvidence = input.evidenceManifest.entries.filter((entry) => (
      entry.kind === 'dataset'
      && entry.evidenceClass === 'dataset'
      && entry.id.endsWith(':profile')
    ));
    if (profileEvidence.length > 0) {
      return {
        questionIds: [...input.questionIds],
        evidenceIds: profileEvidence.map(({ id }) => id),
        status: 'supported' as const,
        confidence,
        validationNeeded: '',
      };
    }
  }
  return provisionalSupport(input, confidence);
}

function genericEnvelopeAdapter(input: ContributionAdapterInput): ResearchContributionArtifactV1 {
  if (input.questionIds.length === 0) {
    throw new ContributionAdapterError(
      'ambiguous_question_scope',
      `Adapter ${SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID} requires at least one scoped Question`,
    );
  }
  const envelope = parseEnvelope(input.source);
  const primaryType = input.contributionTypes[0];
  if (!primaryType) throw new ContributionAdapterError('source_envelope_invalid', 'Contribution type is missing');
  const mappings: ResearchContributionArtifactV1['source']['unitMappings'] = [];
  const units: ResearchContributionUnit[] = [];
  const addUnit = (unit: ResearchContributionUnit, sourceJsonPointer: string, sourceValue: unknown): void => {
    units.push(unit);
    mappings.push({
      sourceUnitKey: unit.key,
      targetUnitKey: unit.key,
      sourceJsonPointer,
      sourceSemanticHash: stableJsonHash(sourceValue),
    });
  };
  envelope.findings.forEach((finding, index) => addUnit({
    key: finding.id,
    kind: unitKind(primaryType),
    title: finding.id,
    statement: finding.statement,
    requestedArtifactTypes: [],
    support: contributionSupport(input, primaryType, finding.confidence),
  }, `/findings/${index}`, finding));
  envelope.assumptions.forEach((statement, index) => addUnit({
    key: `assumption-${String(index + 1).padStart(3, '0')}`,
    kind: 'hypothesis',
    title: `Assumption ${index + 1}`,
    statement,
    requestedArtifactTypes: [],
    support: provisionalSupport(input, 0.4),
  }, `/assumptions/${index}`, statement));
  envelope.recommendations.forEach((statement, index) => addUnit({
    key: `recommendation-${String(index + 1).padStart(3, '0')}`,
    kind: 'action',
    title: `Recommendation ${index + 1}`,
    statement,
    recommendedAction: statement,
    requestedArtifactTypes: [...input.requestedArtifactTypes],
    support: provisionalSupport(input, 0.5),
  }, `/recommendations/${index}`, statement));
  Object.entries(envelope.payload)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([field, value], index) => addUnit({
      key: `payload-${String(index + 1).padStart(3, '0')}`,
      kind: unitKind(primaryType),
      title: field.trim() || `Payload ${index + 1}`,
      statement: typeof value === 'string' && value.trim()
        ? value
        : stableJsonStringify(value),
      requestedArtifactTypes: [...input.requestedArtifactTypes],
      support: contributionSupport(input, primaryType, 0.5),
    }, `/payload/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`, value));
  if (units.length === 0) {
    throw new ContributionAdapterError('no_contribution_units', 'Skill output has no deterministic contribution units');
  }
  const contribution = {
    version: 'research-contribution-v1' as const,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    invocationId: input.invocationId,
    skillId: input.skillId,
    contributionTypes: [...input.contributionTypes],
    units,
    limitations: [...envelope.limitations],
    openQuestions: [],
  };
  validateResearchContribution({
    contribution,
    allowedQuestionIds: input.questionIds,
    evidenceManifest: input.evidenceManifest,
    expected: {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      invocationId: input.invocationId,
      skillId: input.skillId,
      contributionTypes: input.contributionTypes,
      requestedArtifactTypes: input.requestedArtifactTypes,
    },
  });
  return {
    version: 'research-contribution-artifact-v1',
    contribution,
    source: {
      artifactId: input.sourceArtifact.id,
      artifactContentSha256: input.sourceArtifact.contentSha256,
      schemaVersion: input.sourceArtifact.schemaVersion,
      adapterId: SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      adapterHash: stableJsonHash({ id: SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID, version: ADAPTER_VERSION }),
      unitMappings: mappings,
      diagnosticFields: ['/summary', '/status'],
    },
  };
}

function virtualUserToolAdapter(input: ContributionAdapterInput): ResearchContributionArtifactV1 {
  if (input.questionIds.length === 0) {
    throw new ContributionAdapterError(
      'ambiguous_question_scope',
      `Adapter ${VIRTUAL_USER_TOOL_ADAPTER_ID} requires at least one scoped Question`,
    );
  }
  let virtualSource: unknown = input.source;
  let sourcePointerPrefix = input.sourceArtifact.schemaVersion === 'tool-output-v1' ? '/output' : '';
  if (isRecord(input.source) && /^skill-output-v\d+$/u.test(String(input.source.version))) {
    virtualSource = parseEnvelope(input.source).payload;
    sourcePointerPrefix = '/payload';
  }
  if (!isRecord(virtualSource) || virtualSource.status !== 'available' || virtualSource.isSimulated !== true) {
    throw new ContributionAdapterError('source_envelope_invalid', 'Virtual User result is not available synthetic output');
  }
  if (!Array.isArray(virtualSource.reviews) || virtualSource.reviews.length === 0) {
    throw new ContributionAdapterError('no_contribution_units', 'Virtual User result has no reviews');
  }
  const mappings: ResearchContributionArtifactV1['source']['unitMappings'] = [];
  const units: ResearchContributionUnit[] = [];
  const addUnit = (unit: ResearchContributionUnit, sourceJsonPointer: string, sourceValue: unknown): void => {
    units.push(unit);
    mappings.push({
      sourceUnitKey: unit.key,
      targetUnitKey: unit.key,
      sourceJsonPointer,
      sourceSemanticHash: stableJsonHash(sourceValue),
    });
  };
  virtualSource.reviews.forEach((value, index) => {
    if (
      !isRecord(value)
      || value.isSimulated !== true
      || typeof value.profileId !== 'string'
      || typeof value.personaName !== 'string'
      || typeof value.firstImpression !== 'string'
      || typeof value.detailedExperience !== 'string'
      || typeof value.topChangeRequest !== 'string'
    ) throw new ContributionAdapterError('source_envelope_invalid', `Virtual User review ${index + 1} is malformed`);
    const pointerCandidates = [`/output/reviews/${index}`, `/reviews/${index}`];
    const evidence = input.evidenceManifest.entries.find((entry) => (
      entry.artifactId === input.sourceArtifact.id
      && entry.evidenceClass === 'simulation'
      && pointerCandidates.includes(entry.jsonPointer)
    ));
    if (!evidence) {
      throw new ContributionAdapterError(
        'source_envelope_invalid',
        `Virtual User review ${index + 1} has no simulation Evidence`,
      );
    }
    addUnit({
      key: `virtual-user:${value.profileId}`,
      kind: 'hypothesis',
      title: value.personaName,
      statement: `${value.firstImpression} ${value.detailedExperience}`.trim(),
      recommendedAction: value.topChangeRequest,
      requestedArtifactTypes: [],
      support: {
        questionIds: [...input.questionIds],
        evidenceIds: [evidence.id],
        status: 'provisional',
        confidence: 0.4,
        validationNeeded: '必须通过真实用户访谈、可用性测试或行为数据验证该虚拟用户假设。',
      },
    }, `${sourcePointerPrefix}/reviews/${index}`, value);
  });
  const recommendations = Array.isArray(virtualSource.recommendations)
    ? virtualSource.recommendations.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  recommendations.forEach((statement, index) => addUnit({
    key: `virtual-user:recommendation:${String(index + 1).padStart(3, '0')}`,
    kind: 'action',
    title: `Virtual User recommendation ${index + 1}`,
    statement,
    recommendedAction: statement,
    requestedArtifactTypes: [...input.requestedArtifactTypes],
    support: {
      questionIds: [...input.questionIds],
      evidenceIds: [],
      status: 'provisional',
      confidence: 0.3,
      validationNeeded: '在真实用户样本中验证建议对应的问题、收益与优先级。',
    },
  }, `${sourcePointerPrefix}/recommendations/${index}`, statement));
  const boundaryNotes = Array.isArray(virtualSource.boundaryNotes)
    ? virtualSource.boundaryNotes.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const warnings = Array.isArray(virtualSource.warnings)
    ? virtualSource.warnings.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const disclaimer = '虚拟用户假设，不代表真实用户研究。';
  const contribution = {
    version: 'research-contribution-v1' as const,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    invocationId: input.invocationId,
    skillId: input.skillId,
    contributionTypes: ['virtual_user_hypothesis'] as const,
    units,
    limitations: [...new Set([disclaimer, ...boundaryNotes, ...warnings])],
    openQuestions: ['这些模拟反馈是否能在真实目标用户中复现？'],
  };
  const mutableContribution = {
    ...contribution,
    contributionTypes: [...contribution.contributionTypes],
  };
  validateResearchContribution({
    contribution: mutableContribution,
    allowedQuestionIds: input.questionIds,
    evidenceManifest: input.evidenceManifest,
    expected: {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      invocationId: input.invocationId,
      skillId: input.skillId,
      contributionTypes: ['virtual_user_hypothesis'],
      requestedArtifactTypes: input.requestedArtifactTypes,
    },
  });
  return {
    version: 'research-contribution-artifact-v1',
    contribution: mutableContribution,
    source: {
      artifactId: input.sourceArtifact.id,
      artifactContentSha256: input.sourceArtifact.contentSha256,
      schemaVersion: input.sourceArtifact.schemaVersion,
      adapterId: VIRTUAL_USER_TOOL_ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      adapterHash: stableJsonHash({ id: VIRTUAL_USER_TOOL_ADAPTER_ID, version: ADAPTER_VERSION }),
      unitMappings: mappings,
      diagnosticFields: [
        `${sourcePointerPrefix}/status`,
        `${sourcePointerPrefix}/isSimulated`,
        `${sourcePointerPrefix}/summary`,
        `${sourcePointerPrefix}/digitalPersonas`,
        `${sourcePointerPrefix}/aggregate`,
      ],
    },
  };
}

export class ContributionAdapterRegistry {
  private readonly adapters = new Map<string, Adapter>([
    [SKILL_ENVELOPE_PROVISIONAL_ADAPTER_ID, genericEnvelopeAdapter],
    [VIRTUAL_USER_TOOL_ADAPTER_ID, virtualUserToolAdapter],
  ]);

  constructor(private readonly validator = new SchemaValidator()) {}

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  adapt(input: ContributionAdapterInput): ResearchContributionArtifactV1 {
    const adapter = this.adapters.get(input.adapterId);
    if (!adapter) {
      throw new ContributionAdapterError(
        'adapter_not_registered',
        `Contribution adapter ${input.adapterId} is not registered`,
      );
    }
    const result = adapter(input);
    this.validator.validateFileOrThrow(
      'schemas/research-contribution-artifact-v1.schema.json',
      result,
    );
    return result;
  }
}
