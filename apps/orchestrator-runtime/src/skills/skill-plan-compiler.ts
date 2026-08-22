import type {
  CurrentKnowledgeReference,
  CurrentPlanInputBinding,
  CurrentPlanStep,
  CurrentSkillInvocation,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import { loadRuntimeKnowledgeIndex } from '../knowledge/index.ts';
import { SkillLoader } from '../runtime/skill-loader.ts';
import type { SkillExecutionContract, SkillExecutionStage } from './skill-execution-contract.ts';

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

function frozenReferences(contract: SkillExecutionContract): CurrentKnowledgeReference[] {
  const index = new Map(loadRuntimeKnowledgeIndex().map((item) => [item.id, item]));
  return contract.resources.map((resource) => {
    const item = index.get(resource.resource_id);
    if (!item || (item.status !== 'approved' && item.status !== 'draft')) {
      throw new Error(`Skill ${contract.skill_id} knowledge ${resource.resource_id} is unavailable`);
    }
    if (!resource.accepted_statuses.includes(item.status)) {
      throw new Error(`Skill ${contract.skill_id} knowledge ${resource.resource_id} status is not accepted`);
    }
    return {
      resourceId: item.id,
      sourcePath: item.source_path,
      status: item.status,
      contentHash: item.content_hash,
      required: resource.required,
      failurePolicy: resource.failure_policy,
    };
  });
}

function stageStep(
  stage: SkillExecutionStage,
  original: CurrentPlanStep,
  expansion: Expansion,
): CurrentPlanStep {
  const input = {
    ...structuredClone(stage.input),
    ...(stage.actor_type === 'knowledge'
      ? { references: structuredClone(expansion.references), contractHash: expansion.contractHash }
      : {}),
    ...(stage.stage_id === expansion.contract.output_stage_id
      ? structuredClone(original.input)
      : {}),
  };
  return {
    step_no: 0,
    step_name: stage.title,
    actor_type: stage.actor_type,
    actor_id: stage.actor_id,
    question_ids: [...original.question_ids],
    depends_on: [],
    input,
    input_bindings: [],
    expected_outputs: stage.stage_id === expansion.contract.output_stage_id
      ? structuredClone(original.expected_outputs)
      : structuredClone(stage.expected_outputs),
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
    expansions.set(step.step_no, {
      oldSkillStepNo: step.step_no,
      invocationId,
      contract: loaded.contract,
      contractHash: loaded.hash,
      stageKey,
      reusedOldStepByStage,
      references: frozenReferences(loaded.contract),
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
        if (stage.stage_id === expansion.contract.output_stage_id) {
          dependencyKeys.push(...original.depends_on.map((stepNo) => `old:${stepNo}`));
        }
        const bindingSources = stage.input_bindings.map((binding) => ({
          binding: {
            target_pointer: binding.target_pointer,
            source_step_no: 0,
            source_pointer: binding.source_pointer,
          },
          sourceKey: expansion.stageKey.get(binding.source_stage_id)!,
        }));
        if (stage.stage_id === expansion.contract.output_stage_id) {
          bindingSources.push(...original.input_bindings.map((binding) => ({
            binding: { ...binding, source_step_no: 0 },
            sourceKey: `old:${binding.source_step_no}`,
          })));
        }
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
      step.input = { ...structuredClone(reused.stage.input), ...step.input };
      dependencyKeys = [...new Set([
        ...dependencyKeys,
        ...reused.stage.depends_on.map((stageId) => reused.expansion.stageKey.get(stageId)!),
      ])];
      bindingSources = [
        ...bindingSources,
        ...reused.stage.input_bindings.map((binding) => ({
          binding: {
            target_pointer: binding.target_pointer,
            source_step_no: 0,
            source_pointer: binding.source_pointer,
          },
          sourceKey: reused.expansion.stageKey.get(binding.source_stage_id)!,
        })),
      ];
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
    step_nos: compiled
      .filter((step) => step.skill_invocation_id === expansion.invocationId)
      .map((step) => step.step_no),
  }));
  return { steps: compiled, invocations };
}
