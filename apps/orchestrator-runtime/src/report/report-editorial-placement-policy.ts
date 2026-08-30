import type {
  EditorialPlacementPolicy,
  ReportEditorialBlueprintV1,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import { reportEditorialViewForUnit } from '../../../../packages/report-rendering/report-editorial-validation.ts';

/**
 * Semantic kinds that must appear in a primary section regardless of model
 * selection. These are the "mandatory body" units.
 */
const MANDATORY_BODY_SEMANTIC_KINDS: Record<string, true> = {
  direct_answer: true,
  prioritized_action: true,
  action_plan: true,
  research_plan_overview: true,
  research_plan_questions: true,
  research_plan_methods: true,
  research_plan_execution: true,
  research_plan_deliverables: true,
};

/**
 * Semantic kinds that are system-level supporting content. They must appear
 * in a supporting section, never in primary, and never in appendix.
 */
const SYSTEM_SUPPORTING_SEMANTIC_KINDS: Record<string, true> = {
  requested_artifact_binding: true,
  research_plan_quality: true,
};

/**
 * Semantic groups where at least one unit must appear in primary if any
 * exist in the material. The compiler picks the first unit in canonical
 * order when the model omits the entire group.
 */
const MAIN_COVERAGE_GROUPS: Array<{
  label: string;
  semanticKinds: Record<string, true>;
}> = [
  {
    label: 'evidence_signal',
    semanticKinds: {
      evidence_finding: true,
      verified_chart: true,
      visual_asset: true,
      visual_comparison: true,
    },
  },
  {
    label: 'risk_signal',
    semanticKinds: { risk: true, limitation: true, open_question: true },
  },
];

/**
 * Maps requested artifact types to the semantic kinds that must be mandatory
 * body units when the user explicitly requested that artifact type.
 */
const REQUESTED_ARTIFACT_MANDATORY_KINDS: Record<string, Record<string, true>> = {
  executive_answers: { direct_answer: true },
  strategy_map: { strategy_map: true },
  mind_model: { mind_model: true },
  design_principles: { design_principle: true },
  opportunity_backlog: { opportunity: true },
  prioritized_actions: { prioritized_action: true },
  channel_strategies: { channel_strategy: true },
  action_plan: { action_plan: true },
};

function isMandatoryBodyUnit(
  unit: ReportEditorialPresentationUnitV1,
  requestedArtifactTypes: readonly string[],
): boolean {
  if (MANDATORY_BODY_SEMANTIC_KINDS[unit.semanticKind]) return true;
  for (const artifactType of requestedArtifactTypes) {
    const kinds = REQUESTED_ARTIFACT_MANDATORY_KINDS[artifactType];
    if (kinds?.[unit.semanticKind]) return true;
  }
  return false;
}

function isSystemSupportingUnit(unit: ReportEditorialPresentationUnitV1): boolean {
  return SYSTEM_SUPPORTING_SEMANTIC_KINDS[unit.semanticKind] === true;
}

/**
 * Derives the deterministic placement policy from the material alone.
 * This is the single source of truth for which units must be primary,
 * which must be supporting, and which groups need minimum coverage.
 *
 * Both the planner-safe projection and the Intent Compiler call this
 * function; the model can only read its result, never override it.
 */
export function deriveEditorialPlacementPolicy(
  material: ReportEditorialMaterialV1,
): EditorialPlacementPolicy {
  const requestedArtifactTypes = material.document.requestedArtifactTypes;
  const mandatoryBodyUnitIds: string[] = [];
  const systemSupportingUnitIds: string[] = [];

  for (const unit of material.presentationUnits) {
    if (isSystemSupportingUnit(unit)) {
      systemSupportingUnitIds.push(unit.id);
    } else if (isMandatoryBodyUnit(unit, requestedArtifactTypes)) {
      mandatoryBodyUnitIds.push(unit.id);
    }
  }

  // Mandatory and system supporting must be disjoint. If an adapter ever
  // produces an intersection, that is a program error.
  const mandatorySet = new Set(mandatoryBodyUnitIds);
  const systemSet = new Set(systemSupportingUnitIds);
  for (const id of mandatorySet) {
    if (systemSet.has(id)) {
      throw new Error(
        `placement policy conflict: unit ${id} is both mandatory body and system supporting`,
      );
    }
  }

  const mainCoverageGroups = MAIN_COVERAGE_GROUPS
    .map((group) => ({
      label: group.label,
      unitIds: material.presentationUnits
        .filter((unit) => group.semanticKinds[unit.semanticKind] === true)
        .map((unit) => unit.id),
    }))
    .filter((group) => group.unitIds.length > 0);

  // Fallback: if no mandatory body and no coverage groups produce any
  // primary, pick the first non-system unit in canonical order.
  let fallbackPrimaryUnitId: string | undefined;
  if (mandatoryBodyUnitIds.length === 0) {
    const firstNonSystem = material.presentationUnits.find(
      (unit) => !isSystemSupportingUnit(unit),
    );
    if (firstNonSystem) {
      fallbackPrimaryUnitId = firstNonSystem.id;
    }
  }

  return {
    mandatoryBodyUnitIds,
    mainCoverageGroups,
    systemSupportingUnitIds,
    ...(fallbackPrimaryUnitId === undefined ? {} : { fallbackPrimaryUnitId }),
  };
}

/**
 * Post-condition assertion: verifies that a compiled Blueprint satisfies
 * the placement policy. Called by the Intent Compiler after compilation.
 *
 * Checks:
 * 1. Every mandatory body unit is in a primary section.
 * 2. Every main coverage group has at least one unit in primary.
 * 3. Every system supporting unit is in a supporting section (not primary, not appendix).
 * 4. At least one primary section exists.
 * 5. Appendix sections contain only units not in primary or supporting.
 */
export function assertEditorialPlacementPolicy(
  material: ReportEditorialMaterialV1,
  blueprint: ReportEditorialBlueprintV1,
  policy: EditorialPlacementPolicy,
): void {
  const unitPlacement = new Map<string, 'primary' | 'supporting' | 'appendix'>();
  for (const section of blueprint.sections) {
    for (const block of section.blocks) {
      for (const unitId of block.unitRefs) {
        unitPlacement.set(unitId, section.prominence);
      }
    }
  }

  // 1. Mandatory body units must be primary.
  for (const unitId of policy.mandatoryBodyUnitIds) {
    const placement = unitPlacement.get(unitId);
    if (placement !== 'primary') {
      throw new Error(
        `placement policy violation: mandatory body unit ${unitId} is in ${placement ?? 'missing'}, expected primary`,
      );
    }
  }

  // 2. Main coverage groups: at least one unit in primary.
  for (const group of policy.mainCoverageGroups) {
    const hasPrimary = group.unitIds.some((id) => unitPlacement.get(id) === 'primary');
    if (!hasPrimary) {
      throw new Error(
        `placement policy violation: coverage group "${group.label}" has no unit in primary`,
      );
    }
  }

  // 3. System supporting units must be in supporting sections.
  for (const unitId of policy.systemSupportingUnitIds) {
    const placement = unitPlacement.get(unitId);
    if (placement !== 'supporting') {
      throw new Error(
        `placement policy violation: system supporting unit ${unitId} is in ${placement ?? 'missing'}, expected supporting`,
      );
    }
  }

  // 4. At least one primary section must exist.
  const hasPrimarySection = blueprint.sections.some((s) => s.prominence === 'primary');
  if (!hasPrimarySection) {
    throw new Error('placement policy violation: no primary section in compiled blueprint');
  }

  // 5. Appendix must not contain mandatory or system supporting units.
  const mandatorySet = new Set(policy.mandatoryBodyUnitIds);
  const systemSet = new Set(policy.systemSupportingUnitIds);
  for (const section of blueprint.sections) {
    if (section.prominence !== 'appendix') continue;
    for (const block of section.blocks) {
      for (const unitId of block.unitRefs) {
        if (mandatorySet.has(unitId)) {
          throw new Error(
            `placement policy violation: mandatory body unit ${unitId} found in appendix`,
          );
        }
        if (systemSet.has(unitId)) {
          throw new Error(
            `placement policy violation: system supporting unit ${unitId} found in appendix`,
          );
        }
      }
    }
  }
}
