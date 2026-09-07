import type {
  ContributionLedgerV1,
  ContributionSummaryV1,
  CrossSkillReviewIssue,
  CrossSkillReviewV1,
  FindingGraph,
  IndustryMarketAnalysisPayloadV1,
  PlanContributionRequirement,
  ResearchContributionBundleV1,
  ResearchContributionUnit,
  ResearchStrategyReportPayloadV2,
  ResearchStrategySupportBindingV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { researchContributionUnitSemanticHash } from './contribution-ledger.ts';

export class MultiSkillContentFidelityError extends Error {
  constructor(
    public readonly code:
      | 'unknown_source_unit'
      | 'required_owner_omitted'
      | 'provisional_promoted'
      | 'duplicate_source_mapping'
      | 'source_scope_mismatch'
      | 'unauthorized_source_rewrite',
    public readonly issueIds: string[],
  ) {
    super(`multi-skill fidelity ${code}: ${[...new Set(issueIds)].join(', ')}`);
    this.name = 'MultiSkillContentFidelityError';
    this.issueIds = [...new Set(issueIds)];
  }
}

export function contributionUnitId(artifactId: string, unitKey: string): string {
  return `${artifactId}:${unitKey}`;
}

interface SourceUnitRecord {
  id: string;
  artifactId: string;
  invocationId: string;
  contributionTypes: ResearchContributionBundleV1['entries'][number]['contribution']['contributionTypes'];
  unit: ResearchContributionUnit;
}

interface CanonicalMappedNode {
  id: string;
  statement: string;
  supportStatus?: 'supported' | 'provisional';
  questionIds: string[];
  sourceUnitIds: string[];
}

function sourceUnits(bundle: ResearchContributionBundleV1): SourceUnitRecord[] {
  return bundle.entries.flatMap((entry) => entry.contribution.units.map((unit) => ({
    id: contributionUnitId(entry.artifactId, unit.key),
    artifactId: entry.artifactId,
    invocationId: entry.invocationId,
    contributionTypes: entry.contribution.contributionTypes,
    unit,
  })));
}

function contributionRequirementForSource(
  source: SourceUnitRecord,
  requirements: readonly PlanContributionRequirement[],
): PlanContributionRequirement | undefined {
  return requirements.find((candidate) => (
    candidate.owner_invocation_id === source.invocationId
    && source.contributionTypes.includes(candidate.demand_type)
    && source.unit.support.questionIds.some((questionId) => candidate.question_ids.includes(questionId))
  ));
}

function requiredProvisionalOmissionDisclosure(requirementId: string): string {
  return `Required provisional Contribution ${requirementId} was not selected for the Canonical deliverable; review the omitted units in the Contribution Summary and validate them before use.`;
}

function appendRequiredProvisionalOmissionDisclosure(
  target: string[] | undefined,
  requirementId: string,
): void {
  if (!target) return;
  const disclosure = requiredProvisionalOmissionDisclosure(requirementId);
  if (!target.includes(disclosure)) target.push(disclosure);
}

function conflictGroups(sources: readonly SourceUnitRecord[]): Map<string, string[]> {
  const groups = new Map<string, SourceUnitRecord[]>();
  const normalize = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
  for (const source of sources) {
    for (const questionId of source.unit.support.questionIds) {
      const key = `${questionId}\u0000${source.unit.kind}`;
      const group = groups.get(key) ?? [];
      group.push(source);
      groups.set(key, group);
    }
  }
  const result = new Map<string, string[]>();
  for (const group of groups.values()) {
    const statements = new Set(group.map(({ unit }) => normalize(unit.statement)));
    const invocations = new Set(group.map(({ invocationId }) => invocationId));
    if (group.length < 2 || statements.size < 2 || invocations.size < 2) continue;
    const ids = group.map(({ id }) => id);
    for (const source of group) result.set(source.id, ids);
  }
  return result;
}

function collectCanonicalNodes(payload: ResearchStrategyReportPayloadV2): CanonicalMappedNode[] {
  const nodes: CanonicalMappedNode[] = payload.directAnswers.map((answer) => ({
    id: `direct-answer:${answer.questionId}`,
    statement: answer.answer,
    supportStatus: answer.answerStatus === 'unanswered' ? 'provisional' : answer.answerStatus,
    questionIds: [answer.questionId],
    sourceUnitIds: answer.sourceContributionUnitIds ?? [],
  }));
  nodes.push(...payload.evidenceFindings.map((finding) => ({
    id: finding.id,
    statement: finding.statement,
    supportStatus: finding.support.status,
    questionIds: [...finding.support.questionIds],
    sourceUnitIds: finding.support.sourceContributionUnitIds ?? [],
  })));
  const visitSupport = (
    id: string,
    statement: string,
    support: ResearchStrategySupportBindingV2,
  ): void => {
    nodes.push({
      id,
      statement,
      supportStatus: support.status,
      questionIds: [...support.questionIds],
      sourceUnitIds: support.sourceContributionUnitIds ?? [],
    });
  };
  for (const block of payload.contentBlocks) {
    if (block.kind === 'narrative') visitSupport(block.id, block.content, block.support);
    else if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      for (const cell of block.cells) visitSupport(cell.id, cell.statement, cell.support);
    } else if (block.kind === 'mind_model') {
      for (const node of block.nodes) visitSupport(node.id, node.description, node.support);
    } else if ('items' in block) {
      for (const item of block.items) {
        const statement = 'statement' in item
          ? item.statement
          : 'action' in item ? item.action : item.strategies.join(' ');
        visitSupport(item.id, statement, item.support);
      }
    }
  }
  return nodes;
}

function collectIndustryMappedNodes(payload: IndustryMarketAnalysisPayloadV1): CanonicalMappedNode[] {
  const nodes: CanonicalMappedNode[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const support = record.support;
    if (support && typeof support === 'object' && !Array.isArray(support)) {
      const binding = support as Record<string, unknown>;
      const sourceUnitIds = Array.isArray(binding.sourceContributionUnitIds)
        ? binding.sourceContributionUnitIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (sourceUnitIds.length > 0) {
        const statement = [record.statement, record.designAction, record.definition, record.rationale, record.goal]
          .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
        const questionIds = Array.isArray(binding.questionIds)
          ? binding.questionIds.filter((id): id is string => typeof id === 'string')
          : [];
        const supportStatus = binding.status === 'supported' || binding.status === 'provisional'
          ? binding.status
          : undefined;
        if (statement) {
          nodes.push({
            id: typeof record.id === 'string' && record.id.trim() ? record.id : path,
            statement,
            ...(supportStatus ? { supportStatus } : {}),
            questionIds,
            sourceUnitIds,
          });
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== 'support') visit(child, `${path}/${key}`);
    }
  };
  visit(payload, '/payload');
  return nodes;
}

export function buildGenericReviewedContributionLedger(input: {
  bundle: ResearchContributionBundleV1;
  deliverable: {
    coverage: { questionBindings: Array<{ questionId: string; summaryIds: string[] }> };
    findingGraph: FindingGraph;
    risksAndOpenIssues?: string[];
    payload?: unknown;
  };
  contributionRequirements: readonly PlanContributionRequirement[];
  synthesisArtifactId: string;
  nonAttributableSourceUnitIds?: ReadonlySet<string>;
}): { review: CrossSkillReviewV1; ledger: ContributionLedgerV1 } {
  const issues: CrossSkillReviewIssue[] = [];
  const entries: ContributionLedgerV1['entries'] = [];
  const sources = sourceUnits(input.bundle);
  const nonAttributableSourceUnitIds = new Set(input.nonAttributableSourceUnitIds ?? []);
  const conflicts = conflictGroups(sources);
  const summaries = new Map(input.deliverable.findingGraph.subQuestionSummaries.map((node) => [node.id, node]));
  const analyses = new Map(input.deliverable.findingGraph.analyses.map((node) => [node.id, node]));
  const findings = new Map(input.deliverable.findingGraph.findings.map((node) => [node.id, node]));
  const explicitNodes = input.deliverable.payload
    && typeof input.deliverable.payload === 'object'
    && !Array.isArray(input.deliverable.payload)
    && (input.deliverable.payload as { schemaVersion?: unknown }).schemaVersion === 'industry-market-analysis-v1'
    ? collectIndustryMappedNodes(input.deliverable.payload as IndustryMarketAnalysisPayloadV1)
    : [];
  const explicitBySource = new Map<string, CanonicalMappedNode[]>();
  for (const node of explicitNodes) {
    for (const sourceUnitId of node.sourceUnitIds) {
      const targets = explicitBySource.get(sourceUnitId) ?? [];
      targets.push(node);
      explicitBySource.set(sourceUnitId, targets);
    }
  }
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  for (const source of sources) {
    const reachableIds = new Set<string>();
    for (const questionId of source.unit.support.questionIds) {
      for (const binding of input.deliverable.coverage.questionBindings) {
        if (binding.questionId !== questionId) continue;
        for (const summaryId of binding.summaryIds) {
          reachableIds.add(summaryId);
          const summary = summaries.get(summaryId);
          if (!summary) continue;
          for (const findingId of summary.findingIds) reachableIds.add(findingId);
          for (const analysisId of summary.analysisIds) {
            reachableIds.add(analysisId);
            for (const findingId of analyses.get(analysisId)?.findingIds ?? []) reachableIds.add(findingId);
          }
        }
      }
    }
    const sourceText = normalize(source.unit.statement);
    const explicitTargets = explicitBySource.get(source.id) ?? [];
    const scopeMismatchTargets: CanonicalMappedNode[] = [];
    const rewrittenTargets: CanonicalMappedNode[] = [];
    const sourceReviewIssueIds: string[] = [];
    for (const target of explicitTargets) {
      if (
        source.unit.support.status === 'provisional'
        && target.supportStatus === 'supported'
      ) throw new MultiSkillContentFidelityError('provisional_promoted', [source.id, target.id]);
      if (!normalize(target.statement).includes(sourceText)) {
        rewrittenTargets.push(target);
      }
      if (!target.questionIds.some((questionId) => source.unit.support.questionIds.includes(questionId))) {
        scopeMismatchTargets.push(target);
      }
    }
    const canonicalNodeIds = [...new Set([
      ...explicitTargets.map(({ id }) => id),
      ...[...reachableIds].filter((nodeId) => {
        const node = summaries.get(nodeId) ?? analyses.get(nodeId) ?? findings.get(nodeId);
        if (!node) return false;
        const text = normalize('summary' in node ? node.summary : node.statement);
        return sourceText.length > 0 && text.includes(sourceText);
      }),
    ])];
    const requirement = contributionRequirementForSource(source, input.contributionRequirements);
    const omitted = canonicalNodeIds.length === 0;
    const contextOnlyOmission = omitted && nonAttributableSourceUnitIds.has(source.id);
    const requiredProvisionalOmission = omitted
      && !contextOnlyOmission
      && requirement?.required === true
      && source.unit.support.status === 'provisional';
    if (omitted && requirement?.required && !requiredProvisionalOmission && !contextOnlyOmission) {
      throw new MultiSkillContentFidelityError('required_owner_omitted', [source.id, requirement.id]);
    }
    if (requiredProvisionalOmission) {
      appendRequiredProvisionalOmissionDisclosure(input.deliverable.risksAndOpenIssues, requirement.id);
    }
    const conflictingSourceIds = conflicts.get(source.id);
    if (scopeMismatchTargets.length > 0) {
      const scopeIssueId = `cross-review:scope-mismatch:${source.id}`;
      issues.push({
        id: scopeIssueId,
        type: 'scope_mismatch',
        sourceUnitIds: [source.id],
        targetNodeIds: scopeMismatchTargets.map(({ id }) => id),
        message: [
          `Contribution unit "${source.unit.key}" is referenced outside its Question scope by`,
          `${scopeMismatchTargets.map(({ id }) => id).join(', ')}; review this cross-question reuse before external publication.`,
        ].join(' '),
        disposition: 'merged',
      });
      sourceReviewIssueIds.push(scopeIssueId);
    }
    if (rewrittenTargets.length > 0) {
      const rewriteIssueId = `cross-review:unauthorized-source-rewrite:${source.id}`;
      issues.push({
        id: rewriteIssueId,
        type: 'unauthorized_source_rewrite',
        sourceUnitIds: [source.id],
        targetNodeIds: rewrittenTargets.map(({ id }) => id),
        message: [
          `Contribution unit "${source.unit.key}" was transformed by`,
          `${rewrittenTargets.map(({ id }) => id).join(', ')}; verify the synthesis against the original Unit before external publication.`,
        ].join(' '),
        disposition: 'merged',
      });
      sourceReviewIssueIds.push(rewriteIssueId);
    }
    const issueId = `cross-review:${conflictingSourceIds ? 'conflict' : 'omitted'}:${source.id}`;
    if (conflictingSourceIds) {
      const message = `Conflicting Contribution units require resolution: ${conflictingSourceIds.join(', ')}.`;
      issues.push({
        id: issueId,
        type: 'conflict',
        sourceUnitIds: conflictingSourceIds,
        targetNodeIds: canonicalNodeIds,
        message,
        disposition: 'conflicted',
      });
      sourceReviewIssueIds.push(issueId);
      if (input.deliverable.risksAndOpenIssues && !input.deliverable.risksAndOpenIssues.includes(message)) {
        input.deliverable.risksAndOpenIssues.push(message);
      }
    } else if (omitted) {
      issues.push({
        id: issueId,
        type: 'coverage',
        sourceUnitIds: [source.id],
        targetNodeIds: [],
        message: contextOnlyOmission
          ? 'Structured source payload was retained as non-attributable context rather than a Canonical claim.'
          : requiredProvisionalOmission
            ? 'Required provisional Contribution unit was not included verbatim in the Canonical deliverable.'
            : 'Optional Contribution unit was not included verbatim in the Canonical deliverable.',
        disposition: 'omitted',
      });
      sourceReviewIssueIds.push(issueId);
    }
    entries.push({
      contributionArtifactId: source.artifactId,
      invocationId: source.invocationId,
      sourceUnitKey: source.unit.key,
      sourceSemanticHash: researchContributionUnitSemanticHash(source.unit),
      disposition: conflictingSourceIds ? 'conflicted' : omitted ? 'omitted' : 'included',
      canonicalNodeIds,
      ...(conflictingSourceIds
        ? { reason: 'Conflicting Contributor claims require explicit follow-up.' }
        : omitted ? {
            reason: contextOnlyOmission
              ? 'Structured source payload is context-only and is not attributable as a Canonical claim.'
              : requiredProvisionalOmission
                ? 'Required provisional Contribution unit was not selected and remains an explicit validation gap.'
                : 'Optional Contribution unit was not selected for the final deliverable.',
          } : {}),
      reviewIssueIds: sourceReviewIssueIds,
    });
  }
  return {
    review: {
      version: 'cross-skill-review-v1',
      taskId: input.bundle.taskId,
      planVersionId: input.bundle.planVersionId,
      attemptId: input.bundle.attemptId,
      synthesisArtifactId: input.synthesisArtifactId,
      verdict: issues.length > 0 ? 'pass_with_conditions' : 'pass',
      issues,
    },
    ledger: {
      version: 'contribution-ledger-v1',
      taskId: input.bundle.taskId,
      planVersionId: input.bundle.planVersionId,
      attemptId: input.bundle.attemptId,
      entries,
    },
  };
}

export function buildContributionSummary(
  bundle: ResearchContributionBundleV1,
  ledger: ContributionLedgerV1,
): ContributionSummaryV1 {
  const dispositionBySource = new Map(ledger.entries.map((item) => (
    [`${item.contributionArtifactId}:${item.sourceUnitKey}`, item] as const
  )));
  return {
    version: 'contribution-summary-v1',
    taskId: bundle.taskId,
    planVersionId: bundle.planVersionId,
    attemptId: bundle.attemptId,
    contributors: bundle.entries.map((entry) => ({
      invocationId: entry.invocationId,
      skillId: entry.skillId,
      contributionTypes: [...entry.contribution.contributionTypes],
      unitCount: entry.contribution.units.length,
      limitations: [...entry.contribution.limitations],
      units: entry.contribution.units.map((unit) => {
        const disposition = dispositionBySource.get(`${entry.artifactId}:${unit.key}`);
        if (!disposition) {
          throw new MultiSkillContentFidelityError('required_owner_omitted', [
            contributionUnitId(entry.artifactId, unit.key),
          ]);
        }
        return {
          sourceArtifactId: entry.artifactId,
          sourceUnitKey: unit.key,
          kind: unit.kind,
          title: unit.title,
          statement: unit.statement,
          questionIds: [...unit.support.questionIds],
          evidenceIds: [...unit.support.evidenceIds],
          status: unit.support.status,
          confidence: unit.support.confidence,
          disposition: disposition.disposition,
          canonicalNodeIds: [...disposition.canonicalNodeIds],
        };
      }),
      dispositions: ledger.entries
        .filter(({ contributionArtifactId }) => contributionArtifactId === entry.artifactId)
        .map(({ sourceUnitKey, disposition, canonicalNodeIds }) => ({
          sourceUnitKey,
          disposition,
          canonicalNodeIds: [...canonicalNodeIds],
        })),
    })),
  };
}

export function buildReviewedContributionLedger(input: {
  bundle: ResearchContributionBundleV1;
  canonical: ResearchStrategyReportPayloadV2;
  contributionRequirements: readonly PlanContributionRequirement[];
  synthesisArtifactId: string;
  nonAttributableSourceUnitIds?: ReadonlySet<string>;
}): { review: CrossSkillReviewV1; ledger: ContributionLedgerV1 } {
  const sources = sourceUnits(input.bundle);
  const conflicts = conflictGroups(sources);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const nodes = collectCanonicalNodes(input.canonical);
  const targetsBySource = new Map<string, CanonicalMappedNode[]>();
  for (const node of nodes) {
    for (const sourceId of node.sourceUnitIds) {
      if (!sourceById.has(sourceId)) {
        throw new MultiSkillContentFidelityError('unknown_source_unit', [sourceId, node.id]);
      }
    }
  }
  const nonAttributableSourceUnitIds = input.nonAttributableSourceUnitIds ?? new Set<string>();
  for (const node of nodes) {
    const attributableSourceUnitIds = node.sourceUnitIds.filter((sourceId) => (
      !nonAttributableSourceUnitIds.has(sourceId)
    ));
    node.sourceUnitIds.splice(0, node.sourceUnitIds.length, ...attributableSourceUnitIds);
    for (const sourceId of node.sourceUnitIds) {
      const targets = targetsBySource.get(sourceId) ?? [];
      targets.push(node);
      targetsBySource.set(sourceId, targets);
    }
  }
  const issues: CrossSkillReviewIssue[] = [];
  const entries: ContributionLedgerV1['entries'] = [];
  for (const source of sources) {
    const targets = targetsBySource.get(source.id) ?? [];
    if (targets.length === 0) {
      const requirement = contributionRequirementForSource(source, input.contributionRequirements);
      const issueId = `cross-review:omitted:${source.id}`;
      const requiredProvisionalOmission = requirement?.required === true
        && source.unit.support.status === 'provisional';
      if (requirement?.required && !requiredProvisionalOmission) {
        throw new MultiSkillContentFidelityError('required_owner_omitted', [source.id, requirement.id]);
      }
      if (requiredProvisionalOmission) {
        appendRequiredProvisionalOmissionDisclosure(input.canonical.openQuestions, requirement.id);
      }
      issues.push({
        id: issueId,
        type: 'coverage',
        sourceUnitIds: [source.id],
        targetNodeIds: [],
        message: requiredProvisionalOmission
          ? 'Required provisional Contribution unit was not included in the Canonical deliverable.'
          : 'Optional Contribution unit was not included in the Canonical deliverable.',
        disposition: 'omitted',
      });
      entries.push({
        contributionArtifactId: source.artifactId,
        invocationId: source.invocationId,
        sourceUnitKey: source.unit.key,
        sourceSemanticHash: researchContributionUnitSemanticHash(source.unit),
        disposition: 'omitted',
        canonicalNodeIds: [],
        reason: requiredProvisionalOmission
          ? 'Required provisional Contribution unit was not selected and remains an explicit validation gap.'
          : 'Optional Contribution unit was not selected for the final deliverable.',
        reviewIssueIds: [issueId],
      });
      continue;
    }
    if (
      targets.some((target) => !target.questionIds.some((questionId) => (
        source.unit.support.questionIds.includes(questionId)
      )))
    ) {
      issues.push({
        id: `cross-review:scope-mismatch:${source.id}`,
        type: 'scope_mismatch',
        sourceUnitIds: [source.id],
        targetNodeIds: targets.map(({ id }) => id),
        message: [
          `Contribution unit "${source.unit.key}" asserts scope ${JSON.stringify(source.unit.support.questionIds)}`,
          `but is referenced by Canonical node(s) outside that scope: ${targets.map(({ id }) => id).join(', ')}.`,
          'Treat the overlap as cross-question reuse; review before external publication.',
        ].join(' '),
        disposition: 'merged',
      });
    }
    if (
      source.unit.support.status === 'provisional'
      && targets.some(({ supportStatus }) => supportStatus === 'supported')
    ) {
      issues.push({
        id: `cross-review:provisional-promoted:${source.id}`,
        type: 'provisional_promoted',
        sourceUnitIds: [source.id],
        targetNodeIds: targets.map(({ id }) => id),
        message: [
          `Provisional Contribution unit "${source.unit.key}" is referenced by Canonical node(s) marked supported: ${targets.map(({ id }) => id).join(', ')}.`,
          'Downgrade is required before external use; treat as needing corroboration.',
        ].join(' '),
        disposition: 'merged',
      });
    }
    const exact = targets.every(({ statement }) => statement === source.unit.statement);
    if (!exact) {
      issues.push({
        id: `cross-review:unauthorized-source-rewrite:${source.id}`,
        type: 'unauthorized_source_rewrite',
        sourceUnitIds: [source.id],
        targetNodeIds: targets.map(({ id }) => id),
        message: [
          `Contribution unit "${source.unit.key}" has been rewritten in Canonical node(s): ${targets.map(({ id }) => id).join(', ')}.`,
          'The statement no longer matches the original text; verify accuracy before external use.',
        ].join(' '),
        disposition: 'merged',
      });
    }
    const conflictingSourceIds = conflicts.get(source.id);
    const disposition = conflictingSourceIds ? 'conflicted' as const : 'included' as const;
    const issueId = `cross-review:${conflictingSourceIds ? 'conflict' : 'merge'}:${source.id}`;
    if (conflictingSourceIds) {
      const message = `Conflicting Contribution units require resolution: ${conflictingSourceIds.join(', ')}.`;
      issues.push({
        id: issueId,
        type: 'conflict',
        sourceUnitIds: conflictingSourceIds,
        targetNodeIds: targets.map(({ id }) => id),
        message,
        disposition,
      });
      if (!input.canonical.openQuestions.includes(message)) input.canonical.openQuestions.push(message);
    }
    entries.push({
      contributionArtifactId: source.artifactId,
      invocationId: source.invocationId,
      sourceUnitKey: source.unit.key,
      sourceSemanticHash: researchContributionUnitSemanticHash(source.unit),
      disposition,
      canonicalNodeIds: targets.map(({ id }) => id),
      ...(conflictingSourceIds ? {
        reason: 'Conflicting Contributor claims require explicit follow-up.',
      } : {}),
      reviewIssueIds: conflictingSourceIds ? [issueId] : [],
    });
  }
  const review: CrossSkillReviewV1 = {
    version: 'cross-skill-review-v1',
    taskId: input.bundle.taskId,
    planVersionId: input.bundle.planVersionId,
    attemptId: input.bundle.attemptId,
    synthesisArtifactId: input.synthesisArtifactId,
    verdict: issues.length > 0 ? 'pass_with_conditions' : 'pass',
    issues,
  };
  return {
    review,
    ledger: {
      version: 'contribution-ledger-v1',
      taskId: input.bundle.taskId,
      planVersionId: input.bundle.planVersionId,
      attemptId: input.bundle.attemptId,
      entries,
    },
  };
}
