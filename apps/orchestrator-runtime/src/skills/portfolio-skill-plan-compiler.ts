import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentCompiledSkillInvocationV2,
  CurrentCompiledSkillInvocationV3,
  CurrentExecutionPlanV3,
  CurrentLegacySkillInvocationV3,
  CurrentPlanStep,
  CurrentPlanStepV3,
  CurrentSkillInvocation,
  CurrentSkillInvocationV3,
  CurrentSkillInvocationV3Base,
  PlanContributionRequirement,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { CapabilityResolution } from '../planners/capability-resolver.ts';
import {
  portfolioActorValidationIssues,
  type SkillPortfolioDecision,
} from '../planners/capability-portfolio-resolver.ts';
import {
  CONFIG_PATHS,
  hashFile,
  loadToolRegistry,
  resolveSkillComposition,
} from '../runtime/config-loader.ts';
import { SkillLoader } from '../runtime/skill-loader.ts';
import { stableJsonHash, stableJsonStringify } from '../runtime/stable-json.ts';
import {
  assertFrozenKnowledgeQueryMembership,
  compileSkillSteps,
  CompiledSkillPlanDriftError,
} from './skill-plan-compiler.ts';
import { loadSkillReferenceDocuments } from './skill-runtime.ts';

export interface PortfolioSkillCompilationInput {
  steps: readonly CurrentPlanStep[];
  task: ResearchTaskV2;
  portfolio: SkillPortfolioDecision;
  capabilityResolution?: CapabilityResolution;
  skillLoader?: SkillLoader;
}

export interface PortfolioSkillCompilationResult {
  steps: CurrentPlanStepV3[];
  invocations: CurrentSkillInvocationV3[];
  contributionRequirements: PlanContributionRequirement[];
}

interface SourceSkillBinding {
  sourceStep: CurrentPlanStep;
  invocationId: string;
  stepNos: number[];
  outputStepNo: number;
  compiledInvocation?: CurrentCompiledSkillInvocationV2;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function planShareFingerprint(step: CurrentPlanStepV3): string {
  let runtimeIdentity: Record<string, unknown> = {};
  if (step.actor_type === 'tool') {
    try {
      const tool = loadToolRegistry().tools.find(({ id }) => id === step.actor_id);
      runtimeIdentity = {
        tool_registry_hash: hashFile(CONFIG_PATHS.toolRegistry),
        manifest_hash: tool ? hashFile(tool.path) : null,
        declared_adapter_type: tool?.adapter_type ?? null,
        tier: tool?.tier ?? null,
      };
    } catch {
      runtimeIdentity = { registry_identity: 'unavailable' };
    }
  }
  if (step.actor_type === 'knowledge') {
    runtimeIdentity = {
      contract_hash: step.input.contractHash ?? null,
      references: step.input.references ?? [],
    };
  }
  const value = {
    actor_type: step.actor_type,
    actor_id: step.actor_id,
    skill_stage_id: step.skill_stage_id ?? null,
    question_ids: [...step.question_ids].sort((left, right) => left.localeCompare(right)),
    depends_on: [...step.depends_on].sort((left, right) => left - right),
    input: step.input,
    input_bindings: [...step.input_bindings].sort((left, right) => (
      left.target_pointer.localeCompare(right.target_pointer)
      || left.source_step_no - right.source_step_no
      || left.source_pointer.localeCompare(right.source_pointer)
    )),
    requires_approval: step.requires_approval,
    approval_role: step.approval_role ?? null,
    expected_outputs: step.expected_outputs,
    acceptance_criteria: step.acceptance_criteria,
    runtime_identity: runtimeIdentity,
  };
  return stableJsonHash(value);
}

function deduplicateSharedSourceSteps(
  sourceSteps: readonly CurrentPlanStep[],
  portfolio: SkillPortfolioDecision,
): CurrentPlanStep[] {
  const steps = sourceSteps.map((step) => structuredClone(step));
  const duplicateToCanonical = new Map<number, number>();
  for (const prerequisite of portfolio.sharedPrerequisites) {
    const matches = steps.filter((step) => (
      step.actor_type === prerequisite.capabilityType
      && step.actor_id === prerequisite.capabilityId
    ));
    if (matches.length < 2) continue;
    const fingerprints = new Set(matches.map((step) => planShareFingerprint(step)));
    if (fingerprints.size !== 1) {
      throw new Error(
        `Shared prerequisite ${prerequisite.capabilityType}:${prerequisite.capabilityId} has non-identical execution contracts`,
      );
    }
    const canonical = [...matches].sort((left, right) => left.step_no - right.step_no)[0]!;
    for (const duplicate of matches.slice(1)) {
      duplicateToCanonical.set(duplicate.step_no, canonical.step_no);
    }
  }
  if (duplicateToCanonical.size === 0) return steps;
  const retained = steps.filter((step) => !duplicateToCanonical.has(step.step_no));
  const newStepNoByOld = new Map(retained.map((step, index) => [step.step_no, index + 1]));
  const canonicalOldStepNo = (stepNo: number): number => duplicateToCanonical.get(stepNo) ?? stepNo;
  return retained.map((step, index) => ({
    ...step,
    step_no: index + 1,
    depends_on: uniqueSorted(step.depends_on.map((dependency) => {
      const mapped = newStepNoByOld.get(canonicalOldStepNo(dependency));
      if (!mapped) throw new Error(`shared dependency ${dependency} cannot be remapped`);
      return mapped;
    })),
    input_bindings: step.input_bindings.map((binding) => {
      const mapped = newStepNoByOld.get(canonicalOldStepNo(binding.source_step_no));
      if (!mapped) throw new Error(`shared binding source ${binding.source_step_no} cannot be remapped`);
      return { ...binding, source_step_no: mapped };
    }),
  }));
}

function normalizePortfolioOwnedWiring(
  sourceSteps: readonly CurrentPlanStep[],
  allowedPrerequisites: ReadonlySet<string>,
  discardablePrerequisites: ReadonlySet<string>,
): CurrentPlanStep[] {
  for (const step of sourceSteps) {
    if (step.actor_type === 'skill') continue;
    const actorKey = `${step.actor_type}:${step.actor_id}`;
    if (
      (step.actor_type === 'tool' || step.actor_type === 'knowledge')
      && (allowedPrerequisites.has(actorKey) || discardablePrerequisites.has(actorKey))
    ) continue;
    throw new Error(
      `Portfolio candidate contains unauthorized actor ${step.actor_type}:${step.actor_id}`,
    );
  }
  const retained = sourceSteps.filter((step) => (
    step.actor_type === 'skill'
    || allowedPrerequisites.has(`${step.actor_type}:${step.actor_id}`)
  ));
  const newStepNoByOld = new Map(retained.map((step, index) => [step.step_no, index + 1]));
  const skillStepNos = new Set(retained
    .filter(({ actor_type }) => actor_type === 'skill')
    .map(({ step_no }) => step_no));
  return retained.map((step, index) => {
    const allowedOldDependencies = step.depends_on.filter((stepNo) => (
      stepNo < step.step_no
      && newStepNoByOld.has(stepNo)
      && !skillStepNos.has(stepNo)
    ));
    const allowedBindings = step.input_bindings.filter(({ source_step_no }) => (
      source_step_no < step.step_no
      && newStepNoByOld.has(source_step_no)
      && !skillStepNos.has(source_step_no)
    ));
    const normalized = structuredClone(step);
    delete normalized.skill_invocation_id;
    delete normalized.skill_stage_id;
    Reflect.deleteProperty(normalized, 'shared_stage_key');
    Reflect.deleteProperty(normalized, 'shared_by_invocation_ids');
    Reflect.deleteProperty(normalized, 'share_fingerprint');
    return {
      ...normalized,
      step_no: index + 1,
      depends_on: allowedOldDependencies.map((stepNo) => newStepNoByOld.get(stepNo)!),
      input_bindings: allowedBindings.map((binding) => ({
        ...binding,
        source_step_no: newStepNoByOld.get(binding.source_step_no)!,
      })),
    };
  });
}

function canonicalizeSharedSourceInputs(
  sourceSteps: readonly CurrentPlanStep[],
  portfolio: SkillPortfolioDecision,
  skillLoader: SkillLoader,
): CurrentPlanStep[] {
  const steps = sourceSteps.map((step) => structuredClone(step));
  for (const prerequisite of portfolio.sharedPrerequisites) {
    const sourceMatches = steps.filter((step) => (
      step.actor_type === prerequisite.capabilityType
      && step.actor_id === prerequisite.capabilityId
    ));
    if (sourceMatches.length === 0) continue;
    const contractStages = prerequisite.consumerSkillIds.flatMap((skillId) => {
      const loaded = skillLoader.loadSkillExecution(skillId);
      if (!loaded) return [];
      const stage = loaded.contract.stages.find((candidate) => (
        candidate.actor_type === prerequisite.capabilityType
        && candidate.actor_id === prerequisite.capabilityId
        && candidate.share_scope === 'plan'
      ));
      return stage ? [stage] : [];
    });
    if (contractStages.length === 0) continue;
    for (const source of sourceMatches) {
      const canonicalInputs = contractStages.map((stage) => {
        const dynamicInput = Object.fromEntries((stage.share_input_fields ?? []).flatMap((field) => (
          Object.hasOwn(source.input, field) ? [[field, structuredClone(source.input[field])]] : []
        )));
        return { ...structuredClone(stage.input), ...dynamicInput };
      });
      if (canonicalInputs.some((input) => !isDeepStrictEqual(input, canonicalInputs[0]))) {
        throw new Error(
          `Shared prerequisite ${prerequisite.capabilityType}:${prerequisite.capabilityId} has incompatible canonical inputs`,
        );
      }
      source.input = canonicalInputs[0]!;
    }
  }
  return steps;
}

function sourceBindings(
  sourceSteps: readonly CurrentPlanStep[],
  compiledSteps: readonly CurrentPlanStepV3[],
  compiledInvocations: readonly CurrentSkillInvocation[],
  portfolio: SkillPortfolioDecision,
): Map<string, SourceSkillBinding> {
  const result = new Map<string, SourceSkillBinding>();
  for (const invocation of portfolio.invocations) {
    const sourceStep = sourceSteps.find((step) => (
      step.actor_type === 'skill' && step.actor_id === invocation.skillId
    ));
    if (!sourceStep) throw new Error(`Portfolio Skill ${invocation.skillId} has no source step`);
    const sourceInvocation = compiledInvocations.find(({ skill_id, invocation_id }) => (
      skill_id === invocation.skillId && invocation_id.endsWith(`:${sourceStep.step_no}`)
    ));
    if (!sourceInvocation) {
      throw new Error(`Portfolio Skill ${invocation.skillId} has no source invocation`);
    }
    const compiledInvocation = sourceInvocation.execution_mode === 'compiled'
      ? sourceInvocation
      : undefined;
    if (compiledInvocation) {
      const outputStep = compiledSteps.find((step) => (
        step.actor_type === 'skill'
        && step.actor_id === invocation.skillId
        && step.skill_invocation_id === compiledInvocation.invocation_id
      ));
      if (!outputStep) throw new Error(`Compiled Skill ${invocation.skillId} has no output stage`);
      result.set(invocation.skillId, {
        sourceStep,
        invocationId: invocation.invocationId,
        stepNos: [...compiledInvocation.step_nos],
        outputStepNo: outputStep.step_no,
        compiledInvocation,
      });
      continue;
    }
    const outputStep = compiledSteps.find((step) => (
      step.actor_type === 'skill'
      && step.actor_id === invocation.skillId
      && step.skill_invocation_id === sourceInvocation.invocation_id
    ));
    if (!outputStep) throw new Error(`Legacy Skill ${invocation.skillId} has no output step`);
    result.set(invocation.skillId, {
      sourceStep,
      invocationId: invocation.invocationId,
      stepNos: [outputStep.step_no],
      outputStepNo: outputStep.step_no,
    });
  }
  return result;
}

function remapInvocationIds(
  steps: CurrentPlanStepV3[],
  bindings: ReadonlyMap<string, SourceSkillBinding>,
): void {
  for (const binding of bindings.values()) {
    if (binding.compiledInvocation) {
      for (const step of steps) {
        if (step.skill_invocation_id === binding.compiledInvocation.invocation_id) {
          step.skill_invocation_id = binding.invocationId;
        }
      }
    } else {
      const output = steps[binding.outputStepNo - 1]!;
      output.skill_invocation_id = binding.invocationId;
      output.skill_stage_id = 'legacy-call';
    }
  }
}

function portfolioDependencies(
  portfolio: SkillPortfolioDecision,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const contributors = portfolio.invocations.filter(({ role }) => role === 'contributor');
  for (const invocation of portfolio.invocations) {
    if (invocation.role === 'synthesizer') {
      result.set(invocation.skillId, contributors.map(({ skillId }) => skillId));
      continue;
    }
    result.set(invocation.skillId, []);
  }
  return result;
}

function wireExternalDependencies(
  steps: CurrentPlanStepV3[],
  bindings: ReadonlyMap<string, SourceSkillBinding>,
  dependencySkills: ReadonlyMap<string, string[]>,
): void {
  for (const [skillId, dependencies] of dependencySkills) {
    const binding = bindings.get(skillId)!;
    const ownStepNos = new Set(binding.stepNos);
    const dependencyStepNos = dependencies.map((dependencySkillId) => {
      const dependency = bindings.get(dependencySkillId);
      if (!dependency) throw new Error(`Portfolio dependency ${dependencySkillId} is unknown`);
      return dependency.outputStepNo;
    });
    const rootSteps = binding.stepNos
      .map((stepNo) => steps[stepNo - 1]!)
      .filter((step) => (
        !step.shared_by_invocation_ids?.includes(binding.invocationId)
        && !step.depends_on.some((dependency) => ownStepNos.has(dependency))
      ));
    for (const step of rootSteps) {
      step.depends_on = uniqueSorted([...step.depends_on, ...dependencyStepNos]);
    }
    const output = steps[binding.outputStepNo - 1]!;
    output.depends_on = uniqueSorted([...output.depends_on, ...dependencyStepNos]);
  }
}

function wireRequiredToolDependencies(
  steps: CurrentPlanStepV3[],
  portfolio: SkillPortfolioDecision,
  bindings: ReadonlyMap<string, SourceSkillBinding>,
  skillLoader: SkillLoader,
): void {
  const sharedConsumers = new Set(portfolio.sharedPrerequisites.flatMap((prerequisite) => (
    prerequisite.capabilityType === 'tool'
      ? prerequisite.consumerSkillIds.map((skillId) => `${skillId}:${prerequisite.capabilityId}`)
      : []
  )));
  const claimedToolStepNos = new Set<number>();
  for (const invocation of portfolio.invocations) {
    const binding = bindings.get(invocation.skillId)!;
    const ownStepNos = new Set(binding.stepNos);
    const roots = binding.stepNos
      .map((stepNo) => steps[stepNo - 1]!)
      .filter((step) => !step.depends_on.some((dependency) => ownStepNos.has(dependency)));
    for (const toolId of skillLoader.getSkill(invocation.skillId)?.required_tools ?? []) {
      if (sharedConsumers.has(`${invocation.skillId}:${toolId}`)) continue;
      if (binding.stepNos.some((stepNo) => {
        const step = steps[stepNo - 1]!;
        return step.actor_type === 'tool' && step.actor_id === toolId;
      })) continue;
      const tool = [...steps].reverse().find((step) => (
        step.actor_type === 'tool'
        && step.actor_id === toolId
        && step.skill_invocation_id === undefined
        && step.step_no < binding.outputStepNo
        && !claimedToolStepNos.has(step.step_no)
      ));
      if (!tool) {
        throw new Error(
          `Required Tool ${toolId} for ${invocation.skillId} has no unclaimed compiled source step`,
        );
      }
      claimedToolStepNos.add(tool.step_no);
      for (const root of roots) {
        root.depends_on = uniqueSorted([...root.depends_on, tool.step_no]);
      }
    }
  }
}

function wireOptionalToolDependencies(
  steps: CurrentPlanStepV3[],
  portfolio: SkillPortfolioDecision,
  bindings: ReadonlyMap<string, SourceSkillBinding>,
  capabilityResolution?: CapabilityResolution,
): void {
  if (!capabilityResolution) return;
  for (const invocation of portfolio.invocations) {
    const decision = capabilityResolution.eligible.find(({ skill }) => skill.id === invocation.skillId);
    const output = steps[bindings.get(invocation.skillId)!.outputStepNo - 1]!;
    for (const optional of decision?.optional_tool_decisions ?? []) {
      if (optional.status !== 'available') continue;
      const matches = steps.filter((step) => (
        step.actor_type === 'tool'
        && step.actor_id === optional.tool_id
        && step.skill_invocation_id === undefined
      ));
      if (matches.length !== 1) {
        throw new Error(
          `Optional Tool ${optional.tool_id} for ${invocation.skillId} requires exactly one source step`,
        );
      }
      output.depends_on = uniqueSorted([...output.depends_on, matches[0]!.step_no]);
    }
  }
}

function topologicallyRenumberPortfolioSteps(
  steps: CurrentPlanStepV3[],
  bindings: ReadonlyMap<string, SourceSkillBinding>,
): void {
  const byStepNo = new Map(steps.map((step) => [step.step_no, step]));
  const dependents = new Map<number, number[]>();
  const indegree = new Map<number, number>();
  for (const step of steps) {
    indegree.set(step.step_no, step.depends_on.length);
    for (const dependency of step.depends_on) {
      const values = dependents.get(dependency) ?? [];
      values.push(step.step_no);
      dependents.set(dependency, values);
    }
  }
  const ready = [...steps]
    .filter((step) => (indegree.get(step.step_no) ?? 0) === 0)
    .map(({ step_no }) => step_no)
    .sort((left, right) => left - right);
  const orderedOldStepNos: number[] = [];
  while (ready.length > 0) {
    const stepNo = ready.shift()!;
    orderedOldStepNos.push(stepNo);
    for (const dependent of dependents.get(stepNo) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left - right);
      }
    }
  }
  if (orderedOldStepNos.length !== steps.length) return;
  const newStepNoByOld = new Map(orderedOldStepNos.map((stepNo, index) => [stepNo, index + 1]));
  const reordered = orderedOldStepNos.map((oldStepNo, index) => {
    const step = byStepNo.get(oldStepNo)!;
    return {
      ...step,
      step_no: index + 1,
      depends_on: uniqueSorted(step.depends_on.map((dependency) => newStepNoByOld.get(dependency)!)),
      input_bindings: step.input_bindings.map((binding) => ({
        ...binding,
        source_step_no: newStepNoByOld.get(binding.source_step_no)!,
      })),
    };
  });
  steps.splice(0, steps.length, ...reordered);
  for (const binding of bindings.values()) {
    binding.stepNos = binding.stepNos.map((stepNo) => newStepNoByOld.get(stepNo)!).sort((left, right) => left - right);
    binding.outputStepNo = newStepNoByOld.get(binding.outputStepNo)!;
  }
  for (const step of steps) {
    if (step.shared_stage_key) step.share_fingerprint = planShareFingerprint(step);
  }
}

function wireContributionBundle(
  steps: CurrentPlanStepV3[],
  portfolio: SkillPortfolioDecision,
  bindings: ReadonlyMap<string, SourceSkillBinding>,
): void {
  const synthesizer = portfolio.invocations.find(({ role }) => role === 'synthesizer');
  if (!synthesizer) throw new Error('Portfolio has no Synthesizer');
  const output = steps[bindings.get(synthesizer.skillId)!.outputStepNo - 1]!;
  const contributors = portfolio.invocations.filter(({ role }) => role === 'contributor');
  for (const contributor of contributors) {
    const sourceOutput = steps[bindings.get(contributor.skillId)!.outputStepNo - 1]!;
    sourceOutput.expected_outputs = [{
      pointer: '/contribution',
      description: `${contributor.skillId} Research Contribution`,
    }];
  }
  const contributionBundle = Object.fromEntries(
    contributors.map(({ invocationId }) => [invocationId, null]),
  );
  output.input = {
    ...output.input,
    contribution_order: contributors.map(({ invocationId }) => invocationId),
    contribution_bundle: contributionBundle,
  };
  const existingTargets = new Set(output.input_bindings.map(({ target_pointer }) => target_pointer));
  for (const contributor of contributors) {
    const source = bindings.get(contributor.skillId)!;
    const targetPointer = `/contribution_bundle/${escapePointerSegment(contributor.invocationId)}`;
    if (existingTargets.has(targetPointer)) continue;
    output.input_bindings.push({
      target_pointer: targetPointer,
      source_step_no: source.outputStepNo,
      source_pointer: '/contribution',
      include_artifact_identity: true,
      ...(contributor.failurePolicy === 'gap' ? { optional: true } : {}),
    });
    existingTargets.add(targetPointer);
  }
  output.depends_on = uniqueSorted([
    ...output.depends_on,
    ...contributors.map(({ skillId }) => bindings.get(skillId)!.outputStepNo),
  ]);
}

function markSharedPrerequisites(
  steps: CurrentPlanStepV3[],
  sourceSteps: readonly CurrentPlanStep[],
  portfolio: SkillPortfolioDecision,
  bindings: ReadonlyMap<string, SourceSkillBinding>,
): void {
  for (const prerequisite of portfolio.sharedPrerequisites) {
    const source = sourceSteps.find((step) => (
      step.actor_type === prerequisite.capabilityType
      && step.actor_id === prerequisite.capabilityId
    ));
    if (!source) {
      throw new Error(
        `Shared prerequisite ${prerequisite.capabilityType}:${prerequisite.capabilityId} has no source step`,
      );
    }
    const actorMatches = steps.filter((step) => (
      step.actor_type === source.actor_type && step.actor_id === source.actor_id
    ));
    if (actorMatches.length !== 1) {
      throw new Error(
        `Shared prerequisite ${prerequisite.capabilityType}:${prerequisite.capabilityId} has ${actorMatches.length} compiled source steps`,
      );
    }
    const compiled = actorMatches[0]!;
    if (stableJsonStringify(compiled.input) !== stableJsonStringify(source.input)) {
      throw new Error(
        `Shared prerequisite ${prerequisite.capabilityType}:${prerequisite.capabilityId} input drifted during compilation`,
      );
    }
    const consumerInvocationIds = prerequisite.consumerSkillIds.map((skillId) => {
      const binding = bindings.get(skillId);
      if (!binding) throw new Error(`Shared prerequisite consumer ${skillId} is unknown`);
      return binding.invocationId;
    });
    compiled.shared_stage_key = `shared:${prerequisite.capabilityType}:${prerequisite.capabilityId}`;
    compiled.shared_by_invocation_ids = consumerInvocationIds;
    compiled.share_fingerprint = planShareFingerprint(compiled);
    for (const skillId of prerequisite.consumerSkillIds) {
      const binding = bindings.get(skillId)!;
      const ownSteps = new Set(binding.stepNos);
      const roots = binding.stepNos
        .map((stepNo) => steps[stepNo - 1]!)
        .filter((step) => (
          step.step_no !== compiled.step_no
          && !step.depends_on.some((dependency) => ownSteps.has(dependency))
        ));
      for (const root of roots) {
        root.depends_on = uniqueSorted([...root.depends_on, compiled.step_no]);
      }
    }
  }
}

function invocationContracts(
  portfolio: SkillPortfolioDecision,
  bindings: ReadonlyMap<string, SourceSkillBinding>,
  steps: readonly CurrentPlanStepV3[],
  dependencySkills: ReadonlyMap<string, string[]>,
): CurrentSkillInvocationV3[] {
  return portfolio.invocations.map((decision): CurrentSkillInvocationV3 => {
    const binding = bindings.get(decision.skillId)!;
    const common: CurrentSkillInvocationV3Base = {
      invocation_id: decision.invocationId,
      skill_id: decision.skillId,
      role: decision.role,
      demand_ids: [...decision.demandIds],
      contribution_types: [...decision.contributionTypes],
      question_ids: [...decision.questionIds],
      requested_artifact_types: [...decision.requestedArtifactTypes],
      depends_on_invocation_ids: (dependencySkills.get(decision.skillId) ?? [])
        .map((skillId) => bindings.get(skillId)!.invocationId),
      output_contract: decision.role === 'contributor'
        ? 'research-contribution-v1'
        : 'reviewed-synthesis-draft-v1',
      required: decision.required,
      failure_policy: decision.failurePolicy,
      step_nos: steps
        .filter((step) => (
          step.skill_invocation_id === decision.invocationId
          || step.shared_by_invocation_ids?.includes(decision.invocationId)
        ))
        .map(({ step_no }) => step_no),
    };
    if (!binding.compiledInvocation) {
      return {
        ...common,
        execution_mode: 'legacy_single_call',
      } satisfies CurrentLegacySkillInvocationV3;
    }
    return {
      ...common,
      execution_mode: 'compiled',
      contract_version: binding.compiledInvocation.contract_version,
      contract_hash: binding.compiledInvocation.contract_hash,
      degraded_policy: binding.compiledInvocation.degraded_policy,
      skill_reference_hashes: structuredClone(binding.compiledInvocation.skill_reference_hashes),
      knowledge_references: structuredClone(binding.compiledInvocation.knowledge_references),
      resource_gaps: structuredClone(binding.compiledInvocation.resource_gaps),
    } satisfies CurrentCompiledSkillInvocationV3;
  });
}

function contributionRequirements(
  portfolio: SkillPortfolioDecision,
  bindings: ReadonlyMap<string, SourceSkillBinding>,
): PlanContributionRequirement[] {
  const contributorSkillIds = new Set(portfolio.invocations
    .filter(({ role }) => role === 'contributor')
    .map(({ skillId }) => skillId));
  return portfolio.demandCoverage.flatMap((coverage): PlanContributionRequirement[] => {
    const owner = bindings.get(coverage.ownerSkillId);
    if (!owner) throw new Error(`Contribution owner ${coverage.ownerSkillId} is unknown`);
    if (!contributorSkillIds.has(coverage.ownerSkillId)) return [];
    return [{
      id: coverage.demandId,
      demand_type: coverage.demandType,
      question_ids: [...coverage.questionIds],
      requested_artifact_types: [...coverage.requestedArtifactTypes],
      owner_invocation_id: owner.invocationId,
      corroborator_invocation_ids: coverage.corroboratorSkillIds.map((skillId) => {
        const corroborator = bindings.get(skillId);
        if (!corroborator) throw new Error(`Corroborator ${skillId} is unknown`);
        return corroborator.invocationId;
      }),
      required: coverage.required,
    }];
  });
}

function portfolioDrift(message: string): never {
  throw new CompiledSkillPlanDriftError(message);
}

export function assertCompiledPortfolioPlan(
  plan: CurrentExecutionPlanV3,
  skillLoader = new SkillLoader(),
): void {
  const stepsByNo = new Map(plan.steps.map((step) => [step.step_no, step]));
  const selectedBudgetByInvocation = new Map(
    plan.portfolio_summary.selected.map((item) => [item.invocation_id, item.estimated_steps]),
  );
  const expectedExpandedStepLimit = plan.portfolio_summary.estimated_budget.max_steps
    + plan.skill_invocations.reduce((total, invocation) => (
      invocation.execution_mode === 'compiled'
        ? total + Math.max(
            0,
            invocation.step_nos.length - (selectedBudgetByInvocation.get(invocation.invocation_id) ?? 1),
          )
        : total
    ), 0);
  if (plan.portfolio_summary.estimated_budget.expanded_step_limit !== expectedExpandedStepLimit) {
    portfolioDrift('Portfolio expanded step limit drift');
  }
  for (const invocation of plan.skill_invocations) {
    const ownedSteps = invocation.step_nos.map((stepNo) => {
      const step = stepsByNo.get(stepNo);
      if (!step) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} references unknown step ${stepNo}`);
      if (
        step.skill_invocation_id !== invocation.invocation_id
        && !step.shared_by_invocation_ids?.includes(invocation.invocation_id)
      ) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} does not own step ${stepNo}`);
      return step;
    });
    if (invocation.execution_mode === 'legacy_single_call') {
      if (skillLoader.loadSkillExecution(invocation.skill_id) !== null) {
        portfolioDrift(`Legacy Portfolio invocation ${invocation.invocation_id} execution mode drift`);
      }
      const outputs = ownedSteps.filter((step) => (
        step.actor_type === 'skill'
        && step.actor_id === invocation.skill_id
        && step.skill_invocation_id === invocation.invocation_id
      ));
      if (outputs.length !== 1) {
        portfolioDrift(`Legacy Portfolio invocation ${invocation.invocation_id} must have one Skill output step`);
      }
      continue;
    }

    const loaded = skillLoader.loadSkillExecution(invocation.skill_id);
    if (!loaded || loaded.hash !== invocation.contract_hash) {
      portfolioDrift(`Portfolio invocation ${invocation.invocation_id} contract hash drift`);
    }
    if (loaded.contract.degraded_policy !== invocation.degraded_policy) {
      portfolioDrift(`Portfolio invocation ${invocation.invocation_id} degraded policy drift`);
    }
    const currentReferenceHashes = loadSkillReferenceDocuments({
      skillId: invocation.skill_id,
      skillLoader,
      execution: loaded,
    }).map(({ path, hash }) => ({ path, hash }));
    if (!isDeepStrictEqual(currentReferenceHashes, invocation.skill_reference_hashes)) {
      portfolioDrift(`Portfolio invocation ${invocation.invocation_id} reference hash drift`);
    }
    assertFrozenKnowledgeQueryMembership(loaded.contract, invocation);

    const stageById = new Map(ownedSteps.flatMap((step) => (
      step.skill_stage_id ? [[step.skill_stage_id, step] as const] : []
    )));
    if (stageById.size !== loaded.contract.stages.length) {
      portfolioDrift(`Portfolio invocation ${invocation.invocation_id} stage set drift`);
    }
    for (const contractStage of loaded.contract.stages) {
      const step = stageById.get(contractStage.stage_id);
      if (!step || step.actor_type !== contractStage.actor_type || step.actor_id !== contractStage.actor_id) {
        portfolioDrift(`Portfolio invocation ${invocation.invocation_id} actor drift at ${contractStage.stage_id}`);
      }
      if (
        step.shared_by_invocation_ids?.includes(invocation.invocation_id)
        && contractStage.share_scope !== 'plan'
      ) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} shared stage is not contract-authorized at ${contractStage.stage_id}`);
      if (
        !(
          invocation.role === 'contributor'
          && contractStage.stage_id === loaded.contract.output_stage_id
        )
        && !isDeepStrictEqual(step.expected_outputs, contractStage.expected_outputs)
      ) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} output contract drift at ${contractStage.stage_id}`);
      if (
        !isDeepStrictEqual(step.acceptance_criteria, contractStage.acceptance_criteria)
      ) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} output contract drift at ${contractStage.stage_id}`);
      for (const [key, value] of Object.entries(contractStage.input)) {
        const portfolioInjected = invocation.role === 'synthesizer'
          && contractStage.stage_id === loaded.contract.output_stage_id
          && (key === 'contribution_bundle' || key === 'contribution_order');
        const sharedInputOverride = step.shared_by_invocation_ids?.includes(invocation.invocation_id)
          && contractStage.share_scope === 'plan'
          && contractStage.share_input_fields?.includes(key);
        const frozenInputOverride = contractStage.actor_type === 'tool'
          && contractStage.frozen_input_fields?.includes(key) === true;
        if (!portfolioInjected && !sharedInputOverride && !frozenInputOverride && !isDeepStrictEqual(step.input[key], value)) {
          portfolioDrift(`Portfolio invocation ${invocation.invocation_id} input drift at ${contractStage.stage_id}/${key}`);
        }
      }
      const expectedInternalDependencies = contractStage.depends_on.map((stageId) => {
        const dependency = stageById.get(stageId);
        if (!dependency) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} dependency stage ${stageId} is missing`);
        return dependency.step_no;
      });
      if (!expectedInternalDependencies.every((stepNo) => step.depends_on.includes(stepNo))) {
        portfolioDrift(`Portfolio invocation ${invocation.invocation_id} dependency drift at ${contractStage.stage_id}`);
      }
      for (const binding of contractStage.input_bindings) {
        const source = stageById.get(binding.source_stage_id);
        if (!source || !step.input_bindings.some((candidate) => (
          candidate.target_pointer === binding.target_pointer
          && candidate.source_step_no === source.step_no
          && candidate.source_pointer === binding.source_pointer
        ))) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} binding drift at ${contractStage.stage_id}`);
      }
      if (step.actor_type === 'knowledge' && (
        step.input.contractHash !== invocation.contract_hash
        || !isDeepStrictEqual(step.input.references, invocation.knowledge_references)
      )) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} Knowledge drift at ${contractStage.stage_id}`);
    }
    const output = stageById.get(loaded.contract.output_stage_id);
    if (
      !output
      || output.actor_type !== 'skill'
      || output.actor_id !== invocation.skill_id
      || !output.expected_outputs.some(({ pointer }) => (
        pointer === (invocation.role === 'contributor' ? '/contribution' : loaded.contract.output_pointer)
      ))
    ) portfolioDrift(`Portfolio invocation ${invocation.invocation_id} output stage drift`);
  }
}

export function compilePortfolioSkillSteps(
  input: PortfolioSkillCompilationInput,
): PortfolioSkillCompilationResult {
  const actorIssues = portfolioActorValidationIssues(input.steps, input.portfolio);
  if (actorIssues.length > 0) {
    throw new Error(`Portfolio actor validation failed: ${actorIssues.join('; ')}`);
  }
  const skillLoader = input.skillLoader ?? new SkillLoader();
  for (const prerequisite of input.portfolio.sharedPrerequisites) {
    if (prerequisite.capabilityType !== 'tool') continue;
    for (const skillId of prerequisite.consumerSkillIds) {
      const skill = skillLoader.getSkill(skillId);
      if (
        !skill
        || !resolveSkillComposition(skill).shareable_prerequisites?.includes(prerequisite.capabilityId)
      ) {
        throw new Error(
          `Shared prerequisite ${prerequisite.capabilityId} is not authorized by ${skillId}`,
        );
      }
    }
  }
  const allowedPrerequisites = new Set<string>();
  const discardablePrerequisites = new Set<string>();
  for (const invocation of input.portfolio.invocations) {
    const skill = skillLoader.getSkill(invocation.skillId);
    for (const toolId of skill?.required_tools ?? []) allowedPrerequisites.add(`tool:${toolId}`);
    for (const toolId of skill?.optional_tools ?? []) discardablePrerequisites.add(`tool:${toolId}`);
    const decision = input.capabilityResolution?.eligible.find(({ skill: candidate }) => (
      candidate.id === invocation.skillId
    ));
    for (const optional of decision?.optional_tool_decisions ?? []) {
      if (optional.status === 'available') {
        allowedPrerequisites.add(`tool:${optional.tool_id}`);
        discardablePrerequisites.delete(`tool:${optional.tool_id}`);
      }
    }
  }
  for (const prerequisite of input.portfolio.sharedPrerequisites) {
    allowedPrerequisites.add(`${prerequisite.capabilityType}:${prerequisite.capabilityId}`);
  }
  const normalizedSourceSteps = canonicalizeSharedSourceInputs(
    normalizePortfolioOwnedWiring(input.steps, allowedPrerequisites, discardablePrerequisites),
    input.portfolio,
    skillLoader,
  );
  const sourceSteps = deduplicateSharedSourceSteps(normalizedSourceSteps, input.portfolio);
  const intraSkill = compileSkillSteps(sourceSteps, input.task, skillLoader, {
    canReuseStage: ({ stage, existingStep, skillStep }) => {
      if (stage.actor_type !== 'tool' && stage.actor_type !== 'knowledge') return true;
      if (stage.share_scope !== 'plan') return false;
      const shared = input.portfolio.sharedPrerequisites.some((prerequisite) => (
        prerequisite.capabilityType === stage.actor_type
        && prerequisite.capabilityId === existingStep.actor_id
        && prerequisite.consumerSkillIds.includes(skillStep.actor_id)
      ));
      if (shared) return true;
      if (stage.actor_type !== 'tool') return false;
      const consumers = input.portfolio.invocations.filter((invocation) => (
        skillLoader.getSkill(invocation.skillId)?.required_tools?.includes(existingStep.actor_id) === true
      ));
      return consumers.length === 1 && consumers[0]?.skillId === skillStep.actor_id;
    },
  });
  const steps = intraSkill.steps.map((step): CurrentPlanStepV3 => structuredClone(step));
  const bindings = sourceBindings(sourceSteps, steps, intraSkill.invocations, input.portfolio);
  remapInvocationIds(steps, bindings);
  const dependencies = portfolioDependencies(input.portfolio);
  markSharedPrerequisites(steps, sourceSteps, input.portfolio, bindings);
  wireRequiredToolDependencies(steps, input.portfolio, bindings, skillLoader);
  wireOptionalToolDependencies(steps, input.portfolio, bindings, input.capabilityResolution);
  wireExternalDependencies(steps, bindings, dependencies);
  wireContributionBundle(steps, input.portfolio, bindings);
  topologicallyRenumberPortfolioSteps(steps, bindings);
  return {
    steps,
    invocations: invocationContracts(input.portfolio, bindings, steps, dependencies),
    contributionRequirements: contributionRequirements(input.portfolio, bindings),
  };
}
