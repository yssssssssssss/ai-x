import type {
  InputQuestion,
  RequirementContext,
  SkillDefinition,
  SolutionDefinition,
  SolutionPlan,
} from '../../../../packages/api-contract/skill-native.ts';
import type { SkillNativeCatalogSnapshot } from './catalog.ts';
import type { InputResolutionResult } from './input-resolution.ts';

function orderedSkills(solution: SolutionDefinition): SolutionDefinition['skills'] {
  const byId = new Map(solution.skills.map((skill) => [skill.skillId, skill]));
  const ordered: SolutionDefinition['skills'] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (skillId: string): void => {
    if (visiting.has(skillId)) throw new Error(`solution ${solution.id} contains a dependency cycle`);
    if (visited.has(skillId)) return;
    const skill = byId.get(skillId);
    if (!skill) throw new Error(`solution ${solution.id} references unknown skill ${skillId}`);
    visiting.add(skillId);
    for (const dependency of skill.dependsOn) visit(dependency);
    visiting.delete(skillId);
    visited.add(skillId);
    ordered.push(skill);
  };
  for (const skill of solution.skills) visit(skill.skillId);
  return ordered;
}

function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return structuredClone(skill);
}

export function buildSolutionPlan(input: {
  taskId: string;
  solution: SolutionDefinition;
  catalog: Pick<SkillNativeCatalogSnapshot, 'skills'>;
  requirement: Omit<RequirementContext, 'inputs' | 'gaps'>;
  resolution: InputResolutionResult;
  rationale?: string;
  tradeoffs?: string;
  questions?: InputQuestion[];
  replaceSkillIds?: ReadonlySet<string>;
}): SolutionPlan {
  if (input.resolution.blockedInputIds.length > 0) {
    throw new Error(`required inputs are unavailable: ${input.resolution.blockedInputIds.join(', ')}`);
  }
  if (input.resolution.questions.length > 0) {
    throw new Error(`input questions are unresolved: ${input.resolution.questions.map(({ inputId }) => inputId).join(', ')}`);
  }
  const skills = new Map(input.catalog.skills.map((skill) => [skill.id, skill]));
  const ordered = orderedSkills(input.solution);
  const invocations = ordered.map((definition, index) => {
    const primarySkill = skills.get(definition.skillId);
    if (!primarySkill) throw new Error(`skill ${definition.skillId} is unavailable`);
    const replacementSkill = definition.replacementSkillId
      ? skills.get(definition.replacementSkillId)
      : undefined;
    if (definition.replacementSkillId && !replacementSkill) {
      throw new Error(`replacement skill ${definition.replacementSkillId} is unavailable`);
    }
    const replaced = input.replaceSkillIds?.has(definition.skillId) ?? false;
    const skill = replaced ? replacementSkill : primarySkill;
    if (!skill) throw new Error(`skill ${definition.skillId} has no replacement`);
    return {
      id: `skill-${index + 1}-${definition.skillId}`,
      skill: cloneSkill(skill),
      dependsOn: definition.dependsOn.map((dependency) => {
        const dependencyIndex = ordered.findIndex(({ skillId }) => skillId === dependency);
        return `skill-${dependencyIndex + 1}-${dependency}`;
      }),
      failurePolicy: replaced ? 'gap' as const : definition.failurePolicy,
      ...(!replaced && replacementSkill ? { replacementSkill: cloneSkill(replacementSkill) } : {}),
      ...(replaced ? { replacedSkillId: definition.skillId } : {}),
    };
  });
  const finalIndex = ordered.findIndex(({ skillId }) => skillId === input.solution.finalReportSkillId);
  const final = invocations[finalIndex];
  if (!final) throw new Error(`final report skill ${input.solution.finalReportSkillId} is unavailable`);
  if (input.solution.mode === 'multi_skill') {
    const reachable = new Set<string>();
    const byInvocation = new Map(invocations.map((invocation) => [invocation.id, invocation]));
    const visit = (id: string): void => {
      for (const dependency of byInvocation.get(id)?.dependsOn ?? []) {
        if (reachable.has(dependency)) continue;
        reachable.add(dependency);
        visit(dependency);
      }
    };
    visit(final.id);
    const disconnected = invocations.find((invocation) => invocation.id !== final.id && !reachable.has(invocation.id));
    if (disconnected) throw new Error(`final report skill does not depend on ${disconnected.skill.id}`);
  }
  return {
    version: 'skill-native-plan-v1',
    taskId: input.taskId,
    solutionId: input.solution.id,
    title: input.solution.title,
    rationale: input.rationale ?? input.solution.description,
    tradeoffs: input.tradeoffs ?? input.solution.whenToUse,
    mode: input.solution.mode,
    requirement: {
      ...structuredClone(input.requirement),
      inputs: input.resolution.inputs.map((resolved) => ({
        ...structuredClone(resolved),
        skillIds: [...new Set(resolved.skillIds.flatMap((skillId) => {
          const invocation = invocations.find(({ skill }) => skill.id === skillId);
          return invocation?.replacementSkill?.inputs.some(({ id }) => id === resolved.inputId)
            ? [skillId, invocation.replacementSkill.id]
            : [skillId];
        }))],
      })),
      gaps: structuredClone(input.resolution.gaps),
    },
    invocations,
    finalReportInvocationId: final.id,
    questions: structuredClone(input.questions ?? []),
  };
}
