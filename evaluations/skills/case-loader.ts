import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  getConfigRoot,
  type SkillRegistryEntry,
} from '../../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import type { LoadedEvaluationCase, SkillEvaluationCase } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateCase(value: unknown, filename: string): SkillEvaluationCase {
  if (!isRecord(value)) {
    throw new Error(`invalid case ${filename}: case must be an object`);
  }
  if (typeof value.skill_id !== 'string' || value.skill_id.length === 0) {
    throw new Error(`invalid case ${filename}: skill_id must be a non-empty string`);
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    throw new Error(`invalid case ${filename}: title must be a non-empty string`);
  }
  if (
    typeof value.research_goal !== 'string' ||
    value.research_goal.length === 0
  ) {
    throw new Error(
      `invalid case ${filename}: research_goal must be a non-empty string`,
    );
  }
  if (!isRecord(value.input_materials)) {
    throw new Error(`invalid case ${filename}: input_materials must be an object`);
  }
  if (
    !Array.isArray(value.tool_outputs) ||
    !value.tool_outputs.every(isRecord)
  ) {
    throw new Error(
      `invalid case ${filename}: tool_outputs must be an array of objects`,
    );
  }
  if (
    !isStringArray(value.expected_deliverables) ||
    value.expected_deliverables.length === 0
  ) {
    throw new Error(
      `invalid case ${filename}: expected_deliverables must be a non-empty string array`,
    );
  }
  if (!isStringArray(value.risk_checks)) {
    throw new Error(`invalid case ${filename}: risk_checks must be a string array`);
  }

  return value as unknown as SkillEvaluationCase;
}

export function loadEvaluationCases(
  activeSkills: SkillRegistryEntry[],
  casesDir = join(getConfigRoot(), 'evaluations', 'skills', 'cases'),
): Map<string, LoadedEvaluationCase> {
  let filenames: string[];
  try {
    filenames = readdirSync(casesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    filenames = [];
  }
  const parsedCases: Array<{
    filename: string;
    data: SkillEvaluationCase;
    loaded: LoadedEvaluationCase;
  }> = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const filename of filenames) {
    const sourcePath = join(casesDir, filename);
    const fileBytes = readFileSync(sourcePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileBytes.toString('utf8'));
    } catch {
      throw new Error(`invalid case ${filename}: invalid JSON`);
    }

    const data = validateCase(parsed, filename);
    if (seenIds.has(data.skill_id)) {
      duplicateIds.add(data.skill_id);
    }
    seenIds.add(data.skill_id);
    parsedCases.push({
      filename,
      data,
      loaded: {
        data,
        sourcePath,
        caseHash: `sha256:${createHash('sha256').update(fileBytes).digest('hex')}`,
      },
    });
  }

  if (duplicateIds.size > 0) {
    throw new Error(`duplicate case ids: ${[...duplicateIds].sort().join(', ')}`);
  }

  const loadedById = new Map<string, LoadedEvaluationCase>();
  for (const { filename, data, loaded } of parsedCases) {
    const filenameId = basename(filename, '.json');
    if (data.skill_id !== filenameId) {
      throw new Error(
        `invalid case ${filename}: skill_id must match filename: ${filenameId}`,
      );
    }
    loadedById.set(data.skill_id, loaded);
  }

  const activeIds = new Set(activeSkills.map(({ id }) => id));
  const missingIds = activeSkills
    .map(({ id }) => id)
    .filter((id) => !loadedById.has(id));
  if (missingIds.length > 0) {
    throw new Error(`missing cases: ${missingIds.join(', ')}`);
  }

  const unknownIds = [...loadedById.keys()]
    .filter((id) => !activeIds.has(id))
    .sort();
  if (unknownIds.length > 0) {
    throw new Error(`unknown cases: ${unknownIds.join(', ')}`);
  }

  return new Map(
    activeSkills.map(({ id }) => [id, loadedById.get(id)!] as const),
  );
}
