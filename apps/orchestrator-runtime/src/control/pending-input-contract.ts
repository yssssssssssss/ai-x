import type { PendingInput } from '../../../../packages/api-contract/research-deliverable.ts';

const PENDING_INPUT_KEYS = ['kind', 'role', 'label', 'multiple', 'targets'] as const;
const PENDING_TARGET_KEYS = ['step_no', 'tool_id', 'field', 'multiple'] as const;

export class PendingInputContractError extends Error {
  constructor(message: string) {
    super(`pending input contract is invalid: ${message}`);
    this.name = 'PendingInputContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function parsePendingInputContracts(value: unknown): PendingInput[] {
  if (!Array.isArray(value)) throw new PendingInputContractError('value must be an array');

  const roles = new Set<string>();
  const targetFields = new Set<string>();
  return value.map((item, index) => {
    if (
      !isRecord(item)
      || !hasExactKeys(item, PENDING_INPUT_KEYS)
      || (item.kind !== 'value' && item.kind !== 'visual')
      || typeof item.role !== 'string'
      || item.role.trim().length === 0
      || typeof item.label !== 'string'
      || item.label.trim().length === 0
      || typeof item.multiple !== 'boolean'
      || !Array.isArray(item.targets)
      || item.targets.length === 0
    ) {
      throw new PendingInputContractError(`item ${index + 1} is malformed`);
    }
    if (roles.has(item.role)) {
      throw new PendingInputContractError(`role ${item.role} is duplicated`);
    }
    roles.add(item.role);

    const targets = item.targets.map((target, targetIndex) => {
      if (
        !isRecord(target)
        || !hasExactKeys(target, PENDING_TARGET_KEYS)
        || typeof target.step_no !== 'number'
        || !Number.isInteger(target.step_no)
        || target.step_no < 1
        || typeof target.tool_id !== 'string'
        || target.tool_id.trim().length === 0
        || typeof target.field !== 'string'
        || target.field.trim().length === 0
        || typeof target.multiple !== 'boolean'
      ) {
        throw new PendingInputContractError(
          `item ${index + 1} target ${targetIndex + 1} is malformed`,
        );
      }
      const targetKey = `${target.step_no}\u0000${target.field}`;
      if (targetFields.has(targetKey)) {
        throw new PendingInputContractError(
          `target ${target.step_no}/${target.field} is duplicated`,
        );
      }
      targetFields.add(targetKey);
      return {
        step_no: target.step_no,
        tool_id: target.tool_id,
        field: target.field,
        multiple: target.multiple,
      };
    });

    return {
      kind: item.kind,
      role: item.role,
      label: item.label,
      multiple: item.multiple,
      targets,
    };
  });
}
