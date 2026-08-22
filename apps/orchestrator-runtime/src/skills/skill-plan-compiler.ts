import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentExecutionPlan,
  CurrentKnowledgeReference,
  CurrentPlanInputBinding,
  CurrentPlanStep,
  CurrentSkillInvocation,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import { loadRuntimeKnowledgeIndex } from '../knowledge/index.ts';
import { SkillLoader } from '../runtime/skill-loader.ts';
import type { SkillExecutionContract, SkillExecutionStage } from './skill-execution-contract.ts';
import { loadSkillReferenceDocuments } from './skill-runtime.ts';

export interface CompiledSkillSteps {
  steps: CurrentPlanStep[];
  invocations: CurrentSkillInvocation[];
}

interface Expansion {
  oldSkillStepNo: number;
  invocationId: string;
  contract: SkillExecutionContract;
  contractHash: string;
  stageKey: Map<string, string>;
  reusedOldStepByStage: Map<string, number>;
  references: CurrentKnowledgeReference[];
  skillReferenceHashes: Array<{ path: string; hash: string }>;
  resourceGaps: CurrentSkillInvocation['resource_gaps'];
}

interface DraftStep {
  key: string;
  sourceOldStepNo?: number;
  stage?: SkillExecutionStage;
  expansion?: Expansion;
  step: CurrentPlanStep;
  dependencyKeys: string[];
  bindingSources: Array<{ binding: CurrentPlanInputBinding; sourceKey: string }>;
}

function requiredPointerPresent(task: ResearchTaskV2, pointer: string): boolean {
  const field = pointer.slice(1) as keyof ResearchTaskV2;
  const value = task[field];
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function taskTerms(task: ResearchTaskV2): string[] {
  return [...new Set([
    task.business_domain,
    task.research_goal,
    ...task.scope,
    ...task.target_audience,
  ].flatMap((value) => value.toLowerCase().split(/[\s，。、“”‘’：:；;（）()\/×+-]+/u))
    .map((value) => value.trim())
    .filter((value) => value.length >= 2))];
}

export function selectFrozenKnowledgeReferences(contract: SkillExecutionContract, task: ResearchTaskV2): {
  references: CurrentKnowledgeReference[];
  resourceGaps: CurrentSkillInvocation['resource_gaps'];
} {
  const runtimeIndex = loadRuntimeKnowledgeIndex();
  const index = new Map(runtimeIndex.map((item) => [item.id, item]));
  const references: CurrentKnowledgeReference[] = contract.resources.map((resource) => {
    const item = index.get(resource.resource_id);
    if (!item || (item.status !== 'approved' && item.status !== 'draft')) {
      throw new Error(`Skill ${contract.skill_id} knowledge ${resource.resource_id} is unavailable`);
    }
    if (!resource.accepted_statuses.includes(item.status)) {
      throw new Error(`Skill ${contract.skill_id} knowledge ${resource.resource_id} status is not accepted`);
    }
    return {
      resourceId: item.id,
      resourceType: item.type,
      sourcePath: item.source_path,
      status: item.status,
      contentHash: item.content_hash,
      required: resource.required,
      failurePolicy: resource.failure_policy,
    };
  });
  const seen = new Set(references.map(({ resourceId }) => resourceId));
  const resourceGaps: CurrentSkillInvocation['resource_gaps'] = [];
  const terms = taskTerms(task);
  for (const query of contract.resource_queries ?? []) {
    const ranked = runtimeIndex
      .filter((item) => query.types.includes(item.type))
      .filter((item) => query.accepted_statuses.includes(item.status as 'approved' | 'draft'))
      .filter((item) => !seen.has(item.id))
      .map((item) => {
        const haystack = [item.title, item.summary, ...item.tags, ...item.domain, ...item.guide_tags]
          .join(' ')
          .toLowerCase();
        return { item, score: terms.filter((term) => haystack.includes(term)).length };
      })
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id));
    const matches = ranked.filter(({ score }) => score > 0).slice(0, query.max_items);
    for (const candidate of ranked) {
      if (matches.length >= query.min_items || matches.length >= query.max_items) break;
      if (!matches.some(({ item }) => item.id === candidate.item.id)) matches.push(candidate);
    }
    if (matches.length < query.min_items) {
      const reason = `query ${query.query_id} selected ${matches.length}, below min_items ${query.min_items}`;
      if (query.failure_policy === 'block') throw new Error(`Skill ${contract.skill_id} ${reason}`);
      resourceGaps.push({
        query_id: query.query_id,
        min_items: query.min_items,
        selected_items: matches.length,
        failure_policy: 'gap',
        reason,
      });
    }
    for (const { item } of matches) {
      seen.add(item.id);
      references.push({
        resourceId: item.id,
        resourceType: item.type,
        sourcePath: item.source_path,
        status: item.status as 'approved' | 'draft',
        contentHash: item.content_hash,
        required: false,
        failurePolicy: query.failure_policy,
        queryId: query.query_id,
      });
    }
  }
  return { references, resourceGaps };
}

function compiledStageInput(
  stage: SkillExecutionStage,
  originalInput: Record<string, unknown>,
  expansion: Expansion,
): Record<string, unknown> {
  const dynamicToolInput = stage.actor_type === 'tool'
    ? Object.fromEntries((stage.frozen_input_fields ?? []).flatMap((field) => (
        Object.hasOwn(originalInput, field) ? [[field, structuredClone(originalInput[field])]] : []
      )))
    : {};
  return {
    ...structuredClone(stage.input),
    ...dynamicToolInput,
    ...(stage.actor_type === 'knowledge'
      ? { references: structuredClone(expansion.references), contractHash: expansion.contractHash }
      : {}),
  };
}

function stageStep(
  stage: SkillExecutionStage,
  original: CurrentPlanStep,
  expansion: Expansion,
): CurrentPlanStep {
  const input = compiledStageInput(stage, original.input, expansion);
  return {
    step_no: 0,
    step_name: stage.title,
    actor_type: stage.actor_type,
    actor_id: stage.actor_id,
    question_ids: [...original.question_ids],
    depends_on: [],
    input,
    input_bindings: [],
    expected_outputs: structuredClone(stage.expected_outputs),
    acceptance_criteria: structuredClone(stage.acceptance_criteria),
    requires_approval: original.requires_approval && stage.stage_id === expansion.contract.output_stage_id,
    ...(original.approval_role && stage.stage_id === expansion.contract.output_stage_id
      ? { approval_role: original.approval_role }
      : {}),
    fallback_actor_ids: [],
    skill_invocation_id: expansion.invocationId,
    skill_stage_id: stage.stage_id,
  };
}

function matchingReusableStages(
  steps: readonly CurrentPlanStep[],
  skillStep: CurrentPlanStep,
  contract: SkillExecutionContract,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const stage of contract.stages) {
    if (stage.stage_id === contract.output_stage_id || stage.actor_type === 'knowledge') continue;
    const match = stage.actor_type === 'tool'
      ? [...steps].reverse().find((step) => (
          step.step_no < skillStep.step_no
          && step.actor_type === 'tool'
          && step.actor_id === stage.actor_id
        ))
      : stage.actor_type === 'reviewer'
        ? steps.find((step) => (
            step.step_no > skillStep.step_no
            && step.actor_type === 'reviewer'
            && step.depends_on.includes(skillStep.step_no)
          ))
        : undefined;
    if (match) result.set(stage.stage_id, match.step_no);
  }
  return result;
}

export class CompiledSkillPlanDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompiledSkillPlanDriftError';
  }
}

function planDrift(message: string): never {
  throw new CompiledSkillPlanDriftError(message);
}

export function assertFrozenKnowledgeQueryMembership(
  contract: SkillExecutionContract,
  invocation: Pick<CurrentSkillInvocation, 'invocation_id' | 'knowledge_references' | 'resource_gaps'>,
): void {
  const knowledgeIndex = new Map(loadRuntimeKnowledgeIndex().map((item) => [item.id, item]));
  const staticResourceIds = new Set(contract.resources.map(({ resource_id }) => resource_id));
  if (new Set(invocation.knowledge_references.map(({ resourceId }) => resourceId)).size !== invocation.knowledge_references.length) {
    planDrift(`Skill invocation ${invocation.invocation_id} has duplicate Knowledge resources`);
  }
  for (const resource of contract.resources) {
    const reference = invocation.knowledge_references.find(({ resourceId }) => resourceId === resource.resource_id);
    if (
      !reference
      || reference.queryId !== undefined
      || reference.required !== resource.required
      || reference.failurePolicy !== resource.failure_policy
      || !resource.accepted_statuses.includes(reference.status)
    ) planDrift(`Skill invocation ${invocation.invocation_id} Knowledge resource drift at ${resource.resource_id}`);
  }
  for (const reference of invocation.knowledge_references) {
    if (staticResourceIds.has(reference.resourceId)) continue;
    const query = reference.queryId
      ? (contract.resource_queries ?? []).find(({ query_id }) => query_id === reference.queryId)
      : undefined;
    const item = knowledgeIndex.get(reference.resourceId);
    if (
      !query
      || reference.required
      || reference.failurePolicy !== query.failure_policy
      || !query.accepted_statuses.includes(reference.status)
      || !query.types.includes(reference.resourceType)
      || (item !== undefined && (
        item.type !== reference.resourceType
        || !query.accepted_statuses.includes(item.status as 'approved' | 'draft')
      ))
    ) {
      planDrift(`Skill invocation ${invocation.invocation_id} has invalid query membership for Knowledge ${reference.resourceId}`);
    }
  }
  for (const query of contract.resource_queries ?? []) {
    const selectedCount = invocation.knowledge_references.filter(({ queryId }) => queryId === query.query_id).length;
    if (selectedCount > query.max_items) {
      planDrift(`Skill invocation ${invocation.invocation_id} exceeds ${query.query_id} max_items`);
    }
    const gap = invocation.resource_gaps.find(({ query_id }) => query_id === query.query_id);
    if (selectedCount < query.min_items) {
      if (query.failure_policy === 'block' || !gap || gap.selected_items !== selectedCount) {
        planDrift(`Skill invocation ${invocation.invocation_id} violates ${query.query_id} min_items`);
      }
    } else if (gap) {
      planDrift(`Skill invocation ${invocation.invocation_id} has stale resource gap ${query.query_id}`);
    }
  }
  for (const gap of invocation.resource_gaps) {
    const query = (contract.resource_queries ?? []).find(({ query_id }) => query_id === gap.query_id);
    if (
      !query
      || query.failure_policy !== 'gap'
      || query.min_items !== gap.min_items
      || gap.selected_items >= gap.min_items
    ) planDrift(`Skill invocation ${invocation.invocation_id} has invalid resource gap ${gap.query_id}`);
  }
}

export function assertCompiledSkillPlan(
  plan: CurrentExecutionPlan,
  skillLoader = new SkillLoader(),
): void {
  if (plan.execution_contract_version !== 'current-execution-plan-v2') {
    if (plan.skill_invocations || plan.steps.some((step) => step.skill_invocation_id || step.skill_stage_id)) {
      planDrift('legacy plan must not contain compiled Skill metadata');
    }
    return;
  }
  if (!Array.isArray(plan.skill_invocations) || plan.skill_invocations.length === 0) {
    planDrift('CurrentExecutionPlan v2 requires Skill invocations');
  }
  const stepsByInvocation = new Map<string, CurrentPlanStep[]>();
  for (const step of plan.steps) {
    if (!step.skill_invocation_id && !step.skill_stage_id) continue;
    if (!step.skill_invocation_id || !step.skill_stage_id) planDrift(`step ${step.step_no} has partial Skill metadata`);
    const list = stepsByInvocation.get(step.skill_invocation_id) ?? [];
    list.push(step);
    stepsByInvocation.set(step.skill_invocation_id, list);
  }
  if (!plan.capability_decisions || !Array.isArray(plan.capability_decisions.eligible)) {
    planDrift('CurrentExecutionPlan v2 requires frozen capability decisions');
  }
  const decisions = new Map(
    plan.capability_decisions.eligible
      .filter((decision) => typeof decision.skill.id === 'string')
      .map((decision) => [decision.skill.id!, decision]),
  );
  const seenStepNos = new Set<number>();
  for (const invocation of plan.skill_invocations) {
    const loaded = skillLoader.loadSkillExecution(invocation.skill_id);
    if (!loaded || loaded.hash !== invocation.contract_hash) {
      planDrift(`Skill invocation ${invocation.invocation_id} contract hash drift`);
    }
    if (loaded.contract.degraded_policy !== invocation.degraded_policy) {
      planDrift(`Skill invocation ${invocation.invocation_id} degraded policy drift`);
    }
    const currentReferenceHashes = loadSkillReferenceDocuments({
      skillId: invocation.skill_id,
      skillLoader,
      execution: loaded,
    }).map(({ path, hash }) => ({ path, hash }));
    if (!isDeepStrictEqual(currentReferenceHashes, invocation.skill_reference_hashes)) {
      planDrift(`Skill invocation ${invocation.invocation_id} reference hash drift`);
    }
    assertFrozenKnowledgeQueryMembership(loaded.contract, invocation);
    const invocationSteps = (stepsByInvocation.get(invocation.invocation_id) ?? [])
      .sort((left, right) => left.step_no - right.step_no);
    if (!isDeepStrictEqual(invocationSteps.map(({ step_no }) => step_no), invocation.step_nos)) {
      planDrift(`Skill invocation ${invocation.invocation_id} step set drift`);
    }
    const stageById = new Map(invocationSteps.map((step) => [step.skill_stage_id!, step]));
    if (stageById.size !== loaded.contract.stages.length) {
      planDrift(`Skill invocation ${invocation.invocation_id} stage set drift`);
    }
    const owner = decisions.get(invocation.skill_id);
    if (!owner) planDrift(`Skill invocation ${invocation.invocation_id} has no eligible owner decision`);
    const allowedTools = new Set([
      ...owner.skill.required_tools,
      ...(owner.optional_tool_decisions ?? [])
        .filter(({ status }) => status === 'available')
        .map(({ tool_id }) => tool_id),
    ]);
    for (const contractStage of loaded.contract.stages) {
      const step = stageById.get(contractStage.stage_id);
      if (!step || step.actor_type !== contractStage.actor_type || step.actor_id !== contractStage.actor_id) {
        planDrift(`Skill invocation ${invocation.invocation_id} stage actor drift at ${contractStage.stage_id}`);
      }
      const expectedDependencies = contractStage.depends_on
        .map((stageId) => stageById.get(stageId)?.step_no)
        .filter((stepNo): stepNo is number => stepNo !== undefined)
        .sort((left, right) => left - right);
      if (!isDeepStrictEqual([...step.depends_on].sort((left, right) => left - right), expectedDependencies)) {
        planDrift(`Skill invocation ${invocation.invocation_id} dependency drift at ${contractStage.stage_id}`);
      }
      const expectedBindings = contractStage.input_bindings.map((binding) => ({
        target_pointer: binding.target_pointer,
        source_step_no: stageById.get(binding.source_stage_id)?.step_no,
        source_pointer: binding.source_pointer,
      }));
      if (
        expectedBindings.some(({ source_step_no }) => source_step_no === undefined)
        || !isDeepStrictEqual(step.input_bindings, expectedBindings)
      ) planDrift(`Skill invocation ${invocation.invocation_id} input binding drift at ${contractStage.stage_id}`);
      const expectedInput = compiledStageInput(contractStage, step.input, {
        oldSkillStepNo: 0,
        invocationId: invocation.invocation_id,
        contract: loaded.contract,
        contractHash: invocation.contract_hash,
        stageKey: new Map(),
        reusedOldStepByStage: new Map(),
        references: invocation.knowledge_references,
        skillReferenceHashes: invocation.skill_reference_hashes,
        resourceGaps: invocation.resource_gaps,
      });
      if (!isDeepStrictEqual(step.input, expectedInput)) {
        planDrift(`Skill invocation ${invocation.invocation_id} input drift at ${contractStage.stage_id}`);
      }
      if (!isDeepStrictEqual(step.acceptance_criteria, contractStage.acceptance_criteria)) {
        planDrift(`Skill invocation ${invocation.invocation_id} acceptance drift at ${contractStage.stage_id}`);
      }
      if (!isDeepStrictEqual(step.expected_outputs, contractStage.expected_outputs)) {
        planDrift(`Skill invocation ${invocation.invocation_id} output drift at ${contractStage.stage_id}`);
      }
      if (step.actor_type === 'knowledge') {
        if (
          step.input.contractHash !== invocation.contract_hash
          || !isDeepStrictEqual(step.input.references, invocation.knowledge_references)
        ) planDrift(`Skill invocation ${invocation.invocation_id} Knowledge binding drift at ${contractStage.stage_id}`);
      }
      if (step.actor_type === 'tool' && !allowedTools.has(step.actor_id)) {
        planDrift(`Skill invocation ${invocation.invocation_id} Tool ${step.actor_id} is not owned by the Skill`);
      }
      if (seenStepNos.has(step.step_no)) planDrift(`compiled Skill step ${step.step_no} is assigned twice`);
      seenStepNos.add(step.step_no);
    }
    const outputStage = stageById.get(loaded.contract.output_stage_id);
    if (outputStage?.actor_type !== 'skill' || outputStage.actor_id !== invocation.skill_id) {
      planDrift(`Skill invocation ${invocation.invocation_id} output stage drift`);
    }
  }
  for (const [invocationId] of stepsByInvocation) {
    if (!plan.skill_invocations.some(({ invocation_id }) => invocation_id === invocationId)) {
      planDrift(`step references unknown Skill invocation ${invocationId}`);
    }
  }
}

export function compileSkillSteps(
  steps: readonly CurrentPlanStep[],
  task: ResearchTaskV2,
  skillLoader = new SkillLoader(),
): CompiledSkillSteps {
  const expansions = new Map<number, Expansion>();
  for (const step of steps) {
    if (step.actor_type !== 'skill') continue;
    if (!skillLoader.getSkill(step.actor_id)) continue;
    const loaded = skillLoader.loadSkillExecution(step.actor_id);
    if (!loaded) continue;
    for (const pointer of loaded.contract.required_requirement_fields) {
      if (!requiredPointerPresent(task, pointer)) {
        throw new Error(`Skill ${step.actor_id} requires finalized Requirement field ${pointer}`);
      }
    }
    if (task.clarification_questions.length > 0 || task.ambiguities.some(({ blocking }) => blocking)) {
      throw new Error(`Skill ${step.actor_id} requires a finalized Requirement without clarification questions`);
    }
    const invocationId = `${step.actor_id}:${step.step_no}`;
    const reusedOldStepByStage = matchingReusableStages(steps, step, loaded.contract);
    const stageKey = new Map<string, string>();
    for (const stage of loaded.contract.stages) {
      const reused = reusedOldStepByStage.get(stage.stage_id);
      stageKey.set(stage.stage_id, reused === undefined
        ? `skill:${step.step_no}:${stage.stage_id}`
        : `old:${reused}`);
    }
    const frozen = selectFrozenKnowledgeReferences(loaded.contract, task);
    expansions.set(step.step_no, {
      oldSkillStepNo: step.step_no,
      invocationId,
      contract: loaded.contract,
      contractHash: loaded.hash,
      stageKey,
      reusedOldStepByStage,
      references: frozen.references,
      resourceGaps: frozen.resourceGaps,
      skillReferenceHashes: loadSkillReferenceDocuments({
        skillId: step.actor_id,
        skillLoader,
      }).map(({ path, hash }) => ({ path, hash })),
    });
  }
  if (expansions.size === 0) return { steps: steps.map((step) => structuredClone(step)), invocations: [] };

  const reusedMetadata = new Map<number, { expansion: Expansion; stage: SkillExecutionStage }>();
  for (const expansion of expansions.values()) {
    for (const [stageId, oldStepNo] of expansion.reusedOldStepByStage) {
      const stage = expansion.contract.stages.find((candidate) => candidate.stage_id === stageId)!;
      reusedMetadata.set(oldStepNo, { expansion, stage });
    }
  }

  const drafts: DraftStep[] = [];
  for (const original of steps) {
    const expansion = expansions.get(original.step_no);
    if (expansion) {
      for (const stage of expansion.contract.stages) {
        if (expansion.reusedOldStepByStage.has(stage.stage_id)) continue;
        const step = stageStep(stage, original, expansion);
        const dependencyKeys = stage.depends_on.map((id) => expansion.stageKey.get(id)!);
        const bindingSources = stage.input_bindings.map((binding) => ({
          binding: {
            target_pointer: binding.target_pointer,
            source_step_no: 0,
            source_pointer: binding.source_pointer,
          },
          sourceKey: expansion.stageKey.get(binding.source_stage_id)!,
        }));
        drafts.push({
          key: expansion.stageKey.get(stage.stage_id)!,
          stage,
          expansion,
          step,
          dependencyKeys: [...new Set(dependencyKeys)],
          bindingSources,
        });
      }
      continue;
    }

    const reused = reusedMetadata.get(original.step_no);
    const oldDependencyKeys = original.depends_on.map((stepNo) => {
      const dependencyExpansion = expansions.get(stepNo);
      return dependencyExpansion
        ? dependencyExpansion.stageKey.get(dependencyExpansion.contract.output_stage_id)!
        : `old:${stepNo}`;
    });
    const step = structuredClone(original);
    let dependencyKeys = oldDependencyKeys;
    let bindingSources = original.input_bindings.map((binding) => ({
      binding: { ...binding, source_step_no: 0 },
      sourceKey: expansions.get(binding.source_step_no)
        ? expansions.get(binding.source_step_no)!.stageKey.get(expansions.get(binding.source_step_no)!.contract.output_stage_id)!
        : `old:${binding.source_step_no}`,
    }));
    if (reused) {
      step.skill_invocation_id = reused.expansion.invocationId;
      step.skill_stage_id = reused.stage.stage_id;
      step.step_name = reused.stage.title;
      step.expected_outputs = structuredClone(reused.stage.expected_outputs);
      step.acceptance_criteria = structuredClone(reused.stage.acceptance_criteria);
      step.input = compiledStageInput(reused.stage, original.input, reused.expansion);
      dependencyKeys = reused.stage.depends_on.map((stageId) => reused.expansion.stageKey.get(stageId)!);
      bindingSources = reused.stage.input_bindings.map((binding) => ({
        binding: {
          target_pointer: binding.target_pointer,
          source_step_no: 0,
          source_pointer: binding.source_pointer,
        },
        sourceKey: reused.expansion.stageKey.get(binding.source_stage_id)!,
      }));
    }
    drafts.push({
      key: `old:${original.step_no}`,
      sourceOldStepNo: original.step_no,
      ...(reused ? { stage: reused.stage, expansion: reused.expansion } : {}),
      step,
      dependencyKeys,
      bindingSources,
    });
  }

  const stepNoByKey = new Map(drafts.map((draft, index) => [draft.key, index + 1]));
  const compiled = drafts.map((draft, index): CurrentPlanStep => ({
    ...draft.step,
    step_no: index + 1,
    depends_on: [...new Set(draft.dependencyKeys.map((key) => {
      const stepNo = stepNoByKey.get(key);
      if (!stepNo) throw new Error(`compiled Skill dependency ${key} is missing`);
      return stepNo;
    }))].sort((left, right) => left - right),
    input_bindings: draft.bindingSources.map(({ binding, sourceKey }) => {
      const sourceStepNo = stepNoByKey.get(sourceKey);
      if (!sourceStepNo) throw new Error(`compiled Skill binding source ${sourceKey} is missing`);
      return { ...binding, source_step_no: sourceStepNo };
    }),
  }));

  const invocations = [...expansions.values()].map((expansion): CurrentSkillInvocation => ({
    invocation_id: expansion.invocationId,
    skill_id: expansion.contract.skill_id,
    execution_mode: 'compiled',
    contract_version: expansion.contract.version,
    contract_hash: expansion.contractHash,
    degraded_policy: expansion.contract.degraded_policy,
    skill_reference_hashes: structuredClone(expansion.skillReferenceHashes),
    knowledge_references: structuredClone(expansion.references),
    resource_gaps: structuredClone(expansion.resourceGaps),
    step_nos: compiled
      .filter((step) => step.skill_invocation_id === expansion.invocationId)
      .map((step) => step.step_no),
  }));
  return { steps: compiled, invocations };
}
