import { join } from 'node:path';
import { getConfigRoot, hashFile, type SkillRegistryEntry } from '../runtime/config-loader.ts';
import type { SkillLoader, LoadedSkillSchemas } from '../runtime/skill-loader.ts';
import type { SchemaValidator } from '../schema/validator.ts';

export const SKILL_EXECUTION_PROMPT_PREFIX = 'Execute this Skill workflow using only supplied verified inputs.';

export interface PreparedSkillExecution {
  skill: SkillRegistryEntry;
  body: { body: string; hash: string; path: string };
  schemas: LoadedSkillSchemas;
  schemaHashes: {
    inputSchemaHash: string | null;
    outputSchemaHash: string;
    payloadSchemaHash: string | null;
  };
  prompt: string;
  context: Record<string, unknown>;
}

export function prepareSkillExecution(input: {
  skillId: string;
  researchGoal: string;
  resolvedInput: Record<string, unknown>;
  priorOutputs: unknown;
  stepContract?: Record<string, unknown>;
  skillLoader: SkillLoader;
  validator: SchemaValidator;
}): PreparedSkillExecution {
  const skill = input.skillLoader.getSkill(input.skillId);
  if (!skill) throw new Error(`skill ${input.skillId} is not active`);
  const body = input.skillLoader.loadSkillBody(input.skillId);
  const schemas = input.skillLoader.loadSkillSchemas(input.skillId);
  if (!skill.output_schema) throw new Error(`skill ${input.skillId} has no output contract`);
  if (skill.input_schema) {
    input.validator.validateFileOrThrow(
      join(getConfigRoot(), skill.input_schema),
      input.resolvedInput,
    );
  }
  const stepContract = input.stepContract ?? {};
  return {
    skill,
    body,
    schemas,
    schemaHashes: {
      inputSchemaHash: skill.input_schema ? hashFile(skill.input_schema) : null,
      outputSchemaHash: hashFile(skill.output_schema),
      payloadSchemaHash: skill.payload_schema ? hashFile(skill.payload_schema) : null,
    },
    prompt: `${SKILL_EXECUTION_PROMPT_PREFIX}\n${JSON.stringify(stepContract)}\n\n${body.body}`,
    context: {
      research_goal: input.researchGoal,
      input: input.resolvedInput,
      prior_outputs: input.priorOutputs,
      ...stepContract,
    },
  };
}
