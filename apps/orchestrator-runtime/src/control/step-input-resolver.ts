import type { ControlArtifact, ControlArtifactState } from '../../../../database/control-plane.ts';
import type { CurrentPlanStep } from '../../../../packages/api-contract/research-deliverable.ts';

export type StepInputResolutionErrorCode =
  | 'invalid_pointer'
  | 'future_source'
  | 'unknown_source'
  | 'duplicate_source'
  | 'source_not_succeeded'
  | 'source_artifact_not_sealed'
  | 'source_artifact_mismatch'
  | 'source_pointer_missing'
  | 'duplicate_target'
  | 'unsafe_target'
  | 'target_not_object';

export class StepInputResolutionError extends Error {
  constructor(
    readonly code: StepInputResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StepInputResolutionError';
  }
}

export type StepArtifactKind = 'knowledge_output' | 'tool_output' | 'skill_output' | 'skill_result' | 'research_contribution' | 'llm_output' | 'review_output';

export interface SealedStepOutput {
  stepNo: number;
  actorId: string;
  kind: StepArtifactKind;
  state: 'succeeded' | 'failed' | 'skipped';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  artifact: {
    id: string;
    contentSha256: string | null;
    state: ControlArtifactState;
  };
}

export interface VerifiedArtifactReader {
  readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }>;
}

export interface VerifiedStepArtifact {
  artifact: ControlArtifact;
  value: unknown;
  output: unknown;
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function decodePointer(pointer: string, allowRoot: boolean): string[] {
  if (allowRoot && pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new StepInputResolutionError('invalid_pointer', `JSON Pointer must start with /: ${pointer}`);
  }
  const parts = pointer.slice(1).split('/');
  if (parts.some((part) => /~(?!0|1)/u.test(part))) {
    throw new StepInputResolutionError('invalid_pointer', `JSON Pointer has an invalid escape: ${pointer}`);
  }
  return parts.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

interface ParsedBinding {
  binding: CurrentPlanStep['input_bindings'][number];
  target: string[];
  source: string[];
}

function parseBindings(
  step: CurrentPlanStep,
  availableSourceStepNos: readonly number[],
): ParsedBinding[] {
  const parsed = step.input_bindings.map((binding) => ({
    binding,
    target: decodePointer(binding.target_pointer, false),
    source: decodePointer(binding.source_pointer, true),
  }));
  const targets = new Set<string>();
  for (const item of parsed) {
    if (item.target.some((part) => PROTOTYPE_KEYS.has(part))) {
      throw new StepInputResolutionError('unsafe_target', 'target JSON Pointer contains a prototype key');
    }
    const targetKey = JSON.stringify(item.target);
    if (targets.has(targetKey)) {
      throw new StepInputResolutionError('duplicate_target', 'step has duplicate target bindings');
    }
    targets.add(targetKey);
    if (item.binding.source_step_no >= step.step_no) {
      throw new StepInputResolutionError(
        'future_source',
        `step ${step.step_no} cannot bind from step ${item.binding.source_step_no}`,
      );
    }
    const sourceCount = availableSourceStepNos.filter(
      (sourceStepNo) => sourceStepNo === item.binding.source_step_no,
    ).length;
    if (sourceCount === 0) {
      if (item.binding.optional === true) continue;
      throw new StepInputResolutionError(
        'unknown_source',
        `source step ${item.binding.source_step_no} is unavailable`,
      );
    }
    if (sourceCount > 1) {
      throw new StepInputResolutionError(
        'duplicate_source',
        `source step ${item.binding.source_step_no} is present more than once`,
      );
    }
  }
  return parsed;
}

export function validateStepInputBindings(
  step: CurrentPlanStep,
  availableSourceStepNos: readonly number[],
): void {
  parseBindings(step, availableSourceStepNos);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPointer(value: unknown, parts: readonly string[]): { found: boolean; value?: unknown } {
  let current = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(part)) return { found: false };
      const index = Number(part);
      if (index >= current.length || !Object.hasOwn(current, index)) return { found: false };
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}

function writeObjectPointer(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  if (parts.length === 0) {
    throw new StepInputResolutionError('invalid_pointer', 'target JSON Pointer cannot address the input root');
  }
  if (parts.some((part) => PROTOTYPE_KEYS.has(part))) {
    throw new StepInputResolutionError('unsafe_target', 'target JSON Pointer contains a prototype key');
  }

  let current = root;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      current[part] = created;
      current = created;
      continue;
    }
    if (!isRecord(child)) {
      throw new StepInputResolutionError(
        'target_not_object',
        `target JSON Pointer traverses a non-object field: ${part}`,
      );
    }
    current = child;
  }
  current[parts[parts.length - 1]!] = structuredClone(value);
}

function logicalOutput(source: SealedStepOutput, artifactValue: unknown): unknown {
  if (source.kind !== 'tool_output') return artifactValue;
  return isRecord(artifactValue) && Object.hasOwn(artifactValue, 'output')
    ? artifactValue.output
    : undefined;
}

export async function readVerifiedStepArtifact(
  source: SealedStepOutput,
  artifactReader: VerifiedArtifactReader,
): Promise<VerifiedStepArtifact> {
  if (source.state !== 'succeeded') {
    throw new StepInputResolutionError(
      'source_not_succeeded',
      `source step ${source.stepNo} did not succeed`,
    );
  }
  if (source.artifact.state !== 'SEALED' || source.artifact.contentSha256 === null) {
    throw new StepInputResolutionError(
      'source_artifact_not_sealed',
      `source step ${source.stepNo} has no SEALED Artifact`,
    );
  }
  const verified = await artifactReader.readVerifiedJson<unknown>(source.artifact.id);
  if (
    verified.artifact.id !== source.artifact.id
    || verified.artifact.state !== 'SEALED'
    || verified.artifact.contentSha256 === null
    || verified.artifact.contentSha256 !== source.artifact.contentSha256
    || verified.artifact.taskId !== source.taskId
    || verified.artifact.planVersionId !== source.planVersionId
    || verified.artifact.attemptId !== source.attemptId
    || verified.artifact.kind !== source.kind
  ) {
    throw new StepInputResolutionError(
      'source_artifact_mismatch',
      `verified Artifact ${verified.artifact.id} does not match step ${source.stepNo}`,
    );
  }
  return {
    artifact: verified.artifact,
    value: verified.value,
    output: logicalOutput(source, verified.value),
  };
}

export async function resolveStepInput(
  step: CurrentPlanStep,
  sealedOutputs: readonly SealedStepOutput[],
  artifactReader: VerifiedArtifactReader,
): Promise<Record<string, unknown>> {
  const resolved = structuredClone(step.input);
  const parsedBindings = parseBindings(step, sealedOutputs.map((output) => output.stepNo));
  const verifiedByArtifactId = new Map<string, VerifiedStepArtifact>();
  for (const { binding, target, source: sourcePointer } of parsedBindings) {
    const source = sealedOutputs.find((output) => output.stepNo === binding.source_step_no);
    if (!source && binding.optional === true) continue;
    if (!source) {
      throw new StepInputResolutionError(
        'unknown_source',
        `source step ${binding.source_step_no} is unavailable`,
      );
    }
    let verified = verifiedByArtifactId.get(source.artifact.id);
    if (!verified) {
      verified = await readVerifiedStepArtifact(source, artifactReader);
      verifiedByArtifactId.set(source.artifact.id, verified);
    }
    const pointed = readPointer(verified.output, sourcePointer);
    if (!pointed.found) {
      throw new StepInputResolutionError(
        'source_pointer_missing',
        `source pointer ${binding.source_pointer} does not exist on step ${binding.source_step_no}`,
      );
    }
    writeObjectPointer(
      resolved,
      target,
      binding.include_artifact_identity === true
        ? {
            artifactId: verified.artifact.id,
            artifactContentSha256: verified.artifact.contentSha256,
            contribution: pointed.value,
          }
        : pointed.value,
    );
  }
  return resolved;
}
