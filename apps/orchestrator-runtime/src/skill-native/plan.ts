import type {
  ExecutionPlan,
  RequirementContext,
  SkillNativeCandidate,
  SkillPackageSnapshot,
} from '../../../../packages/api-contract/skill-native.ts';

export function buildExecutionPlan(input: {
  taskId: string;
  candidate: SkillNativeCandidate;
  snapshots: SkillPackageSnapshot[];
  requirement: RequirementContext;
}): ExecutionPlan {
  if (input.snapshots.length !== input.candidate.packages.length) {
    throw new Error('every planned Skill package must have a snapshot');
  }
  const snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.package.id, snapshot]));
  const invocations = input.candidate.packages.map((descriptor, index) => {
    const snapshot = snapshots.get(descriptor.id);
    if (!snapshot || snapshot.packageHash !== descriptor.packageHash) {
      throw new Error(`Skill package ${descriptor.id} does not match the selected candidate`);
    }
    return {
      id: `skill-${index + 1}-${descriptor.id}`,
      package: structuredClone(snapshot),
      dependsOn: index === 0 ? [] : [`skill-${index}-${input.candidate.packages[index - 1]!.id}`],
    };
  });
  const finalPackageId = input.candidate.finalReport.kind === 'skill'
    ? input.candidate.finalReport.packageId
    : null;
  const finalReport = finalPackageId === null
    ? { kind: 'platform_default' as const }
    : {
        kind: 'skill' as const,
        invocationId: invocations.find(({ package: snapshot }) => (
          snapshot.package.id === finalPackageId
        ))?.id ?? '',
      };
  if (finalReport.kind === 'skill' && !finalReport.invocationId) {
    throw new Error(`final report Skill ${finalPackageId} is not in the candidate`);
  }
  return {
    version: 'skill-native-plan-v2',
    taskId: input.taskId,
    candidateId: input.candidate.id,
    title: input.candidate.title,
    rationale: input.candidate.rationale,
    tradeoffs: input.candidate.tradeoffs,
    mode: input.candidate.mode,
    requirement: structuredClone(input.requirement),
    invocations,
    finalReport,
  };
}
