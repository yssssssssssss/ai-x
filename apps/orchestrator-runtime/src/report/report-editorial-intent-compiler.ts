import type {
  ReportEditorialBlueprintBlockV1,
  ReportEditorialBlueprintV1,
  ReportEditorialCopyFragmentV2,
  ReportEditorialCopyRejectionV2,
  ReportEditorialCopySelectionV2,
  ReportEditorialIntentV1,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
  ReportPresentationV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import type { ReportViewIdV1 } from '../../../../packages/api-contract/report-document.ts';
import {
  assertReportEditorialBlueprintIntegrity,
  assertReportEditorialMaterialIntegrity,
  isPresentationCompatible,
  reportEditorialRequiredVisibilityForUnit,
  reportEditorialViewForUnit,
} from '../../../../packages/report-rendering/report-editorial-validation.ts';
import type {
  DeterministicEditorialBlueprintOptions,
} from './report-editorial-blueprint.ts';
import {
  deriveEditorialPlacementPolicy,
  assertEditorialPlacementPolicy,
} from './report-editorial-placement-policy.ts';
import {
  validateReportEditorialCopyFragmentsV2,
} from './report-editorial-copy-validator.ts';

export interface IntentCompilerDiagnostics {
  totalUnitCount: number;
  primaryUnitCount: number;
  supportingUnitCount: number;
  appendixUnitCount: number;
  primaryUnitRatio: number;
  mandatoryAutoAddedCount: number;
  coverageAutoAddedCount: number;
  presentationDowngradeCount: number;
  copySoftRequiredCount: number;
  copyAcceptedCount: number;
  copyRejectedCount: number;
  copyMissingCount: number;
}

export interface IntentCompilerResult {
  blueprint: ReportEditorialBlueprintV1;
  editorialCopy: ReportEditorialCopySelectionV2;
  diagnostics: IntentCompilerDiagnostics;
}

const VIEW_ORDER: ReportViewIdV1[] = [
  'answers',
  'topics',
  'actions',
  'evidence',
  'analysis',
];

function enabledOptions(
  options: DeterministicEditorialBlueprintOptions = {},
): Required<DeterministicEditorialBlueprintOptions> {
  return {
    recordTable: options.recordTable ?? true,
    graph: options.graph ?? true,
    priorityBoard: options.priorityBoard ?? true,
    cardGrid: options.cardGrid ?? true,
    stageFlow: options.stageFlow ?? true,
  };
}

function presentationEnabled(
  presentation: ReportPresentationV1,
  options: Required<DeterministicEditorialBlueprintOptions>,
): boolean {
  if (presentation === 'record-table') return options.recordTable;
  if (presentation === 'graph') return options.graph;
  if (presentation === 'priority-board') return options.priorityBoard;
  if (presentation === 'card-grid') return options.cardGrid;
  if (presentation === 'stage-flow') return options.stageFlow;
  return true;
}

function preferredPresentation(
  material: ReportEditorialMaterialV1,
  unit: ReportEditorialPresentationUnitV1,
  options: Required<DeterministicEditorialBlueprintOptions>,
): ReportPresentationV1 {
  const supports = (p: ReportPresentationV1) =>
    material.constraints.projectionProfilesByUnitId[unit.id]?.includes(p) ?? false;

  if (unit.semanticKind === 'direct_answer') return 'answer';
  if (unit.semanticKind === 'narrative') return 'paragraph';
  if (unit.semanticKind === 'comparison_matrix' || unit.semanticKind === 'strategy_map') {
    return options.recordTable && supports('record-table') ? 'record-table' : 'list';
  }
  if (unit.semanticKind === 'mind_model') {
    return options.graph && supports('graph') ? 'graph' : 'list';
  }
  if (unit.semanticKind === 'design_principle') return 'answer';
  if (unit.semanticKind === 'opportunity' || unit.semanticKind === 'channel_strategy') {
    return options.recordTable && supports('record-table') ? 'record-table' : 'answer';
  }
  if (unit.semanticKind === 'prioritized_action') {
    return options.priorityBoard && supports('priority-board') ? 'priority-board' : 'list';
  }
  if (unit.semanticKind === 'action_plan') {
    return options.recordTable && supports('record-table') ? 'record-table' : 'list';
  }
  if (unit.shape === 'records') {
    return options.cardGrid && supports('card-grid') ? 'card-grid' : 'list';
  }
  if (unit.shape === 'stages') {
    return options.stageFlow && supports('stage-flow') ? 'stage-flow' : 'list';
  }
  if (unit.semanticKind === 'evidence_finding'
    || unit.semanticKind === 'limitation'
    || unit.semanticKind === 'open_question'
    || unit.semanticKind === 'risk') return 'fact';
  if (unit.semanticKind === 'requested_artifact_binding') {
    return options.recordTable && supports('record-table') ? 'record-table' : 'list';
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

const SINGLE_UNIT_PRESENTATIONS = new Set<ReportPresentationV1>([
  'answer', 'paragraph', 'fact', 'graph', 'card-grid', 'stage-flow',
  'image', 'image-comparison', 'chart',
]);

function resolvedVisibility(
  units: readonly ReportEditorialPresentationUnitV1[],
  requested: 'always' | 'collapsible',
): 'always' | 'collapsible' {
  return units.some((unit) => reportEditorialRequiredVisibilityForUnit(unit) === 'always')
    ? 'always'
    : requested;
}

function combinationCompatible(
  presentation: ReportPresentationV1,
  units: readonly ReportEditorialPresentationUnitV1[],
): boolean {
  if (SINGLE_UNIT_PRESENTATIONS.has(presentation)) return units.length === 1;
  if (presentation === 'priority-board') {
    if (!units.every(({ shape }) => shape === 'actions')) return false;
    const counts = new Map<string, number>();
    for (const unit of units) {
      if (unit.shape !== 'actions') continue;
      for (const action of unit.actions) {
        if (!action.priority) return false;
        counts.set(action.priority, (counts.get(action.priority) ?? 0) + 1);
      }
    }
    return [...counts.values()].every((count) => count <= 50);
  }
  if (presentation !== 'record-table') return true;
  const shapes = new Set(units.map(({ shape }) => shape));
  if (shapes.size !== 1) return false;
  if (units.some(({ shape }) => shape === 'matrix' || shape === 'chart') && units.length !== 1) {
    return false;
  }
  const rowCount = units.reduce((count, unit) => count + (
    unit.shape === 'matrix' ? unit.cells.length
      : unit.shape === 'actions' ? unit.actions.length
        : unit.shape === 'chart' ? unit.table.rows.length
          : 1
  ), 0);
  if (rowCount > 200) return false;
  if (units.every(({ shape }) => shape === 'record')) {
    const keys = new Set(units.flatMap((unit) => (
      unit.shape === 'record' ? unit.fields.map(({ key }) => key) : []
    )));
    if (keys.size > 12) return false;
  }
  return true;
}

/**
 * Validates one model block after placement splitting. A compatible block keeps
 * its presentation and occurrence; an incompatible block is linearized without
 * coalescing it with neighboring model blocks.
 */
function resolveBlock(
  material: ReportEditorialMaterialV1,
  block: ReportEditorialBlueprintBlockV1,
  units: ReportEditorialPresentationUnitV1[],
  options: Required<DeterministicEditorialBlueprintOptions>,
): { blocks: ReportEditorialBlueprintBlockV1[]; downgradeCount: number } {
  const visibility = resolvedVisibility(units, block.visibility);
  const modelBlock: ReportEditorialBlueprintBlockV1 = {
    ...block,
    unitRefs: units.map(({ id }) => id),
    visibility,
  };
  const allCompatible = units.every((unit) => {
    const profiles = material.constraints.projectionProfilesByUnitId[unit.id] ?? [];
    return profiles.includes(block.presentation)
      && isPresentationCompatible(unit, block.presentation)
      && presentationEnabled(block.presentation, options);
  }) && combinationCompatible(block.presentation, units);

  if (allCompatible) {
    if (modelBlock.presentation === 'graph' && modelBlock.variant === undefined) {
      return {
        blocks: [{ ...modelBlock, variant: graphVariant(units[0]!) }],
        downgradeCount: 0,
      };
    }
    return { blocks: [modelBlock], downgradeCount: 0 };
  }

  const preferred = units.map((unit) => preferredPresentation(material, unit, options));
  const uniquePreferred = new Set(preferred);
  if (
    uniquePreferred.size === 1
    && preferred[0] !== undefined
    && combinationCompatible(preferred[0], units)
  ) {
    const presentation = preferred[0];
    return {
      blocks: [{
        presentation,
        unitRefs: units.map(({ id }) => id),
        visibility,
        ...(presentation === 'graph' ? { variant: graphVariant(units[0]!) } : {}),
      }],
      downgradeCount: 1,
    };
  }

  return {
    blocks: units.map((unit) => ({
      ...blockForUnit(material, unit, options),
      visibility: resolvedVisibility([unit], block.visibility),
    })),
    downgradeCount: 1,
  };
}

interface IndexedCopyFragment {
  fragment: ReportEditorialCopyFragmentV2;
  originalIndex: number;
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function remapIntentCopyFragments(input: {
  material: ReportEditorialMaterialV1;
  intent: ReportEditorialIntentV1;
  blueprint: ReportEditorialBlueprintV1;
}): ReportEditorialCopySelectionV2 {
  const unitsById = new Map(input.material.presentationUnits.map((unit) => [unit.id, unit]));
  const leafToUnitId = new Map<string, string>();
  for (const unit of input.material.presentationUnits) {
    for (const leafId of unit.leafIds) leafToUnitId.set(leafId, unit.id);
  }

  const unitLocations = new Map<string, { sectionIndex: number; blockIndex: number }>();
  input.blueprint.sections.forEach((section, sectionIndex) => {
    section.blocks.forEach((block, blockIndex) => {
      for (const unitId of block.unitRefs) unitLocations.set(unitId, { sectionIndex, blockIndex });
    });
  });

  const sectionUnitIds = input.intent.mainSections.map((section) =>
    section.blocks.flatMap(({ unitRefs }) => unitRefs));
  const sectionLeafIds = sectionUnitIds.map((unitIds) => new Set(
    unitIds.flatMap((unitId) => unitsById.get(unitId)?.leafIds ?? []),
  ));
  const blockLeafIds = input.intent.mainSections.map((section) => section.blocks.map((block) =>
    new Set(block.unitRefs.flatMap((unitId) => unitsById.get(unitId)?.leafIds ?? []))));

  const sectionLocationsForUnits = (unitIds: readonly string[]): number[] => uniqueNumbers(
    unitIds.flatMap((unitId) => {
      const location = unitLocations.get(unitId);
      return location ? [location.sectionIndex] : [];
    }),
  );
  const sectionLocationsForLeaves = (leafIds: readonly string[]): number[] => uniqueNumbers(
    leafIds.flatMap((leafId) => {
      const unitId = leafToUnitId.get(leafId);
      const location = unitId ? unitLocations.get(unitId) : undefined;
      return location ? [location.sectionIndex] : [];
    }),
  );
  const blockLocationsForLeaves = (leafIds: readonly string[]): Array<{
    sectionIndex: number;
    blockIndex: number;
  }> => {
    const keyed = new Map<string, { sectionIndex: number; blockIndex: number }>();
    for (const leafId of leafIds) {
      const unitId = leafToUnitId.get(leafId);
      const location = unitId ? unitLocations.get(unitId) : undefined;
      if (location) keyed.set(`${location.sectionIndex}:${location.blockIndex}`, location);
    }
    return [...keyed.values()];
  };
  const blockLocationsForUnits = (unitIds: readonly string[]): Array<{
    sectionIndex: number;
    blockIndex: number;
  }> => {
    const keyed = new Map<string, { sectionIndex: number; blockIndex: number }>();
    for (const unitId of unitIds) {
      const location = unitLocations.get(unitId);
      if (location) keyed.set(`${location.sectionIndex}:${location.blockIndex}`, location);
    }
    return [...keyed.values()];
  };

  const remapped: IndexedCopyFragment[] = [];
  const remapRejections: ReportEditorialCopyRejectionV2[] = [];
  const reject = (
    originalIndex: number,
    fragment: ReportEditorialCopyFragmentV2,
    reason: ReportEditorialCopyRejectionV2['reasonCodes'][number],
  ): void => {
    remapRejections.push({
      fragmentIndex: originalIndex,
      target: { ...fragment.target },
      reasonCodes: [reason],
    });
  };

  input.intent.copyFragments.forEach((fragment, originalIndex) => {
    const target = fragment.target;
    if (target.kind === 'report_title' || target.kind === 'executive_summary') {
      remapped.push({ fragment: { ...fragment, target: { ...target } }, originalIndex });
      return;
    }

    const sourceSection = input.intent.mainSections[target.sectionIndex];
    if (!sourceSection) {
      reject(originalIndex, fragment, 'target_out_of_range');
      return;
    }

    if (target.kind === 'section_transition') {
      const nextSection = input.intent.mainSections[target.sectionIndex + 1];
      if (!nextSection) {
        reject(originalIndex, fragment, 'target_out_of_range');
        return;
      }
      const allowedLeaves = new Set([
        ...sectionLeafIds[target.sectionIndex]!,
        ...sectionLeafIds[target.sectionIndex + 1]!,
      ]);
      const hasUnknownSource = fragment.sourceLeafIds.some((leafId) => !leafToUnitId.has(leafId));
      if (!hasUnknownSource && fragment.sourceLeafIds.some((leafId) => !allowedLeaves.has(leafId))) {
        reject(originalIndex, fragment, 'source_scope_mismatch');
        return;
      }
      const fromLocations = sectionLocationsForUnits(sectionUnitIds[target.sectionIndex]!);
      const toLocations = sectionLocationsForUnits(sectionUnitIds[target.sectionIndex + 1]!);
      if (
        fromLocations.length !== 1
        || toLocations.length !== 1
        || fromLocations[0]! + 1 !== toLocations[0]
      ) {
        reject(originalIndex, fragment, 'target_out_of_range');
        return;
      }
      remapped.push({
        fragment: {
          ...fragment,
          target: { kind: 'section_transition', sectionIndex: fromLocations[0]! },
        },
        originalIndex,
      });
      return;
    }

    if (target.kind === 'block_digest') {
      const sourceBlock = sourceSection.blocks[target.blockIndex];
      if (!sourceBlock) {
        reject(originalIndex, fragment, 'target_out_of_range');
        return;
      }
      const allowedLeaves = blockLeafIds[target.sectionIndex]![target.blockIndex]!;
      const hasUnknownSource = fragment.sourceLeafIds.some((leafId) => !leafToUnitId.has(leafId));
      if (!hasUnknownSource && fragment.sourceLeafIds.some((leafId) => !allowedLeaves.has(leafId))) {
        reject(originalIndex, fragment, 'source_scope_mismatch');
        return;
      }
      const sourceLocations = blockLocationsForLeaves(fragment.sourceLeafIds);
      const fallbackLocations = blockLocationsForUnits(sourceBlock.unitRefs);
      const locations = sourceLocations.length > 0 ? sourceLocations : fallbackLocations;
      if (locations.length !== 1) {
        reject(originalIndex, fragment, 'target_out_of_range');
        return;
      }
      remapped.push({
        fragment: {
          ...fragment,
          target: { kind: 'block_digest', ...locations[0]! },
        },
        originalIndex,
      });
      return;
    }

    const allowedLeaves = sectionLeafIds[target.sectionIndex]!;
    const hasUnknownSource = fragment.sourceLeafIds.some((leafId) => !leafToUnitId.has(leafId));
    if (!hasUnknownSource && fragment.sourceLeafIds.some((leafId) => !allowedLeaves.has(leafId))) {
      reject(originalIndex, fragment, 'source_scope_mismatch');
      return;
    }
    const locations = sectionLocationsForLeaves(fragment.sourceLeafIds);
    const fallbackLocations = sectionLocationsForUnits(sectionUnitIds[target.sectionIndex]!);
    const resolvedLocations = locations.length > 0 ? locations : fallbackLocations;
    if (resolvedLocations.length !== 1) {
      reject(originalIndex, fragment, 'target_out_of_range');
      return;
    }
    remapped.push({
      fragment: {
        ...fragment,
        target: { kind: target.kind, sectionIndex: resolvedLocations[0]! },
      },
      originalIndex,
    });
  });

  const validated = validateReportEditorialCopyFragmentsV2({
    material: input.material,
    blueprint: input.blueprint,
    fragments: remapped.map(({ fragment }) => fragment),
    fragmentIndexes: remapped.map(({ originalIndex }) => originalIndex),
  });
  return {
    fragments: validated.fragments,
    rejectedFragments: [
      ...remapRejections,
      ...validated.rejectedFragments,
    ].sort((left, right) => left.fragmentIndex - right.fragmentIndex),
  };
}

/**
 * Compiles a partial ReportEditorialIntentV1 into a complete, strict
 * ReportEditorialBlueprintV1. This is the only seam between model suggestion
 * and the strict publication contract.
 *
 * The compiler is a pure function with no I/O. It never calls the LLM,
 * never retries, and never modifies the material.
 */
export function compileReportEditorialIntent(
  material: ReportEditorialMaterialV1,
  intent: ReportEditorialIntentV1,
  options: DeterministicEditorialBlueprintOptions = {},
): IntentCompilerResult {
  assertReportEditorialMaterialIntegrity(material);
  if (intent.version !== 'report-editorial-intent-v1') {
    throw new Error('Intent version must be report-editorial-intent-v1');
  }
  if (!Array.isArray(intent.mainSections) || !Array.isArray(intent.copyFragments)) {
    throw new Error('Intent sections and copy fragments must be arrays');
  }
  const enabled = enabledOptions(options);
  const policy = deriveEditorialPlacementPolicy(material);
  const unitsById = new Map(material.presentationUnits.map((u) => [u.id, u]));

  // ── Step 1: Validate Intent unitRefs ──────────────────────────────
  const referencedUnitIds = new Set<string>();
  for (const section of intent.mainSections) {
    for (const block of section.blocks) {
      for (const unitId of block.unitRefs) {
        const unit = unitsById.get(unitId);
        if (!unit) {
          throw new Error(`Intent references unknown unit ${unitId}`);
        }
        if (reportEditorialViewForUnit(unit) !== section.view) {
          throw new Error(`Intent places unit ${unitId} in the wrong view ${section.view}`);
        }
        if (referencedUnitIds.has(unitId)) {
          throw new Error(`Intent references unit ${unitId} more than once`);
        }
        referencedUnitIds.add(unitId);
      }
    }
  }

  // ── Step 2: Resolve placement for every unit ──────────────────────
  // Priority: mandatory body > system supporting > model choice > appendix
  const mandatorySet = new Set(policy.mandatoryBodyUnitIds);
  const systemSet = new Set(policy.systemSupportingUnitIds);
  const modelPlacement = new Map<string, 'primary' | 'supporting'>();
  for (const section of intent.mainSections) {
    for (const block of section.blocks) {
      for (const unitId of block.unitRefs) {
        modelPlacement.set(unitId, section.prominence);
      }
    }
  }

  const finalPlacement = new Map<string, 'primary' | 'supporting' | 'appendix'>();
  for (const unit of material.presentationUnits) {
    if (mandatorySet.has(unit.id)) {
      finalPlacement.set(unit.id, 'primary');
    } else if (systemSet.has(unit.id)) {
      finalPlacement.set(unit.id, 'supporting');
    } else if (modelPlacement.has(unit.id)) {
      finalPlacement.set(unit.id, modelPlacement.get(unit.id)!);
    } else {
      finalPlacement.set(unit.id, 'appendix');
    }
  }

  // ── Step 3: Ensure coverage groups have at least one primary ──────
  let coverageAutoAddedCount = 0;
  for (const group of policy.mainCoverageGroups) {
    const hasPrimary = group.unitIds.some((id) => finalPlacement.get(id) === 'primary');
    if (!hasPrimary) {
      // Promote the first unit in canonical order to primary.
      const firstUnitId = group.unitIds[0]!;
      finalPlacement.set(firstUnitId, 'primary');
      coverageAutoAddedCount += 1;
    }
  }

  // ── Step 4: Fallback primary if still no primary ──────────────────
  const hasAnyPrimary = [...finalPlacement.values()].some((p) => p === 'primary');
  if (!hasAnyPrimary && policy.fallbackPrimaryUnitId) {
    finalPlacement.set(policy.fallbackPrimaryUnitId, 'primary');
  }

  // ── Step 5: Build retained model sections ─────────────────────────
  const sections: ReportEditorialBlueprintV1['sections'] = [];
  let presentationDowngradeCount = 0;
  const placedUnits = new Set<string>();

  // Preserve each model section and block occurrence. Mixed placement is
  // emitted as contiguous runs so the source unit order is never reversed.
  for (const intentSection of intent.mainSections) {
    const sectionRuns: Array<{
      prominence: 'primary' | 'supporting';
      blocks: ReportEditorialBlueprintBlockV1[];
    }> = [];

    for (const block of intentSection.blocks) {
      const unitRuns: Array<{
        prominence: 'primary' | 'supporting';
        units: ReportEditorialPresentationUnitV1[];
      }> = [];
      for (const unitId of block.unitRefs) {
        const placement = finalPlacement.get(unitId)!;
        if (placement === 'appendix') continue;
        const unit = unitsById.get(unitId)!;
        const current = unitRuns.at(-1);
        if (current?.prominence === placement) current.units.push(unit);
        else unitRuns.push({ prominence: placement, units: [unit] });
      }

      for (const unitRun of unitRuns) {
        const resolved = resolveBlock(material, block, unitRun.units, enabled);
        presentationDowngradeCount += resolved.downgradeCount;
        const currentSection = sectionRuns.at(-1);
        if (currentSection?.prominence === unitRun.prominence) {
          currentSection.blocks.push(...resolved.blocks);
        } else {
          sectionRuns.push({
            prominence: unitRun.prominence,
            blocks: [...resolved.blocks],
          });
        }
        for (const unit of unitRun.units) placedUnits.add(unit.id);
      }
    }

    for (const run of sectionRuns) {
      sections.push({
        headingMode: intentSection.headingMode,
        view: intentSection.view,
        prominence: run.prominence,
        blocks: run.blocks,
      });
    }
  }

  // ── Step 6: Add mandatory body units not placed by model ──────────
  let mandatoryAutoAddedCount = 0;
  const unplacedMandatory = policy.mandatoryBodyUnitIds.filter(
    (id) => !placedUnits.has(id),
  );
  if (unplacedMandatory.length > 0) {
    // Group by view.
    const byView = new Map<ReportViewIdV1, ReportEditorialPresentationUnitV1[]>();
    for (const unitId of unplacedMandatory) {
      const unit = unitsById.get(unitId)!;
      const view = reportEditorialViewForUnit(unit);
      const bucket = byView.get(view) ?? [];
      bucket.push(unit);
      byView.set(view, bucket);
      placedUnits.add(unitId);
      mandatoryAutoAddedCount += 1;
    }
    for (const view of VIEW_ORDER) {
      const units = byView.get(view);
      if (!units || units.length === 0) continue;
      // Merge into existing primary section for this view, or create new.
      const existingSection = sections.find(
        (s) => s.prominence === 'primary' && s.view === view,
      );
      const newBlocks = units.map((unit) => blockForUnit(material, unit, enabled));
      if (existingSection) {
        existingSection.blocks.push(...newBlocks);
      } else {
        sections.push({
          headingMode: 'view_label',
          view,
          prominence: 'primary',
          blocks: newBlocks,
        });
      }
    }
  }

  // ── Step 7: Add system supporting units not placed by model ───────
  const unplacedSystem = policy.systemSupportingUnitIds.filter(
    (id) => !placedUnits.has(id),
  );
  if (unplacedSystem.length > 0) {
    const byView = new Map<ReportViewIdV1, ReportEditorialPresentationUnitV1[]>();
    for (const unitId of unplacedSystem) {
      const unit = unitsById.get(unitId)!;
      const view = reportEditorialViewForUnit(unit);
      const bucket = byView.get(view) ?? [];
      bucket.push(unit);
      byView.set(view, bucket);
      placedUnits.add(unitId);
    }
    for (const view of VIEW_ORDER) {
      const units = byView.get(view);
      if (!units || units.length === 0) continue;
      const existingSection = sections.find(
        (s) => s.prominence === 'supporting' && s.view === view,
      );
      const newBlocks = units.map((unit) => blockForUnit(material, unit, enabled));
      if (existingSection) {
        existingSection.blocks.push(...newBlocks);
      } else {
        sections.push({
          headingMode: 'view_label',
          view,
          prominence: 'supporting',
          blocks: newBlocks,
        });
      }
    }
  }

  // ── Step 7.5: Place coverage-promoted and fallback-primary units ──
  // These are units promoted to primary by step 3 (coverage groups) or
  // step 4 (fallback primary) that were not placed by the model (step 5)
  // or by mandatory auto-add (step 6).
  const unplacedPrimary = material.presentationUnits.filter(
    (unit) =>
      !placedUnits.has(unit.id)
      && finalPlacement.get(unit.id) === 'primary'
      && !mandatorySet.has(unit.id),
  );
  if (unplacedPrimary.length > 0) {
    const byView = new Map<ReportViewIdV1, ReportEditorialPresentationUnitV1[]>();
    for (const unit of unplacedPrimary) {
      const view = reportEditorialViewForUnit(unit);
      const bucket = byView.get(view) ?? [];
      bucket.push(unit);
      byView.set(view, bucket);
      placedUnits.add(unit.id);
    }
    for (const view of VIEW_ORDER) {
      const units = byView.get(view);
      if (!units || units.length === 0) continue;
      const existingSection = sections.find(
        (s) => s.prominence === 'primary' && s.view === view,
      );
      const newBlocks = units.map((unit) => blockForUnit(material, unit, enabled));
      if (existingSection) {
        existingSection.blocks.push(...newBlocks);
      } else {
        sections.push({
          headingMode: 'view_label',
          view,
          prominence: 'primary',
          blocks: newBlocks,
        });
      }
    }
  }

  // ── Step 8: Generate appendix sections for remaining units ────────
  const appendixUnits = material.presentationUnits.filter(
    (unit) => !placedUnits.has(unit.id) && finalPlacement.get(unit.id) === 'appendix',
  );
  if (appendixUnits.length > 0) {
    // Group by view, then by semanticKind.
    const byView = new Map<ReportViewIdV1, ReportEditorialPresentationUnitV1[]>();
    for (const unit of appendixUnits) {
      const view = reportEditorialViewForUnit(unit);
      const bucket = byView.get(view) ?? [];
      bucket.push(unit);
      byView.set(view, bucket);
      placedUnits.add(unit.id);
    }
    for (const view of VIEW_ORDER) {
      const units = byView.get(view);
      if (!units || units.length === 0) continue;
      // Group by semanticKind within the view.
      const byKind = new Map<string, ReportEditorialPresentationUnitV1[]>();
      for (const unit of units) {
        const bucket = byKind.get(unit.semanticKind) ?? [];
        bucket.push(unit);
        byKind.set(unit.semanticKind, bucket);
      }
      const blocks: ReportEditorialBlueprintBlockV1[] = [];
      for (const [, kindUnits] of byKind) {
        for (const unit of kindUnits) {
          blocks.push(blockForUnit(material, unit, enabled));
        }
      }
      sections.push({
        headingMode: 'view_label',
        view,
        prominence: 'appendix',
        blocks,
      });
    }
  }

  // Retained model sections keep their relative order. Deterministic additions
  // were appended in stable view order, and every appendix section is appended
  // only after the complete primary/supporting body.
  // ── Step 10: Build and validate Blueprint ─────────────────────────
  const blueprint: ReportEditorialBlueprintV1 = {
    version: 'report-editorial-blueprint-v1',
    style: intent.style,
    density: intent.density,
    sections,
  };

  // ── Step 11: Validate ─────────────────────────────────────────────
  assertReportEditorialBlueprintIntegrity(material, blueprint);
  assertEditorialPlacementPolicy(material, blueprint, policy);

  // ── Copy remapping and validation ─────────────────────────────────
  const editorialCopy = remapIntentCopyFragments({ material, intent, blueprint });

  return {
    blueprint,
    editorialCopy,
    diagnostics: buildDiagnostics(
      material,
      blueprint,
      mandatoryAutoAddedCount,
      coverageAutoAddedCount,
      presentationDowngradeCount,
      editorialCopy.fragments.length,
      editorialCopy.rejectedFragments.length,
      countSoftRequiredMissing(blueprint, editorialCopy),
    ),
  };
}

export function createDeterministicReportEditorialIntentCompilation(
  material: ReportEditorialMaterialV1,
  options: DeterministicEditorialBlueprintOptions = {},
): IntentCompilerResult {
  return compileReportEditorialIntent(material, {
    version: 'report-editorial-intent-v1',
    style: 'analytical',
    density: 'comfortable',
    mainSections: [],
    copyFragments: [],
  }, options);
}

function countUnitsByProminence(
  blueprint: ReportEditorialBlueprintV1,
  prominence: 'primary' | 'supporting' | 'appendix',
): number {
  return blueprint.sections
    .filter((s) => s.prominence === prominence)
    .reduce((count, s) => count + s.blocks.reduce((c, b) => c + b.unitRefs.length, 0), 0);
}

function countSoftRequiredMissing(
  blueprint: ReportEditorialBlueprintV1,
  copy: ReportEditorialCopySelectionV2,
): number {
  // Soft-required: report_title, executive_summary, section_title for all non-appendix sections.
  const acceptedKinds = new Set(copy.fragments.map((f) => {
    if (f.target.kind === 'report_title') return 'report_title';
    if (f.target.kind === 'executive_summary') return 'executive_summary';
    if (f.target.kind === 'section_title') return `section_title:${f.target.sectionIndex}`;
    return null;
  }).filter(Boolean));

  let missing = 0;
  if (!acceptedKinds.has('report_title')) missing += 1;
  if (!acceptedKinds.has('executive_summary')) missing += 1;
  blueprint.sections.forEach((section, index) => {
    if (section.prominence !== 'appendix' && !acceptedKinds.has(`section_title:${index}`)) {
      missing += 1;
    }
  });
  return missing;
}

function buildDiagnostics(
  material: ReportEditorialMaterialV1,
  blueprint: ReportEditorialBlueprintV1,
  mandatoryAutoAddedCount: number,
  coverageAutoAddedCount: number,
  presentationDowngradeCount: number,
  copyAcceptedCount: number,
  copyRejectedCount: number,
  copyMissingCount: number,
): IntentCompilerDiagnostics {
  const totalUnitCount = material.presentationUnits.length;
  const primaryUnitCount = countUnitsByProminence(blueprint, 'primary');
  const supportingUnitCount = countUnitsByProminence(blueprint, 'supporting');
  const appendixUnitCount = countUnitsByProminence(blueprint, 'appendix');
  return {
    totalUnitCount,
    primaryUnitCount,
    supportingUnitCount,
    appendixUnitCount,
    primaryUnitRatio: totalUnitCount > 0 ? primaryUnitCount / totalUnitCount : 0,
    mandatoryAutoAddedCount,
    coverageAutoAddedCount,
    presentationDowngradeCount,
    copySoftRequiredCount: 2 + blueprint.sections.filter((s) => s.prominence !== 'appendix').length,
    copyAcceptedCount,
    copyRejectedCount,
    copyMissingCount,
  };
}
