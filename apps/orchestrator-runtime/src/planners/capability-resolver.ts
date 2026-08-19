import type {
  CurrentCapabilityApproval,
  CurrentOptionalToolDecision,
  PendingInput,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { ToolManifest, ToolRegistryEntry } from '../runtime/config-loader.ts';
import type { CapabilitySkillRegistryEntry as LoadedCapabilitySkillRegistryEntry } from '../runtime/skill-loader.ts';

export type CapabilitySkillRegistryEntry = LoadedCapabilitySkillRegistryEntry;
export type CapabilityApprovalAuthority = CurrentCapabilityApproval['authority'];
export type CapabilityReasonCode =
  | 'skill_inactive'
  | 'task_type_mismatch'
  | 'required_tool_missing'
  | 'required_tool_inactive'
  | 'required_tool_health_unknown'
  | 'required_tool_unhealthy'
  | 'core_tool_real_adapter_unavailable'
  | 'approval_unavailable'
  | 'pending_input_required'
  | 'eligible';

export interface CapabilityToolState {
  tool_id: string;
  health: 'healthy' | 'unhealthy';
  real_adapter_qualified: boolean;
}

export type CapabilityApproval = CurrentCapabilityApproval;

export type CapabilityPendingInput = Omit<PendingInput, 'targets'> & {
  capability_id: string;
};

export interface CapabilityDecisionReason {
  code: CapabilityReasonCode;
  message: string;
  related_id?: string;
}

export interface CapabilityDecision {
  skill: CapabilitySkillRegistryEntry;
  required_approvals: CapabilityApproval[];
  reasons: CapabilityDecisionReason[];
  pending_inputs: CapabilityPendingInput[];
  optional_tool_decisions: CurrentOptionalToolDecision[];
}

export interface CapabilityResolveInput {
  task: ResearchTaskV2;
  available_input_roles: readonly string[];
  skills: readonly CapabilitySkillRegistryEntry[];
  tools: readonly ToolRegistryEntry[];
  tool_states: readonly CapabilityToolState[];
  tool_manifests: readonly ToolManifest[];
  approval_capabilities: readonly CapabilityApproval[];
}

export interface CapabilityResolution {
  eligible: CapabilityDecision[];
  rejected: CapabilityDecision[];
}

const APPROVAL_AUTHORITY_RANK: Record<CapabilityApprovalAuthority, number> = {
  owner: 0,
  legal: 1,
  security: 2,
};

function selectSkillApproval(
  skillId: string,
  approvals: readonly CapabilityApproval[],
): CapabilityApproval | undefined {
  const approval = approvals
    .filter((candidate) => (
      candidate.capability_type === 'skill' && candidate.capability_id === skillId
    ))
    .sort((left, right) => (
      APPROVAL_AUTHORITY_RANK[left.authority] - APPROVAL_AUTHORITY_RANK[right.authority]
    ))[0];
  return approval ? { ...approval } : undefined;
}

function requiredToolApproval(
  toolId: string,
  toolsById: ReadonlyMap<string, ToolRegistryEntry>,
  manifestsById: ReadonlyMap<string, ToolManifest>,
  approvals: readonly CapabilityApproval[],
): CapabilityApproval | undefined {
  if (toolsById.get(toolId)?.risk_level !== 'high') return undefined;
  const authority = manifestsById.get(toolId)?.approver_rule;
  if (!authority || authority === 'none') return undefined;
  const approval = approvals.find((candidate) => (
    candidate.capability_type === 'tool'
    && candidate.capability_id === toolId
    && candidate.authority === authority
  ));
  return approval ? { ...approval } : undefined;
}

function requiredToolRejections(
  toolId: string,
  toolsById: ReadonlyMap<string, ToolRegistryEntry>,
  manifestsById: ReadonlyMap<string, ToolManifest>,
  statesById: ReadonlyMap<string, CapabilityToolState>,
  approvals: readonly CapabilityApproval[],
): CapabilityDecisionReason[] {
  const tool = toolsById.get(toolId);
  if (!tool) {
    return [{
      code: 'required_tool_missing',
      message: `required tool ${toolId} is not registered`,
      related_id: toolId,
    }];
  }
  if (tool.status !== 'active') {
    return [{
      code: 'required_tool_inactive',
      message: `required tool ${toolId} is ${tool.status}, not active`,
      related_id: toolId,
    }];
  }

  const state = statesById.get(toolId);
  if (!state) {
    return [{
      code: 'required_tool_health_unknown',
      message: `required tool ${toolId} has no health qualification`,
      related_id: toolId,
    }];
  }
  if (state.health !== 'healthy') {
    return [{
      code: 'required_tool_unhealthy',
      message: `required tool ${toolId} is unhealthy`,
      related_id: toolId,
    }];
  }

  const reasons: CapabilityDecisionReason[] = [];
  if (tool.tier === 'core' && !state.real_adapter_qualified) {
    reasons.push({
      code: 'core_tool_real_adapter_unavailable',
      message: `core tool ${toolId} has no qualified real adapter`,
      related_id: toolId,
    });
  }
  if (tool.risk_level === 'high') {
    const requiredAuthority = manifestsById.get(toolId)?.approver_rule;
    const approvalAvailable = requiredAuthority !== undefined
      && requiredAuthority !== 'none'
      && approvals.some((approval) => (
        approval.capability_type === 'tool'
        && approval.capability_id === toolId
        && approval.authority === requiredAuthority
      ));
    if (!approvalAvailable) {
      reasons.push({
        code: 'approval_unavailable',
        message: `high-risk tool ${toolId} has no matching approval capability`,
        related_id: toolId,
      });
    }
  }
  return reasons;
}

function optionalToolDecisions(
  skill: CapabilitySkillRegistryEntry,
  toolsById: ReadonlyMap<string, ToolRegistryEntry>,
  statesById: ReadonlyMap<string, CapabilityToolState>,
): CurrentOptionalToolDecision[] {
  return skill.optional_tools.flatMap((toolId): CurrentOptionalToolDecision[] => {
    const tool = toolsById.get(toolId);
    if (!tool || tool.status !== 'active') return [];
    if (tool.tier !== 'optional') {
      throw new Error(`optional tool ${toolId} must use the optional tier`);
    }
    const state = statesById.get(toolId);
    if (!state) {
      return [{
        tool_id: toolId,
        status: 'unavailable',
        reason_code: 'optional_tool_health_unknown',
        message: `optional tool ${toolId} has no health qualification`,
      }];
    }
    if (state.health !== 'healthy') {
      return [{
        tool_id: toolId,
        status: 'unavailable',
        reason_code: 'optional_tool_unhealthy',
        message: `optional tool ${toolId} is unhealthy`,
      }];
    }
    if (!state.real_adapter_qualified) {
      return [{
        tool_id: toolId,
        status: 'unavailable',
        reason_code: 'optional_tool_real_adapter_unavailable',
        message: `optional tool ${toolId} has no qualified real adapter`,
      }];
    }
    return [{ tool_id: toolId, status: 'available' }];
  });
}

export function resolveCapabilities(input: CapabilityResolveInput): CapabilityResolution {
  const toolsById = new Map(input.tools.map((tool) => [tool.id, tool]));
  const manifestsById = new Map(input.tool_manifests.map((manifest) => [manifest.id, manifest]));
  const statesById = new Map(input.tool_states.map((state) => [state.tool_id, state]));
  const availableInputs = new Set(input.available_input_roles);
  const eligible: CapabilityDecision[] = [];
  const rejected: CapabilityDecision[] = [];

  for (const skill of input.skills) {
    if (skill.status !== 'active') {
      const skillId = skill.id ?? '(no-id)';
      rejected.push({
        skill,
        required_approvals: [],
        reasons: [{
          code: 'skill_inactive',
          message: `skill ${skillId} is ${skill.status}, not active`,
        }],
        pending_inputs: [],
        optional_tool_decisions: [],
      });
      continue;
    }

    const requiredApprovals: CapabilityApproval[] = [];
    const reasons: CapabilityDecisionReason[] = [];
    if (!skill.task_types.includes(input.task.task_type)) {
      reasons.push({
        code: 'task_type_mismatch',
        message: `skill ${skill.id} does not support task type ${input.task.task_type}`,
        related_id: input.task.task_type,
      });
    } else {
      if (skill.risk_level === 'high') {
        const approval = selectSkillApproval(skill.id, input.approval_capabilities);
        if (approval) {
          requiredApprovals.push(approval);
        } else {
          reasons.push({
            code: 'approval_unavailable',
            message: `high-risk skill ${skill.id} has no approval capability`,
            related_id: skill.id,
          });
        }
      }
      for (const toolId of skill.required_tools) {
        const toolReasons = requiredToolRejections(
          toolId,
          toolsById,
          manifestsById,
          statesById,
          input.approval_capabilities,
        );
        reasons.push(...toolReasons);
        if (toolReasons.length === 0) {
          const approval = requiredToolApproval(
            toolId,
            toolsById,
            manifestsById,
            input.approval_capabilities,
          );
          if (approval) requiredApprovals.push(approval);
        }
      }
    }

    const pendingInputs = skill.inputs
      .filter((role) => !availableInputs.has(role))
      .map((role): CapabilityPendingInput => ({
        kind: skill.visual_inputs?.includes(role) === true ? 'visual' : 'value',
        role,
        label: role,
        multiple: skill.multiple_visual_inputs?.includes(role) === true,
        capability_id: skill.id,
      }));
    if (reasons.length > 0) {
      rejected.push({
        skill,
        required_approvals: requiredApprovals,
        reasons,
        pending_inputs: pendingInputs,
        optional_tool_decisions: [],
      });
      continue;
    }
    if (pendingInputs.length > 0) {
      reasons.push({
        code: 'pending_input_required',
        message: `skill ${skill.id} requires ${pendingInputs.length} pending input role(s)`,
      });
    }
    reasons.push({ code: 'eligible', message: `skill ${skill.id} passed all capability filters` });
    eligible.push({
      skill,
      required_approvals: requiredApprovals,
      reasons,
      pending_inputs: pendingInputs,
      optional_tool_decisions: optionalToolDecisions(skill, toolsById, statesById),
    });
  }

  return { eligible, rejected };
}

export class CapabilityResolver {
  resolve(input: CapabilityResolveInput): CapabilityResolution {
    return resolveCapabilities(input);
  }
}
