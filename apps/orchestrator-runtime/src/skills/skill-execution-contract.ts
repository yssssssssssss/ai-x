// Transitional types for the visible, pre-confirmation step expansion used by
// the Current planner. Installed Skill packages never load a platform-authored
// execution file; new Task plans freeze NativeSkillRunSpec instead.
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
