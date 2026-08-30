import type {
  ReportEditorialBlueprintBlockV1,
  ReportEditorialBlueprintV1,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
  ReportPresentationV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import type { ReportViewIdV1 } from '../../../../packages/api-contract/report-document.ts';
import {
  assertReportEditorialBlueprintIntegrity,
  assertReportEditorialMaterialIntegrity,
  reportEditorialRequiredVisibilityForUnit,
  reportEditorialViewForUnit,
} from '../../../../packages/report-rendering/report-editorial-validation.ts';

export interface DeterministicEditorialBlueprintOptions {
  recordTable?: boolean;
  graph?: boolean;
  priorityBoard?: boolean;
  cardGrid?: boolean;
  stageFlow?: boolean;
}

const VIEW_ORDER: ReportViewIdV1[] = [
  'answers',
  'topics',
  'actions',
  'evidence',
  'analysis',
];

function supports(
  material: ReportEditorialMaterialV1,
  unit: ReportEditorialPresentationUnitV1,
  presentation: ReportPresentationV1,
): boolean {
  return material.constraints.projectionProfilesByUnitId[unit.id]?.includes(presentation) ?? false;
}

function preferredPresentation(
  material: ReportEditorialMaterialV1,
  unit: ReportEditorialPresentationUnitV1,
  options: Required<DeterministicEditorialBlueprintOptions>,
): ReportPresentationV1 {
  if (unit.semanticKind === 'direct_answer') return 'answer';
  if (unit.semanticKind === 'narrative') return 'paragraph';
  if (unit.semanticKind === 'comparison_matrix' || unit.semanticKind === 'strategy_map') {
    return options.recordTable && supports(material, unit, 'record-table') ? 'record-table' : 'list';
  }
  if (unit.semanticKind === 'mind_model') {
    return options.graph && supports(material, unit, 'graph') ? 'graph' : 'list';
  }
  if (unit.semanticKind === 'design_principle') return 'answer';
  if (unit.semanticKind === 'opportunity' || unit.semanticKind === 'channel_strategy') {
    return options.recordTable && supports(material, unit, 'record-table') ? 'record-table' : 'answer';
  }
  if (unit.semanticKind === 'prioritized_action') {
    return options.priorityBoard && supports(material, unit, 'priority-board')
      ? 'priority-board'
      : 'list';
  }
  if (unit.semanticKind === 'action_plan') {
    return options.recordTable && supports(material, unit, 'record-table') ? 'record-table' : 'list';
  }
  if (unit.shape === 'records') {
    return options.cardGrid && supports(material, unit, 'card-grid') ? 'card-grid' : 'list';
  }
  if (unit.shape === 'stages') {
    return options.stageFlow && supports(material, unit, 'stage-flow') ? 'stage-flow' : 'list';
  }
  if (unit.semanticKind === 'evidence_finding'
    || unit.semanticKind === 'limitation'
    || unit.semanticKind === 'open_question'
    || unit.semanticKind === 'risk') return 'fact';
  if (unit.semanticKind === 'requested_artifact_binding') {
    return options.recordTable && supports(material, unit, 'record-table') ? 'record-table' : 'list';
  }
  if (unit.semanticKind === 'visual_asset') return 'image';
  if (unit.semanticKind === 'visual_comparison') return 'image-comparison';
  if (unit.semanticKind === 'verified_chart') return 'chart';
  return 'list';
}

function graphVariant(unit: ReportEditorialPresentationUnitV1): 'linear' | 'hub_spoke' {
  if (unit.shape !== 'graph' || unit.nodes.length < 3) return 'linear';
  const degrees = new Map(unit.nodes.map(({ id }) => [id, 0]));
  for (const edge of unit.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  return [...degrees.values()].some((degree) => degree >= unit.nodes.length - 1)
    ? 'hub_spoke'
    : 'linear';
}

function canGroup(
  left: { unit: ReportEditorialPresentationUnitV1; block: ReportEditorialBlueprintBlockV1 },
  right: { unit: ReportEditorialPresentationUnitV1; block: ReportEditorialBlueprintBlockV1 },
): boolean {
  if (left.block.presentation !== right.block.presentation) return false;
  if (left.block.visibility !== right.block.visibility) return false;
  if (left.block.presentation !== 'record-table') return false;
  if (left.unit.shape !== 'record' || right.unit.shape !== 'record') return false;
  if (left.unit.semanticKind !== right.unit.semanticKind) return false;
  if (left.unit.semanticKind === 'requested_artifact_binding') return true;
  return left.unit.title === right.unit.title;
}

function blockForUnit(
  material: ReportEditorialMaterialV1,
  unit: ReportEditorialPresentationUnitV1,
  options: Required<DeterministicEditorialBlueprintOptions>,
): ReportEditorialBlueprintBlockV1 {
  const presentation = preferredPresentation(material, unit, options);
  return {
    presentation,
    unitRefs: [unit.id],
    visibility: reportEditorialRequiredVisibilityForUnit(unit),
    ...(presentation === 'graph' ? { variant: graphVariant(unit) } : {}),
  };
}

function prominence(units: readonly ReportEditorialPresentationUnitV1[]): 'primary' | 'supporting' {
  return units.some((unit) => unit.semanticKind === 'direct_answer'
    || unit.semanticKind === 'opportunity'
    || unit.semanticKind === 'prioritized_action'
    || unit.semanticKind === 'action_plan'
    || unit.semanticKind === 'research_plan_overview'
    || unit.semanticKind === 'research_plan_execution'
    || unit.semanticKind === 'research_plan_deliverables'
    || unit.semanticKind === 'research_plan_quality'
    || unit.semanticKind === 'limitation'
    || unit.semanticKind === 'open_question'
    || unit.semanticKind === 'risk')
    ? 'primary'
    : 'supporting';
}

export function createDeterministicReportEditorialBlueprintV1(
  material: ReportEditorialMaterialV1,
  options: DeterministicEditorialBlueprintOptions = {},
): ReportEditorialBlueprintV1 {
  assertReportEditorialMaterialIntegrity(material);
  const enabled: Required<DeterministicEditorialBlueprintOptions> = {
    recordTable: options.recordTable ?? true,
    graph: options.graph ?? true,
    priorityBoard: options.priorityBoard ?? true,
    cardGrid: options.cardGrid ?? true,
    stageFlow: options.stageFlow ?? true,
  };
  const sections: ReportEditorialBlueprintV1['sections'] = [];
  for (const view of VIEW_ORDER) {
    const units = material.presentationUnits.filter((unit) => reportEditorialViewForUnit(unit) === view);
    if (units.length === 0) continue;
    const candidates = units.map((unit) => ({ unit, block: blockForUnit(material, unit, enabled) }));
    const blocks: ReportEditorialBlueprintBlockV1[] = [];
    for (const candidate of candidates) {
      const previous = blocks.at(-1);
      const previousUnitId = previous?.unitRefs.at(-1);
      const previousUnit = previousUnitId
        ? material.presentationUnits.find(({ id }) => id === previousUnitId)
        : undefined;
      if (previous && previousUnit && canGroup({ unit: previousUnit, block: previous }, candidate)) {
        previous.unitRefs.push(candidate.unit.id);
      } else {
        blocks.push(candidate.block);
      }
    }
    sections.push({
      headingMode: 'view_label',
      view,
      prominence: prominence(units),
      blocks,
    });
  }
  const blueprint: ReportEditorialBlueprintV1 = {
    version: 'report-editorial-blueprint-v1',
    style: 'analytical',
    density: 'comfortable',
    sections,
  };
  assertReportEditorialBlueprintIntegrity(material, blueprint);
  return blueprint;
}
