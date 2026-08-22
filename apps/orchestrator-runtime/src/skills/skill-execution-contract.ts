import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SchemaValidator } from '../schema/validator.ts';
import { getConfigRoot } from '../runtime/config-loader.ts';

export type SkillExecutionActorType = 'knowledge' | 'tool' | 'llm' | 'skill' | 'reviewer';
export type SkillFailurePolicy = 'block' | 'gap';

export interface SkillExecutionResource {
  resource_id: string;
  required: boolean;
  accepted_statuses: Array<'approved' | 'draft'>;
  purpose: string;
  failure_policy: SkillFailurePolicy;
}

export interface SkillExecutionStageBinding {
  target_pointer: string;
  source_stage_id: string;
  source_pointer: string;
}

export interface SkillExecutionStage {
  stage_id: string;
  title: string;
  actor_type: SkillExecutionActorType;
  actor_id: string;
  depends_on: string[];
  input: Record<string, unknown>;
  input_bindings: SkillExecutionStageBinding[];
  expected_outputs: Array<{ pointer: string; description: string }>;
  acceptance_criteria: string[];
  failure_policy: SkillFailurePolicy;
}

export interface SkillExecutionContract {
  version: 'skill-execution-contract-v1';
  skill_id: string;
  required_requirement_fields: string[];
  resources: SkillExecutionResource[];
  stages: SkillExecutionStage[];
  output_stage_id: string;
  output_pointer: string;
  degraded_policy: SkillFailurePolicy;
}

export interface LoadedSkillExecutionContract {
  contract: SkillExecutionContract;
  hash: string;
  path: string;
}

function contractPath(relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error('Skill execution contract path must be relative');
  const root = resolve(getConfigRoot());
  const full = resolve(root, relativePath);
  if (relative(root, full).startsWith('..')) {
    throw new Error('Skill execution contract path escapes the configuration root');
  }
  return full;
}

function validateGraph(contract: SkillExecutionContract): void {
  const stages = new Map<string, SkillExecutionStage>();
  for (const stage of contract.stages) {
    if (stages.has(stage.stage_id)) throw new Error(`duplicate Skill stage ${stage.stage_id}`);
    stages.set(stage.stage_id, stage);
  }
  if (!stages.has(contract.output_stage_id)) {
    throw new Error(`Skill output stage ${contract.output_stage_id} does not exist`);
  }
  const complete = new Set<string>();
  const active = new Set<string>();
  const visit = (stageId: string): void => {
    if (complete.has(stageId)) return;
    if (active.has(stageId)) throw new Error(`Skill stage dependency cycle at ${stageId}`);
    const stage = stages.get(stageId);
    if (!stage) throw new Error(`unknown Skill stage dependency ${stageId}`);
    active.add(stageId);
    for (const dependency of stage.depends_on) visit(dependency);
    for (const binding of stage.input_bindings) {
      if (!stage.depends_on.includes(binding.source_stage_id)) {
        throw new Error(`Skill stage ${stageId} binding source must be a direct dependency`);
      }
      if (!stages.has(binding.source_stage_id)) {
        throw new Error(`unknown Skill binding source ${binding.source_stage_id}`);
      }
    }
    active.delete(stageId);
    complete.add(stageId);
  };
  for (const stageId of stages.keys()) visit(stageId);
}

export function loadSkillExecutionContract(
  relativePath: string,
  expectedSkillId: string,
  validator = new SchemaValidator(),
): LoadedSkillExecutionContract {
  const full = contractPath(relativePath);
  const bytes = readFileSync(full);
  const value = parseYaml(bytes.toString('utf8')) as unknown;
  validator.validateOrThrow('skill-execution-contract', value);
  const contract = value as SkillExecutionContract;
  if (contract.skill_id !== expectedSkillId) {
    throw new Error(`Skill execution contract ${contract.skill_id} does not match ${expectedSkillId}`);
  }
  validateGraph(contract);
  return {
    contract,
    hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    path: relativePath,
  };
}
