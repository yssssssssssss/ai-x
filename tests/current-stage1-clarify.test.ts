import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { ClarificationRequiredResponse } from '../apps/agent-api/src/routes/control-planning.ts';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const react = requireFromWeb('react') as {
  createElement(component: unknown, props: Record<string, unknown>): unknown;
};
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: unknown): string;
};
const componentModulePath: string = '../apps/web/src/components/stages/CurrentStage1Clarify.tsx';

interface ClarificationComponentModule {
  CurrentStage1Clarify(props: unknown): unknown;
}

async function loadClarificationComponent(): Promise<ClarificationComponentModule> {
  return await import(componentModulePath) as unknown as ClarificationComponentModule;
}

const response: ClarificationRequiredResponse = {
  kind: 'current',
  status: 'clarification_required',
  conversationId: 'conversation-scenario-selection',
  task: {
    id: 'task-scenario-selection',
    state: 'awaiting_clarification',
    stateVersion: 2,
    activePlanVersionId: null,
    currentAttemptId: null,
  },
  structuredTask: {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: '宠物业务',
    research_goal: '规划宠物业务用户研究',
    target_audience: ['产品团队'],
    scope: ['用户体验'],
    constraints: [],
    success_criteria: [],
    expected_deliverables: ['研究方案'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  },
  activatedNodes: [],
  candidates: [],
  planningGuidance: {
    reasonCode: 'scenario_selection_required',
    options: [{ id: 'user-journey-insight', label: '用户旅程与需求洞察' }],
  },
};

test('Scenario direction submission exposes candidate generation progress', async () => {
  const { CurrentStage1Clarify } = await loadClarificationComponent();
  const globals = globalThis as typeof globalThis & { React?: unknown };
  const previousReact = globals.React;
  globals.React = react;
  let markup: string;
  try {
    markup = renderToStaticMarkup(react.createElement(CurrentStage1Clarify, {
      response,
      onSubmit() {},
      disabled: true,
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /aria-busy="true"/u);
  assert.match(markup, /正在生成候选方案/u);
});

test('deliverable intent clarification renders business-language choices', async () => {
  const { CurrentStage1Clarify } = await loadClarificationComponent();
  const globals = globalThis as typeof globalThis & { React?: unknown };
  const previousReact = globals.React;
  globals.React = react;
  let markup: string;
  try {
    markup = renderToStaticMarkup(react.createElement(CurrentStage1Clarify, {
      response: {
        ...response,
        planningGuidance: undefined,
        structuredTask: {
          ...response.structuredTask,
          task_type: 'competitive_research',
          expected_deliverables: ['competitive_analysis_report'],
          clarification_questions: [{
            key: 'deliverable_intent',
            question: '你希望结果聚焦竞品对比，还是综合研究证据形成策略建议？',
            rationale: '两种结果会采用不同的专业能力和报告结构。',
          }],
        },
      },
      onSubmit() {},
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /竞品分析报告/u);
  assert.match(markup, /综合策略报告/u);
  assert.match(markup, /value="competitive_analysis_report"/u);
  assert.match(markup, /value="research_strategy_report"/u);
});
