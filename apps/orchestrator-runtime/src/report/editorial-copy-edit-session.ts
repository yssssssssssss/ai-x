import {
  EDITORIAL_COPY_EDIT_PLAN_VERSION,
  EDITORIAL_COPY_EDIT_REQUEST_VERSION,
  EDITORIAL_MAX_MODEL_CONTEXT_BYTES,
  EditorialContractError,
  buildDeterministicEditorialBlueprint,
  canonicalEditorialJson,
  editorialScalarText,
  enumerateEditorialParaphrases,
  hasEditorialSensitiveToken,
  indexEditorialBlueprintCopies,
  parseEditorialBlueprint,
  parseEditorialMaterial,
  validateEditorialBlueprint,
  type EditorialBlueprint,
  type EditorialMaterial,
  type EditorialModelContext,
} from './editorial-report-contract.ts';

export interface EditorialCopyEdit {
  copyPointer: string;
  materialUnitId: string;
  text: string;
}

export interface EditorialCopyEditPlan {
  version: typeof EDITORIAL_COPY_EDIT_PLAN_VERSION;
  edits: EditorialCopyEdit[];
}

export interface EditorialCopyEditTarget {
  copyPointer: string;
  materialUnitId: string;
  currentText: string;
}

export interface EditorialCopyEditSession {
  readonly requestContext: {
    readonly version: typeof EDITORIAL_COPY_EDIT_REQUEST_VERSION;
    readonly targets: readonly Readonly<EditorialCopyEditTarget>[];
  };
  apply(response: unknown): {
    blueprint: EditorialBlueprint;
    editPlan: EditorialCopyEditPlan;
  };
  replay(blueprint: EditorialBlueprint): EditorialCopyEditPlan;
}

const COPY_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/u;
const MATERIAL_UNIT_ID_PATTERN = /^emu_[0-9a-f]{64}$/u;
const MAX_EDIT_COUNT = 6;
const MAX_EDIT_CODE_POINTS = 600;
const MAX_MODEL_UNIT_COUNT = 400;
const MAX_MODEL_TEXT_CODE_POINTS = 120_000;
const UNSAFE_COPY_EDIT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2800]|\p{Default_Ignorable_Code_Point}|\p{Cf}/u;

function visibleCopyText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function fail(
  code: string,
  message: string,
  checkId: ConstructorParameters<typeof EditorialContractError>[2],
  path?: string,
): never {
  throw new EditorialContractError(code, message, checkId, path);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEMA_INTEGRITY', 'expected an object', 'schema_integrity', path);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail('SCHEMA_INTEGRITY', `unknown field "${key}"`, 'schema_integrity', `${path}/${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail('SCHEMA_INTEGRITY', `missing required field "${key}"`, 'schema_integrity', path);
    }
  }
}

function parseCopyEditPlan(value: unknown): EditorialCopyEditPlan {
  const candidate = asRecord(value, '');
  assertExactKeys(candidate, ['version', 'edits'], ['version', 'edits'], '');
  if (candidate.version !== EDITORIAL_COPY_EDIT_PLAN_VERSION) {
    fail('SCHEMA_INTEGRITY', 'Copy Edit Plan version is invalid', 'schema_integrity', '/version');
  }
  if (!Array.isArray(candidate.edits) || candidate.edits.length < 1 || candidate.edits.length > MAX_EDIT_COUNT) {
    fail(
      'SCHEMA_INTEGRITY',
      `Copy Edit Plan edits must contain between 1 and ${MAX_EDIT_COUNT} entries`,
      'schema_integrity',
      '/edits',
    );
  }
  const edits = candidate.edits.map((value, index): EditorialCopyEdit => {
    const path = `/edits/${index}`;
    const edit = asRecord(value, path);
    assertExactKeys(
      edit,
      ['copyPointer', 'materialUnitId', 'text'],
      ['copyPointer', 'materialUnitId', 'text'],
      path,
    );
    if (
      typeof edit.copyPointer !== 'string'
      || Buffer.byteLength(edit.copyPointer, 'utf8') > 256
      || !/^[\x20-\x7e]+$/u.test(edit.copyPointer)
      || !COPY_POINTER_PATTERN.test(edit.copyPointer)
    ) {
      fail(
        'SCHEMA_INTEGRITY',
        'copyPointer must be bounded ASCII RFC 6901 and point below the root',
        'schema_integrity',
        `${path}/copyPointer`,
      );
    }
    if (typeof edit.materialUnitId !== 'string' || !MATERIAL_UNIT_ID_PATTERN.test(edit.materialUnitId)) {
      fail('SCHEMA_INTEGRITY', 'materialUnitId is invalid', 'schema_integrity', `${path}/materialUnitId`);
    }
    if (
      typeof edit.text !== 'string'
      || visibleCopyText(edit.text).length === 0
      || Array.from(edit.text).length > MAX_EDIT_CODE_POINTS
      || Buffer.byteLength(edit.text, 'utf8') > 64 * 1024
    ) {
      fail(
        'SCHEMA_INTEGRITY',
        `text must contain between 1 and ${MAX_EDIT_CODE_POINTS} safe visible code points`,
        'schema_integrity',
        `${path}/text`,
      );
    }
    if (UNSAFE_COPY_EDIT_TEXT.test(edit.text)) {
      fail(
        'SCHEMA_INTEGRITY',
        'text must not contain control, format, default-ignorable, or blank-pattern Unicode characters',
        'schema_integrity',
        `${path}/text`,
      );
    }
    return {
      copyPointer: edit.copyPointer,
      materialUnitId: edit.materialUnitId,
      text: edit.text,
    };
  });
  return { version: EDITORIAL_COPY_EDIT_PLAN_VERSION, edits };
}

export function editorialCopyEditInputWithinBudget(input: {
  modelContext: EditorialModelContext;
  modelContextByteSize: number;
  copyEditRequest: EditorialCopyEditSession['requestContext'];
}): boolean {
  const textCodePoints = input.modelContext.units.reduce((count, unit) => (
    count + Array.from(String(unit.value)).length
  ), 0);
  return input.modelContext.units.length <= MAX_MODEL_UNIT_COUNT
    && textCodePoints <= MAX_MODEL_TEXT_CODE_POINTS
    && input.modelContextByteSize <= EDITORIAL_MAX_MODEL_CONTEXT_BYTES
    && Buffer.byteLength(canonicalEditorialJson({
      modelContext: input.modelContext,
      copyEditRequest: input.copyEditRequest,
    }), 'utf8') <= EDITORIAL_MAX_MODEL_CONTEXT_BYTES;
}

export function prepareEditorialCopyEditSession(input: {
  material: EditorialMaterial;
  requestKey: string;
}): EditorialCopyEditSession {
  const material = parseEditorialMaterial(input.material);
  const scaffold = buildDeterministicEditorialBlueprint({ material, requestKey: input.requestKey });
  const evidenceIds = material.evidence.map(({ id }) => id);
  const materialById = new Map(material.units.map((unit) => [unit.id, unit]));
  const indexedScaffold = indexEditorialBlueprintCopies(scaffold);
  const targets = indexedScaffold.flatMap(({ copyPointer, copy, audit }) => {
    if (audit || copy.mode !== 'verbatim' || copy.materialUnitIds.length !== 1) return [];
    const materialUnitId = copy.materialUnitIds[0]!;
    const unit = materialById.get(materialUnitId);
    if (unit === undefined) return [];
    const currentText = editorialScalarText(unit.value);
    if (
      copy.text !== currentText
      || Array.from(currentText).length > MAX_EDIT_CODE_POINTS
      || hasEditorialSensitiveToken(currentText, evidenceIds)
    ) return [];
    return [{ copyPointer, materialUnitId, currentText }];
  });
  const frozenTargets = Object.freeze(targets.map((target) => Object.freeze({ ...target })));
  const requestContext = Object.freeze({
    version: EDITORIAL_COPY_EDIT_REQUEST_VERSION,
    targets: frozenTargets,
  });
  const targetIndex = new Map(targets.map((target, index) => [target.copyPointer, index]));
  const allPointers = new Set(indexedScaffold.map(({ copyPointer }) => copyPointer));

  const apply = (response: unknown): {
    blueprint: EditorialBlueprint;
    editPlan: EditorialCopyEditPlan;
  } => {
    const editPlan = parseCopyEditPlan(response);
    const candidate = parseEditorialBlueprint(scaffold);
    const candidateCopies = new Map(
      indexEditorialBlueprintCopies(candidate).map((entry) => [entry.copyPointer, entry.copy]),
    );
    let previousTargetIndex = -1;
    const seenPointers = new Set<string>();
    editPlan.edits.forEach((edit, index) => {
      const path = `/edits/${index}`;
      if (seenPointers.has(edit.copyPointer)) {
        fail('SCHEMA_INTEGRITY', 'copyPointer values must be unique', 'schema_integrity', `${path}/copyPointer`);
      }
      seenPointers.add(edit.copyPointer);
      const currentTargetIndex = targetIndex.get(edit.copyPointer);
      if (currentTargetIndex === undefined) {
        if (!allPointers.has(edit.copyPointer)) {
          fail('REFERENCE_INTEGRITY', 'copyPointer does not identify a scaffold Copy', 'reference_integrity', `${path}/copyPointer`);
        }
        fail('CONTENT_FIDELITY', 'copyPointer is not eligible for editing', 'content_fidelity', `${path}/copyPointer`);
      }
      if (currentTargetIndex <= previousTargetIndex) {
        fail('SCHEMA_INTEGRITY', 'edits must follow canonical scaffold order', 'schema_integrity', '/edits');
      }
      previousTargetIndex = currentTargetIndex;
      const target = targets[currentTargetIndex]!;
      if (edit.materialUnitId !== target.materialUnitId) {
        fail(
          'REFERENCE_INTEGRITY',
          'materialUnitId does not match the scaffold Copy',
          'reference_integrity',
          `${path}/materialUnitId`,
        );
      }
      if (visibleCopyText(edit.text) === visibleCopyText(target.currentText)) {
        fail('CONTENT_FIDELITY', 'edited text must differ from the scaffold Copy', 'content_fidelity', `${path}/text`);
      }
      if (hasEditorialSensitiveToken(edit.text, evidenceIds)) {
        fail('NUMERIC_INTEGRITY', 'edited text contains a protected token', 'numeric_integrity', `${path}/text`);
      }
      const copy = candidateCopies.get(edit.copyPointer);
      if (copy === undefined) {
        throw new Error(`Prepared Copy target disappeared: ${edit.copyPointer}`);
      }
      copy.text = edit.text;
      copy.mode = 'paraphrase';
    });
    const blueprint = validateEditorialBlueprint({ blueprint: candidate, material, mode: 'llm' });
    return { blueprint, editPlan };
  };

  const replay = (blueprintInput: EditorialBlueprint): EditorialCopyEditPlan => {
    const blueprint = parseEditorialBlueprint(blueprintInput);
    const paraphrases = enumerateEditorialParaphrases(blueprint);
    if (paraphrases.length < 1 || paraphrases.length > MAX_EDIT_COUNT) {
      fail(
        'CONTENT_FIDELITY',
        `published Blueprint must contain between 1 and ${MAX_EDIT_COUNT} paraphrases`,
        'content_fidelity',
      );
    }
    const response: EditorialCopyEditPlan = {
      version: EDITORIAL_COPY_EDIT_PLAN_VERSION,
      edits: paraphrases.map((copy, index) => {
        if (copy.materialUnitIds.length !== 1) {
          fail(
            'REFERENCE_INTEGRITY',
            'published paraphrase must reference exactly one Material Unit',
            'reference_integrity',
            `${copy.copyPointer}/materialUnitIds`,
          );
        }
        return {
          copyPointer: copy.copyPointer,
          materialUnitId: copy.materialUnitIds[0]!,
          text: copy.text,
        };
      }),
    };
    const rebuilt = apply(response);
    if (canonicalEditorialJson(rebuilt.blueprint) !== canonicalEditorialJson(blueprint)) {
      fail(
        'CONTENT_FIDELITY',
        'published Blueprint differs from the deterministic scaffold outside the accepted edits',
        'content_fidelity',
      );
    }
    return rebuilt.editPlan;
  };

  return Object.freeze({ requestContext, apply, replay });
}
