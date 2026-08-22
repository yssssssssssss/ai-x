import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  referenceHashes: Array<{ path: string; hash: string }>;
}

export function prepareSkillExecution(input: {
  skillId: string;
  researchGoal: string;
  resolvedInput: Record<string, unknown>;
  priorOutputs: unknown;
  stepContract?: Record<string, unknown>;
  skillLoader: SkillLoader;
  validator: SchemaValidator;
  captureSchemaHashes?: boolean;
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
  const contractLoader = input.skillLoader as SkillLoader & {
    loadSkillExecution?: (id: string) => ReturnType<SkillLoader['loadSkillExecution']>;
  };
  const execution = typeof contractLoader.loadSkillExecution === 'function'
    ? contractLoader.loadSkillExecution(input.skillId)
    : null;
  const skillRoot = dirname(resolve(getConfigRoot(), body.path));
  const references = (execution?.contract.skill_references ?? []).map((referencePath) => {
    if (isAbsolute(referencePath)) throw new Error('Skill reference path must be relative');
    const full = resolve(skillRoot, referencePath);
    if (relative(skillRoot, full).startsWith('..')) throw new Error('Skill reference path escapes the Skill root');
    const content = readFileSync(full, 'utf8');
    return {
      path: referencePath,
      content,
      hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    };
  });
  const referenceText = references.length === 0
    ? ''
    : `\n\nVerified Skill references:\n${references.map(({ path, content }) => `--- ${path} ---\n${content}`).join('\n\n')}`;
  return {
    skill,
    body,
    schemas,
    schemaHashes: {
      inputSchemaHash: input.captureSchemaHashes === false || !skill.input_schema
        ? null
        : hashFile(skill.input_schema),
      outputSchemaHash: input.captureSchemaHashes === false ? '' : hashFile(skill.output_schema),
      payloadSchemaHash: input.captureSchemaHashes === false || !skill.payload_schema
        ? null
        : hashFile(skill.payload_schema),
    },
    prompt: `${SKILL_EXECUTION_PROMPT_PREFIX}\n${JSON.stringify(stepContract)}\n\n${body.body}${referenceText}`,
    context: {
      research_goal: input.researchGoal,
      input: input.resolvedInput,
      prior_outputs: input.priorOutputs,
      skill_references: references.map(({ path, content, hash }) => ({ path, content, hash })),
      ...stepContract,
    },
    referenceHashes: references.map(({ path, hash }) => ({ path, hash })),
  };
}
