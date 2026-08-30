import type { EvidenceEntry } from '../../../../packages/api-contract/research-deliverable.ts';

export function virtualUserSimulationEvidence(input: {
  stepNo: number;
  artifactId: string;
  artifactContentSha256: string;
  output: unknown;
  implementationId?: string;
  redactedOutputHash?: string;
}): EvidenceEntry[] {
  if (input.output === null || typeof input.output !== 'object' || Array.isArray(input.output)) return [];
  const reviews = (input.output as Record<string, unknown>).reviews;
  if (!Array.isArray(reviews)) return [];
  return reviews.map((_review, index) => ({
    id: `SIM${input.stepNo}-${index + 1}`,
    kind: 'tool_output' as const,
    evidenceClass: 'simulation' as const,
    toolId: 'virtual-user-lab',
    toolTier: 'optional' as const,
    artifactId: input.artifactId,
    artifactContentSha256: input.artifactContentSha256,
    jsonPointer: `/output/reviews/${index}`,
    stepNo: input.stepNo,
    ...(input.implementationId && input.redactedOutputHash
      ? {
          toolProof: {
            implementationId: input.implementationId,
            executionMode: 'real' as const,
            redactedOutputHash: input.redactedOutputHash,
          },
        }
      : {}),
    sensitivity: 'internal' as const,
    redaction: 'none' as const,
  }));
}
