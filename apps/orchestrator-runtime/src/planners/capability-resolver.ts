import type { PendingInput } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
import type { ToolManifest, ToolRegistryEntry } from '../runtime/config-loader.ts';
import type { CapabilitySkillRegistryEntry as LoadedCapabilitySkillRegistryEntry } from '../runtime/skill-loader.ts';

export type CapabilitySkillRegistryEntry = LoadedCapabilitySkillRegistryEntry;
export type CapabilityApprovalAuthority = Exclude<NonNullable<ToolManifest['approver_rule']>, 'none'>;
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

export interface CapabilityApproval {
  capability_type: 'skill' | 'tool';
  capability_id: string;
  authority: CapabilityApprovalAuthority;
}

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
  reasons: CapabilityDecisionReason[];
  pending_inputs: CapabilityPendingInput[];
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
        reasons: [{
          code: 'skill_inactive',
          message: `skill ${skillId} is ${skill.status}, not active`,
        }],
        pending_inputs: [],
      });
      continue;
    }

    const reasons: CapabilityDecisionReason[] = [];
    if (!skill.task_types.includes(input.task.task_type)) {
      reasons.push({
        code: 'task_type_mismatch',
        message: `skill ${skill.id} does not support task type ${input.task.task_type}`,
        related_id: input.task.task_type,
      });
    } else {
      for (const toolId of skill.required_tools) {
        reasons.push(...requiredToolRejections(
          toolId,
          toolsById,
          manifestsById,
          statesById,
          input.approval_capabilities,
        ));
      }
      if (
        skill.risk_level === 'high'
        && !input.approval_capabilities.some((approval) => (
          approval.capability_type === 'skill' && approval.capability_id === skill.id
        ))
      ) {
        reasons.push({
          code: 'approval_unavailable',
          message: `high-risk skill ${skill.id} has no approval capability`,
          related_id: skill.id,
        });
      }
    }

    const pendingInputs = skill.inputs
      .filter((role) => !availableInputs.has(role))
      .map((role): CapabilityPendingInput => ({
        role,
        label: role,
        multiple: false,
        capability_id: skill.id,
      }));
    if (reasons.length > 0) {
      rejected.push({ skill, reasons, pending_inputs: pendingInputs });
      continue;
    }
    if (pendingInputs.length > 0) {
      reasons.push({
        code: 'pending_input_required',
        message: `skill ${skill.id} requires ${pendingInputs.length} pending input role(s)`,
      });
    }
    reasons.push({ code: 'eligible', message: `skill ${skill.id} passed all capability filters` });
    eligible.push({ skill, reasons, pending_inputs: pendingInputs });
  }

  return { eligible, rejected };
}

export class CapabilityResolver {
  resolve(input: CapabilityResolveInput): CapabilityResolution {
    return resolveCapabilities(input);
  }
}
