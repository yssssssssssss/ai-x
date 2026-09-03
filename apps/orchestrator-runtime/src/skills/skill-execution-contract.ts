import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  frozen_input_fields?: string[];
  input_bindings: SkillExecutionStageBinding[];
  expected_outputs: Array<{ pointer: string; description: string }>;
  acceptance_criteria: string[];
  failure_policy: SkillFailurePolicy;
  share_scope?: 'plan';
  share_input_fields?: string[];
}

export interface SkillExecutionResourceQuery {
  query_id: string;
  types: string[];
  min_items: number;
  max_items: number;
  accepted_statuses: Array<'approved' | 'draft'>;
  purpose: string;
  failure_policy: SkillFailurePolicy;
}

export interface SkillExecutionContract {
  version: 'skill-execution-contract-v1';
  skill_id: string;
  required_requirement_fields: string[];
  resources: SkillExecutionResource[];
  resource_queries?: SkillExecutionResourceQuery[];
  skill_references?: string[];
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
  if (
    !relativePath
    || isAbsolute(relativePath)
    || relativePath.includes('\\')
    || relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new Error('Skill execution contract path must be a normalized relative path');
  const root = resolve(getConfigRoot());
  const rootReal = realpathSync(root);
  const full = resolve(root, relativePath);
  const lexicalRelative = relative(root, full);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`)) {
    throw new Error('Skill execution contract path escapes the configuration root');
  }
  let cursor = root;
  for (const segment of relativePath.split('/')) {
    cursor = resolve(cursor, segment);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error('Skill execution contract path contains a symbolic link');
    }
  }
  const physical = realpathSync(full);
  const physicalRelative = relative(rootReal, physical);
  if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`)) {
    throw new Error('Skill execution contract path physically escapes the configuration root');
  }
  if (!statSync(physical).isFile()) throw new Error('Skill execution contract path is not a regular file');
  return physical;
}

function validateGraph(contract: SkillExecutionContract): void {
  for (const query of contract.resource_queries ?? []) {
    if (query.min_items > query.max_items) {
      throw new Error(`Skill resource query ${query.query_id} has min_items greater than max_items`);
    }
  }
  const stages = new Map<string, SkillExecutionStage>();
  for (const stage of contract.stages) {
    if (stages.has(stage.stage_id)) throw new Error(`duplicate Skill stage ${stage.stage_id}`);
    if (stage.actor_type === 'skill' && stage.actor_id !== contract.skill_id) {
      throw new Error(
        `Skill execution contract ${contract.skill_id} contains hidden Skill actor ${stage.actor_id}`,
      );
    }
    if (stage.share_scope === 'plan' && stage.actor_type !== 'tool' && stage.actor_type !== 'knowledge') {
      throw new Error(`Skill stage ${stage.stage_id} may declare share_scope only for Tool or Knowledge`);
    }
    if (stage.share_input_fields !== undefined) {
      if (stage.share_scope !== 'plan' || stage.actor_type !== 'tool') {
        throw new Error(`Skill stage ${stage.stage_id} may declare share_input_fields only for a plan-shareable Tool`);
      }
      if (new Set(stage.share_input_fields).size !== stage.share_input_fields.length) {
        throw new Error(`Skill stage ${stage.stage_id} share_input_fields must be unique`);
      }
      for (const field of stage.share_input_fields) {
        if (!Object.hasOwn(stage.input, field)) {
          throw new Error(`Skill stage ${stage.stage_id} shared input field ${field} is not declared in input`);
        }
      }
    }
    if ((stage.frozen_input_fields?.length ?? 0) > 0 && stage.actor_type !== 'tool') {
      throw new Error(`Skill stage ${stage.stage_id} may declare frozen_input_fields only for Tool input`);
    }
    for (const field of stage.frozen_input_fields ?? []) {
      if (!Object.hasOwn(stage.input, field)) {
        throw new Error(`Skill stage ${stage.stage_id} frozen input field ${field} is not declared in input`);
      }
    }
    stages.set(stage.stage_id, stage);
  }
  if (!stages.has(contract.output_stage_id)) {
    throw new Error(`Skill output stage ${contract.output_stage_id} does not exist`);
  }
  if (!stages.get(contract.output_stage_id)!.expected_outputs.some(({ pointer }) => pointer === contract.output_pointer)) {
    throw new Error(`Skill output pointer ${contract.output_pointer} is not declared by ${contract.output_stage_id}`);
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
