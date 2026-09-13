import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type { CurrentPlanCandidateProposal } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
import {
  resolveCapabilities,
  type CapabilityResolveInput,
  type CapabilitySkillRegistryEntry,
} from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import {
  providedMaterialCoverageIssues,
  seedProvidedMaterialSlots,
} from '../apps/orchestrator-runtime/src/planners/routed-planner.ts';
import { assertTaskMaterialsConsumed } from '../apps/orchestrator-runtime/src/control/control-planning-service.ts';
import { requiredApprovals } from '../apps/orchestrator-runtime/src/control/task-workflow.ts';

const materialRequests = [{
  id: 'mr-primary', role: 'jdDesignImage', kind: 'visual' as const,
  label: '京东截图', required: true, multiple: true, reason: '主方案视觉分析',
}, {
  id: 'mr-comparison', role: 'competitorDesignImage', kind: 'visual' as const,
  label: '竞品截图', required: true, multiple: true, reason: '竞品视觉对比',
}];

const task: ResearchTaskV2 = {
  version: 'research-task-v2', task_type: 'competitive_research', outcome_mode: 'answer',
  business_domain: 'commerce', research_goal: '比较京东与竞品商品详情页设计',
  target_audience: ['设计团队'], scope: ['商品详情页'], constraints: [],
  success_criteria: [{ id: 'visual-comparison', statement: '两组截图均进入分析' }],
  expected_deliverables: ['competitive_analysis_report'], assumptions: [], ambiguities: [],
  clarification_questions: [], material_requests: materialRequests, blocking_issues: [],
  sensitivity: 'internal', pii_detected: false,
};

const visualSkill: CapabilitySkillRegistryEntry = {
  id: 'competitive-app-analysis', name: '竞品视觉分析',
  path: 'skills/competitive-analysis/app-analysis/SKILL.md',
  when_to_use: '比较主方案与竞品截图', owner: '竞品分析组', status: 'active',
  task_types: ['competitive_research'],
  inputs: ['research_goal', 'competitorDesignImage'],
  visual_inputs: ['jdDesignImage', 'competitorDesignImage'],
  multiple_visual_inputs: ['jdDesignImage', 'competitorDesignImage'],
  outputs: ['competitive_analysis'], required_tools: [], optional_tools: [], risk_level: 'low',
  composition: {
    modes: ['standalone'], supported_outcomes: ['answer'],
    compatible_deliverables: ['competitive_analysis_report'],
    required_input_roles: ['research_goal', 'competitorDesignImage'],
    optional_input_roles: ['jdDesignImage'],
    standalone_reason: '双组截图由同一个视觉 Skill 对比。',
  },
};

function resolutionInput(): CapabilityResolveInput {
  return {
    task,
    available_input_roles: ['research_goal'],
    provided_material_roles: ['jdDesignImage', 'competitorDesignImage'],
    skills: [visualSkill], tools: [], tool_states: [], tool_manifests: [], approval_capabilities: [],
  };
}

test('verified optional visual Material remains a PendingInput obligation for Plan binding', () => {
  const resolution = resolveCapabilities(resolutionInput());

  assert.equal(resolution.rejected.length, 0);
  assert.deepEqual(
    resolution.eligible[0]?.pending_inputs.map(({ kind, role, multiple }) => ({ kind, role, multiple })),
    [
      { kind: 'visual', role: 'competitorDesignImage', multiple: true },
      { kind: 'visual', role: 'jdDesignImage', multiple: true },
    ],
  );
});

test('candidate material coverage rejects a text-only Skill and accepts the visual consumer', () => {
  const capabilityResolution = resolveCapabilities(resolutionInput());
  const candidate = (actorId: string): Pick<CurrentPlanCandidateProposal, 'id' | 'steps'> => ({
    id: 'depth',
    steps: [{ actor_type: 'skill', actor_id: actorId } as CurrentPlanCandidateProposal['steps'][number]],
  });

  assert.deepEqual(providedMaterialCoverageIssues({
    candidate: candidate('competitive-web-research'),
    providedMaterialRoles: materialRequests.map(({ role }) => role),
    capabilityResolution,
  }), [
    'depth: provided_material_unconsumed: jdDesignImage',
    'depth: provided_material_unconsumed: competitorDesignImage',
  ]);
  assert.deepEqual(providedMaterialCoverageIssues({
    candidate: candidate('competitive-app-analysis'),
    providedMaterialRoles: materialRequests.map(({ role }) => role),
    capabilityResolution,
  }), []);
});

test('Planner deterministically seeds provided visual slots into the selected Skill and Tool', () => {
  const capabilityResolution = resolveCapabilities(resolutionInput());
  capabilityResolution.eligible[0]!.skill.required_tools = ['visual-analysis-suite'];
  const seeded = seedProvidedMaterialSlots({
    candidate: {
      id: 'depth', title: '视觉对比', rationale: '使用已提供图片', tradeoffs: '增加视觉处理时间',
      assumptions: [],
      steps: [{
        step_no: 1, step_name: '视觉分析', actor_type: 'tool', actor_id: 'visual-analysis-suite',
        question_ids: [], depends_on: [], input: {}, input_bindings: [], expected_outputs: [],
        acceptance_criteria: [], requires_approval: false, fallback_actor_ids: [],
      }, {
        step_no: 2, step_name: '竞品分析', actor_type: 'skill', actor_id: 'competitive-app-analysis',
        question_ids: [], depends_on: [1], input: {}, input_bindings: [], expected_outputs: [],
        acceptance_criteria: [], requires_approval: false, fallback_actor_ids: [],
      }],
    },
    providedMaterialRoles: materialRequests.map(({ role }) => role),
    capabilityResolution,
  });

  assert.deepEqual(seeded.steps[0]?.input, {
    competitorDesignImage: [],
    jdDesignImage: [],
  });
  assert.deepEqual(seeded.steps[1]?.input, {
    competitorDesignImage: [],
    jdDesignImage: [],
  });
});

test('candidate persistence rejects provided Task Materials without matching visual PendingInputs', () => {
  const providedMaterials = [{
    role: 'jdDesignImage', materialIds: ['jd-1', 'jd-2'], fileNames: ['jd-1.png', 'jd-2.png'],
  }, {
    role: 'competitorDesignImage', materialIds: ['cmp-1', 'cmp-2'], fileNames: ['cmp-1.png', 'cmp-2.png'],
  }];

  assert.throws(() => assertTaskMaterialsConsumed({
    materialRequests,
    providedMaterials,
    pendingInputs: [],
  }), /does not consume provided Task Material jdDesignImage/u);

  assert.doesNotThrow(() => assertTaskMaterialsConsumed({
    materialRequests,
    providedMaterials,
    pendingInputs: materialRequests.map((request, index) => ({
      kind: 'visual' as const,
      role: request.role,
      label: request.label,
      multiple: request.multiple,
      targets: [{ step_no: index + 1, tool_id: 'visual-analysis-suite', field: request.role, multiple: true }],
    })),
  }));
});

test('satisfied material availability is enforced by input gates rather than approval gates', () => {
  for (const kind of ['missing_material', 'missing_required_material', 'material']) {
    const approvals = requiredApprovals({
      structuredTask: {
        material_requests: materialRequests,
        blocking_issues: [{
          key: 'missing_visual_materials', kind, reason: 'screenshots were initially missing',
        }],
      },
    } as never, { plan: { steps: [] } } as never);

    assert.deepEqual(approvals, [], kind);
  }
});
