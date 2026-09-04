import type {
  InputQuestion,
  InputSourceKind,
  MissingInputPolicy,
  ReportGap,
  ResolvedInput,
  SkillDefinition,
} from '../../../../packages/api-contract/skill-native.ts';

const SOURCE_PRIORITY: readonly InputSourceKind[] = [
  'conversation',
  'upload',
  'database',
  'knowledge',
  'tool',
];

export interface InputMaterial {
  id: string;
  inputId: string;
  source: InputSourceKind;
  value: unknown;
  skillIds?: string[];
  ownerUserId?: string;
  projectId?: string;
  validUntil?: string | Date;
}

export interface InputResolutionScope {
  ownerUserId: string;
  projectId: string;
  now?: Date;
}

export interface InputResolutionResult {
  inputs: ResolvedInput[];
  questions: InputQuestion[];
  gaps: ReportGap[];
  blockedInputIds: string[];
  warnings: string[];
}

interface SharedInputDefinition {
  id: string;
  definitions: Array<{ skillId: string; skill: SkillDefinition['inputs'][number] }>;
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasValue);
  return value !== null && value !== undefined;
}

function strictestPolicy(definition: SharedInputDefinition): MissingInputPolicy {
  const policies = definition.definitions.map(({ skill }) => skill.missingPolicy);
  if (policies.includes('stop')) return 'stop';
  if (policies.includes('replace')) return 'replace';
  return 'gap';
}

function sharedSources(definition: SharedInputDefinition): InputSourceKind[] {
  return SOURCE_PRIORITY.filter((source) => (
    definition.definitions.every(({ skill }) => skill.acceptedSources.includes(source))
  ));
}

function inputDefinitions(skills: readonly SkillDefinition[]): SharedInputDefinition[] {
  const grouped = new Map<string, SharedInputDefinition>();
  for (const skill of skills) {
    for (const input of skill.inputs) {
      const current = grouped.get(input.id) ?? { id: input.id, definitions: [] };
      current.definitions.push({ skillId: skill.id, skill: input });
      grouped.set(input.id, current);
    }
  }
  return [...grouped.values()];
}

export function collectSkillInputQuestions(skills: readonly SkillDefinition[]): InputQuestion[] {
  return inputDefinitions(skills).map(questionFor);
}

function databaseMaterialAllowed(
  material: InputMaterial,
  scope: InputResolutionScope,
): boolean {
  if (material.source !== 'database') return true;
  if (material.ownerUserId !== scope.ownerUserId || material.projectId !== scope.projectId) return false;
  if (material.validUntil === undefined) return true;
  const validUntil = material.validUntil instanceof Date
    ? material.validUntil
    : new Date(material.validUntil);
  return !Number.isNaN(validUntil.getTime()) && validUntil.getTime() > (scope.now ?? new Date()).getTime();
}

function materialTargetsAll(material: InputMaterial, definition: SharedInputDefinition): boolean {
  if (!material.skillIds) return true;
  return definition.definitions.every(({ skillId }) => material.skillIds!.includes(skillId));
}

function questionFor(definition: SharedInputDefinition): InputQuestion {
  const first = definition.definitions[0]!.skill;
  const sources = sharedSources(definition);
  if (sources.length === 0) {
    throw new Error(`shared input ${definition.id} has no source accepted by every consuming Skill`);
  }
  return {
    inputId: definition.id,
    label: first.label,
    question: first.question,
    description: first.description,
    required: definition.definitions.some(({ skill }) => skill.required),
    multiple: definition.definitions.some(({ skill }) => skill.multiple),
    acceptedSources: sources,
    missingPolicy: strictestPolicy(definition),
    skillIds: definition.definitions.map(({ skillId }) => skillId),
  };
}

export function resolveSkillInputs(input: {
  skills: readonly SkillDefinition[];
  materials: readonly InputMaterial[];
  scope: InputResolutionScope;
  unavailableInputIds?: readonly string[];
}): InputResolutionResult {
  const unavailable = new Set(input.unavailableInputIds ?? []);
  const inputs: ResolvedInput[] = [];
  const questions: InputQuestion[] = [];
  const gaps: ReportGap[] = [];
  const blockedInputIds: string[] = [];
  const warnings: string[] = [];

  for (const definition of inputDefinitions(input.skills)) {
    const question = questionFor(definition);
    const accepted = new Set(question.acceptedSources);
    const eligible = input.materials
      .filter((material) => material.inputId === definition.id && hasValue(material.value))
      .filter((material) => question.multiple || !Array.isArray(material.value))
      .filter((material) => materialTargetsAll(material, definition))
      .filter((material) => {
        if (!accepted.has(material.source)) return false;
        if (databaseMaterialAllowed(material, input.scope)) return true;
        warnings.push(`database material ${material.id} was ignored outside its owner, project, or validity scope`);
        return false;
      });
    const selectedSource = SOURCE_PRIORITY.find((source) => eligible.some((item) => item.source === source));
    const selected = selectedSource
      ? eligible.filter((material) => material.source === selectedSource)
      : [];
    const unique = [...new Map(selected.map((material) => [material.id, material])).values()];

    if (unique.length > 0) {
      const chosen = question.multiple ? unique : unique.slice(0, 1);
      const values = chosen.flatMap(({ value }) => Array.isArray(value) ? value : [value]);
      inputs.push({
        inputId: definition.id,
        source: chosen[0]!.source,
        value: question.multiple ? values : chosen[0]!.value,
        referenceId: chosen.length === 1 ? chosen[0]!.id : `input:${definition.id}`,
        skillIds: question.skillIds,
      });
      continue;
    }

    if (!unavailable.has(definition.id)) {
      questions.push(question);
      continue;
    }
    if (question.missingPolicy === 'gap') {
      gaps.push({
        id: `input:${definition.id}`,
        message: `${question.label}未提供`,
        skillIds: question.skillIds,
      });
    } else {
      blockedInputIds.push(definition.id);
    }
  }

  return { inputs, questions, gaps, blockedInputIds, warnings };
}
