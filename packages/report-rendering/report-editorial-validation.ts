import type {
  ReportAuditAppendixMaterialV1,
  ReportEditorialBlueprintV1,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
  ReportPresentationV1,
} from '../api-contract/report-editorial.ts';

export class ReportEditorialIntegrityError extends Error {
  constructor(message: string) {
    super(`Report editorial integrity failed: ${message}`);
    this.name = 'ReportEditorialIntegrityError';
  }
}

function fail(message: string): never {
  throw new ReportEditorialIntegrityError(message);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim()) fail(`${label} must not contain an empty id`);
    if (seen.has(value)) fail(`${label} ${value} must be unique`);
    seen.add(value);
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

export function editorialPresentationUnitLeafIds(
  unit: ReportEditorialPresentationUnitV1,
): string[] {
  switch (unit.shape) {
    case 'text':
    case 'record':
    case 'asset':
    case 'chart':
      return [unit.leafId];
    case 'asset_pair':
      return [unit.original.leafId, unit.annotation.leafId];
    case 'matrix':
      return unit.cells.map(({ leafId }) => leafId);
    case 'graph':
      return [
        ...unit.nodes.map(({ leafId }) => leafId),
        ...unit.edges.map(({ leafId }) => leafId),
      ];
    case 'actions':
      return unit.actions.map(({ leafId }) => leafId);
    case 'records':
      return unit.records.map(({ leafId }) => leafId);
    case 'stages':
      return unit.stages.map(({ leafId }) => leafId);
  }
}

function graphIsRenderable(unit: Extract<ReportEditorialPresentationUnitV1, { shape: 'graph' }>): boolean {
  const nodeIds = new Set(unit.nodes.map(({ id }) => id));
  return unit.nodes.length <= 50
    && unit.edges.length <= 100
    && unit.edges.every(({ from, to }) => nodeIds.has(from) && nodeIds.has(to));
}

function priorityBoardIsRenderable(
  unit: Extract<ReportEditorialPresentationUnitV1, { shape: 'actions' }>,
): boolean {
  if (unit.actions.some(({ priority }) => priority === undefined)) return false;
  const counts = new Map<string, number>();
  for (const action of unit.actions) {
    counts.set(action.priority!, (counts.get(action.priority!) ?? 0) + 1);
  }
  return [...counts.values()].every((count) => count <= 50);
}

function cardGridIsRenderable(
  unit: Extract<ReportEditorialPresentationUnitV1, { shape: 'records' }>,
): boolean {
  return unit.records.length <= 50;
}

function stageFlowIsRenderable(
  unit: Extract<ReportEditorialPresentationUnitV1, { shape: 'stages' }>,
): boolean {
  return unit.stages.length <= 50;
}

export function isPresentationCompatible(
  unit: ReportEditorialPresentationUnitV1,
  presentation: ReportPresentationV1,
): boolean {
  switch (presentation) {
    case 'paragraph':
    case 'fact':
      return unit.shape === 'text';
    case 'answer':
      return unit.shape === 'text' || unit.shape === 'record';
    case 'list':
      return unit.shape === 'text'
        || unit.shape === 'record'
        || unit.shape === 'matrix'
        || unit.shape === 'graph'
        || unit.shape === 'actions'
        || unit.shape === 'records'
        || unit.shape === 'stages';
    case 'record-table':
      return unit.shape === 'record'
        || (unit.shape === 'matrix' && unit.cells.length <= 200)
        || (unit.shape === 'actions' && unit.actions.length <= 200)
        || (unit.shape === 'chart' && unit.table.columns.length <= 12 && unit.table.rows.length <= 200);
    case 'graph':
      return unit.shape === 'graph' && graphIsRenderable(unit);
    case 'priority-board':
      return unit.shape === 'actions' && priorityBoardIsRenderable(unit);
    case 'card-grid':
      return unit.shape === 'records' && cardGridIsRenderable(unit);
    case 'stage-flow':
      return unit.shape === 'stages' && stageFlowIsRenderable(unit);
    case 'image':
      return unit.shape === 'asset';
    case 'image-comparison':
      return unit.shape === 'asset_pair';
    case 'chart':
      return unit.shape === 'chart';
  }
}

function assertUnitShape(unit: ReportEditorialPresentationUnitV1): void {
  const actualLeaves = editorialPresentationUnitLeafIds(unit);
  assertUnique(unit.leafIds, `presentation unit ${unit.id} leafIds`);
  assertUnique(actualLeaves, `presentation unit ${unit.id} shape leaf`);
  if (actualLeaves.length === 0) fail(`presentation unit ${unit.id} must own at least one leaf`);
  if (!sameSet(unit.leafIds, actualLeaves)) {
    fail(`presentation unit ${unit.id} leafIds must equal its shape leaf IDs`);
  }

  const expectedShape = (() => {
    switch (unit.semanticKind) {
      case 'direct_answer':
      case 'design_principle':
      case 'opportunity':
      case 'channel_strategy':
      case 'requested_artifact_binding':
        return 'record';
      case 'narrative':
      case 'evidence_finding':
      case 'limitation':
      case 'open_question':
      case 'risk':
        return 'text';
      case 'comparison_matrix':
      case 'strategy_map':
        return 'matrix';
      case 'mind_model':
        return 'graph';
      case 'prioritized_action':
      case 'action_plan':
        return 'actions';
      case 'research_plan_overview':
      case 'research_plan_questions':
      case 'research_plan_methods':
      case 'research_plan_deliverables':
      case 'research_plan_quality':
        return 'records';
      case 'research_plan_execution':
        return 'stages';
      case 'visual_asset':
        return 'asset';
      case 'visual_comparison':
        return 'asset_pair';
      case 'verified_chart':
        return 'chart';
    }
  })();
  if (unit.shape !== expectedShape) {
    fail(`presentation unit ${unit.id} semantic kind ${unit.semanticKind} requires ${expectedShape} shape`);
  }

  if (unit.shape === 'record') {
    if (unit.fields.length === 0) fail(`record unit ${unit.id} must contain a field`);
    assertUnique(unit.fields.map(({ key }) => key), `record unit ${unit.id} field key`);
  }
  if (unit.shape === 'matrix') {
    assertUnique(unit.rows, `matrix unit ${unit.id} row`);
    assertUnique(unit.columns, `matrix unit ${unit.id} column`);
    const rows = new Set(unit.rows);
    const columns = new Set(unit.columns);
    for (const cell of unit.cells) {
      if (!rows.has(cell.row) || !columns.has(cell.column)) {
        fail(`matrix unit ${unit.id} contains a cell outside its declared rows or columns`);
      }
    }
  }
  if (unit.shape === 'graph') {
    assertUnique(unit.nodes.map(({ id }) => id), `graph unit ${unit.id} node id`);
    assertUnique(unit.edges.map(({ id }) => id), `graph unit ${unit.id} edge id`);
  }
  if (unit.shape === 'records') {
    assertUnique(unit.records.map(({ id }) => id), `records unit ${unit.id} record id`);
    for (const record of unit.records) {
      assertUnique(record.fields.map(({ key }) => key), `records unit ${unit.id} record ${record.id} field key`);
      if (!record.title.trim()) fail(`records unit ${unit.id} record ${record.id} must have a title`);
      if (record.fields.length === 0 && !record.body?.trim()) {
        fail(`records unit ${unit.id} record ${record.id} must contain body or fields`);
      }
    }
  }
  if (unit.shape === 'stages') {
    assertUnique(unit.stages.map(({ id }) => id), `stages unit ${unit.id} stage id`);
    for (const stage of unit.stages) {
      if (!stage.label.trim()) fail(`stages unit ${unit.id} stage ${stage.id} must have a label`);
      if (
        !stage.description?.trim()
        && stage.activities.length === 0
        && !stage.timeLabel?.trim()
        && stage.outputs.length === 0
      ) {
        fail(`stages unit ${unit.id} stage ${stage.id} must contain stage details`);
      }
    }
  }
  if (unit.shape === 'asset_pair') {
    if (unit.original.assetRef.assetId === unit.annotation.assetRef.assetId) {
      fail(`asset pair unit ${unit.id} must contain two distinct Assets`);
    }
  }
}

export function assertReportEditorialMaterialIntegrity(material: ReportEditorialMaterialV1): void {
  if (material.version !== 'report-editorial-material-v1') fail('material version is invalid');
  const units = material.presentationUnits;
  if (units.length === 0) fail('material must contain at least one presentation unit');
  assertUnique(units.map(({ id }) => id), 'presentation unit id');
  for (const unit of units) assertUnitShape(unit);

  const ownedLeafIds = units.flatMap(editorialPresentationUnitLeafIds);
  assertUnique(ownedLeafIds, 'leaf owner');
  const traceIds = Object.keys(material.leafTraceIndex);
  assertUnique(traceIds, 'leaf trace id');
  if (!sameSet(traceIds, ownedLeafIds)) {
    fail('leafTraceIndex keys must exactly equal presentation-unit leaf IDs');
  }
  for (const leafId of ownedLeafIds) {
    const trace = material.leafTraceIndex[leafId];
    if (!trace || trace.origins.length === 0) fail(`leaf ${leafId} must retain a source origin`);
    assertUnique(trace.support.questionIds, `leaf ${leafId} question id`);
    assertUnique(trace.support.evidenceIds, `leaf ${leafId} evidence id`);
    assertUnique(trace.support.findingIds, `leaf ${leafId} finding id`);
    assertUnique(trace.support.summaryIds, `leaf ${leafId} summary id`);
    const originKeys = trace.origins.map((origin) => [
      origin.artifactId,
      origin.contentSha256,
      origin.schemaVersion,
      origin.jsonPointer,
      ...origin.sourceNodeIds,
    ].join('\u0000'));
    assertUnique(originKeys, `leaf ${leafId} origin`);
  }

  const unitIds = units.map(({ id }) => id);
  if (!sameSet(material.constraints.requiredPresentationUnitIds, unitIds)) {
    fail('requiredPresentationUnitIds must exactly equal the material presentation units');
  }
  if (!sameSet(material.constraints.requiredLeafUnitIds, ownedLeafIds)) {
    fail('requiredLeafUnitIds must exactly equal the material leaves');
  }
  assertUnique(material.constraints.requiredQuestionIds, 'required question id');
  assertUnique(material.constraints.requiredPresentationUnitIds, 'required presentation unit id');
  assertUnique(material.constraints.requiredLeafUnitIds, 'required leaf unit id');
  assertUnique(material.constraints.allowedViews, 'allowed view');

  const profileIds = Object.keys(material.constraints.projectionProfilesByUnitId);
  if (!sameSet(profileIds, unitIds)) {
    fail('projectionProfilesByUnitId keys must exactly equal the material presentation units');
  }
  for (const unit of units) {
    const profiles = material.constraints.projectionProfilesByUnitId[unit.id];
    if (!profiles || profiles.length === 0) fail(`presentation unit ${unit.id} has no projection profile`);
    assertUnique(profiles, `presentation unit ${unit.id} projection profile`);
    for (const profile of profiles) {
      if (!isPresentationCompatible(unit, profile)) {
        fail(`presentation ${profile} is incompatible with unit ${unit.id}`);
      }
    }
  }

  const coveredQuestions = new Set(
    Object.values(material.leafTraceIndex).flatMap(({ support }) => support.questionIds),
  );
  const directlyAnsweredQuestions = new Set(material.presentationUnits
    .filter(({ semanticKind }) => semanticKind === 'direct_answer')
    .flatMap(({ leafIds }) => leafIds)
    .flatMap((leafId) => material.leafTraceIndex[leafId]?.support.questionIds ?? []));
  for (const questionId of material.constraints.requiredQuestionIds) {
    if (!coveredQuestions.has(questionId)) fail(`required question ${questionId} is not covered`);
    if (
      material.document.deliverableType === 'research_strategy_report'
      && !directlyAnsweredQuestions.has(questionId)
    ) {
      fail(`required question ${questionId} has no direct-answer presentation unit`);
    }
  }
}

const VIEW_BY_SEMANTIC_KIND = {
  direct_answer: 'answers',
  narrative: 'topics',
  comparison_matrix: 'topics',
  strategy_map: 'topics',
  mind_model: 'topics',
  design_principle: 'topics',
  opportunity: 'actions',
  prioritized_action: 'actions',
  action_plan: 'actions',
  channel_strategy: 'actions',
  research_plan_overview: 'answers',
  research_plan_questions: 'topics',
  research_plan_methods: 'topics',
  research_plan_execution: 'actions',
  research_plan_deliverables: 'actions',
  research_plan_quality: 'evidence',
  evidence_finding: 'analysis',
  limitation: 'evidence',
  open_question: 'evidence',
  risk: 'evidence',
  requested_artifact_binding: 'evidence',
  visual_asset: 'evidence',
  visual_comparison: 'evidence',
  verified_chart: 'evidence',
} as const;

const SINGLE_UNIT_PRESENTATIONS = new Set<ReportPresentationV1>([
  'answer',
  'paragraph',
  'fact',
  'graph',
  'card-grid',
  'stage-flow',
  'image',
  'image-comparison',
  'chart',
]);

export function reportEditorialRequiredVisibilityForUnit(
  unit: ReportEditorialPresentationUnitV1,
): 'always' | 'collapsible' {
  return unit.semanticKind === 'evidence_finding'
    || unit.semanticKind === 'requested_artifact_binding'
    || unit.semanticKind === 'visual_asset'
    || unit.semanticKind === 'visual_comparison'
    || unit.semanticKind === 'verified_chart'
    ? 'collapsible'
    : 'always';
}

export function reportEditorialViewForUnit(
  unit: ReportEditorialPresentationUnitV1,
): (typeof VIEW_BY_SEMANTIC_KIND)[keyof typeof VIEW_BY_SEMANTIC_KIND] {
  return VIEW_BY_SEMANTIC_KIND[unit.semanticKind];
}

export function assertReportEditorialBlueprintIntegrity(
  material: ReportEditorialMaterialV1,
  blueprint: ReportEditorialBlueprintV1,
): void {
  assertReportEditorialMaterialIntegrity(material);
  if (blueprint.version !== 'report-editorial-blueprint-v1') fail('blueprint version is invalid');
  if (blueprint.sections.length === 0) fail('blueprint must contain at least one section');

  const unitsById = new Map(material.presentationUnits.map((unit) => [unit.id, unit]));
  const references: string[] = [];
  for (const section of blueprint.sections) {
    if (!material.constraints.allowedViews.includes(section.view)) {
      fail(`blueprint uses disallowed view ${section.view}`);
    }
    if (section.blocks.length === 0) fail(`blueprint ${section.view} section must contain a block`);
    for (const block of section.blocks) {
      if (block.unitRefs.length === 0) fail('blueprint block must reference a presentation unit');
      assertUnique(block.unitRefs, 'blueprint block unitRef');
      const blockUnits = block.unitRefs.map((unitId) => {
        const unit = unitsById.get(unitId);
        if (!unit) fail(`blueprint references unknown presentation unit ${unitId}`);
        return unit;
      });
      for (const unit of blockUnits) {
        references.push(unit.id);
        const profiles = material.constraints.projectionProfilesByUnitId[unit.id] ?? [];
        if (!profiles.includes(block.presentation) || !isPresentationCompatible(unit, block.presentation)) {
          fail(`blueprint presentation ${block.presentation} is not allowed for unit ${unit.id}`);
        }
        if (reportEditorialViewForUnit(unit) !== section.view) {
          fail(`presentation unit ${unit.id} is assigned to the wrong view ${section.view}`);
        }
        if (
          reportEditorialRequiredVisibilityForUnit(unit) === 'always'
          && block.visibility !== 'always'
        ) {
          fail(`presentation unit ${unit.id} must always be visible`);
        }
        if (unit.semanticKind === 'requested_artifact_binding' && section.prominence === 'appendix') {
          fail(`requested artifact unit ${unit.id} must not be placed in an appendix`);
        }
      }
      if (SINGLE_UNIT_PRESENTATIONS.has(block.presentation) && blockUnits.length !== 1) {
        fail(`${block.presentation} presentation requires exactly one unit`);
      }
      if (block.presentation === 'graph') {
        if (block.variant === undefined) {
          fail('graph presentation requires one unit and an explicit variant');
        }
      } else if (block.variant !== undefined) {
        fail(`presentation ${block.presentation} must not specify a graph variant`);
      }
      if (block.presentation === 'record-table') {
        const shapes = new Set(blockUnits.map(({ shape }) => shape));
        if (shapes.size !== 1) fail('record-table cannot mix source shapes');
        const rowCount = blockUnits.reduce((count, unit) => count + (
          unit.shape === 'matrix' ? unit.cells.length
            : unit.shape === 'actions' ? unit.actions.length
              : unit.shape === 'chart' ? unit.table.rows.length
                : 1
        ), 0);
        if (rowCount > 200) fail('record-table source exceeds 200 rows');
        if (blockUnits.some(({ shape }) => shape === 'matrix') && blockUnits.length !== 1) {
          fail('record-table matrix presentation requires exactly one matrix unit');
        }
        if (blockUnits.some(({ shape }) => shape === 'chart') && blockUnits.length !== 1) {
          fail('record-table chart presentation requires exactly one chart unit');
        }
        if (blockUnits.every(({ shape }) => shape === 'record')) {
          const keys = new Set(blockUnits.flatMap((unit) => (
            unit.shape === 'record' ? unit.fields.map(({ key }) => key) : []
          )));
          if (keys.size > 12) fail('record-table source exceeds 12 columns');
        }
      }
      if (block.presentation === 'priority-board') {
        const counts = new Map<string, number>();
        for (const unit of blockUnits) {
          if (unit.shape !== 'actions') fail('priority-board requires action units');
          for (const action of unit.actions) {
            counts.set(action.priority!, (counts.get(action.priority!) ?? 0) + 1);
          }
        }
        if ([...counts.values()].some((count) => count > 50)) {
          fail('priority-board source exceeds 50 actions in a group');
        }
      }
      if (block.presentation === 'card-grid') {
        if (blockUnits.length !== 1 || blockUnits[0]?.shape !== 'records') {
          fail('card-grid requires exactly one records unit');
        }
        if (blockUnits[0].records.length > 50) fail('card-grid source exceeds 50 records');
      }
      if (block.presentation === 'stage-flow') {
        if (blockUnits.length !== 1 || blockUnits[0]?.shape !== 'stages') {
          fail('stage-flow requires exactly one stages unit');
        }
        if (blockUnits[0].stages.length > 50) fail('stage-flow source exceeds 50 stages');
      }
    }
  }

  assertUnique(references, 'blueprint presentation unit owner');
  if (!sameSet(references, material.constraints.requiredPresentationUnitIds)) {
    fail('blueprint must own every required presentation unit exactly once');
  }
}

function sameBinding(
  left: ReportAuditAppendixMaterialV1['binding'],
  right: ReportEditorialMaterialV1['binding'],
): boolean {
  return left.taskId === right.taskId
    && left.planVersionId === right.planVersionId
    && left.attemptId === right.attemptId
    && left.deliverableArtifactId === right.deliverableArtifactId
    && left.deliverableContentSha256 === right.deliverableContentSha256
    && left.reportReviewArtifactId === right.reportReviewArtifactId;
}

export function assertReportAuditAppendixMaterialIntegrity(
  material: ReportEditorialMaterialV1,
  audit: ReportAuditAppendixMaterialV1,
): void {
  if (audit.version !== 'report-audit-appendix-material-v1') fail('audit material version is invalid');
  if (!sameBinding(audit.binding, material.binding)) fail('audit material binding does not match');
  assertUnique(audit.records.map(({ id }) => id), 'audit record id');
  const allowedKeys = new Set([
    'id',
    'contributionArtifactId',
    'sourceUnitKey',
    'sourceSemanticHash',
    'disposition',
    'canonicalNodeIds',
    'reasonCode',
    'reviewIssueIds',
  ]);
  for (const record of audit.records) {
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      fail(`audit record ${record.id} contains a non-audit field`);
    }
    if (!record.contributionArtifactId.trim() || !record.sourceUnitKey.trim()) {
      fail(`audit record ${record.id} has an empty source identity`);
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(record.sourceSemanticHash)) {
      fail(`audit record ${record.id} has an invalid semantic hash`);
    }
    if (record.reasonCode !== undefined && !/^[a-z0-9][a-z0-9_:-]*$/u.test(record.reasonCode)) {
      fail(`audit record ${record.id} reasonCode must be a machine-readable code`);
    }
    assertUnique(record.canonicalNodeIds, `audit record ${record.id} Canonical node id`);
    assertUnique(record.reviewIssueIds, `audit record ${record.id} Review issue id`);
  }
}
