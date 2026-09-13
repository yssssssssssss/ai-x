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

test('renders required visual Material requests and preserves already uploaded files', async () => {
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
        taskMaterials: [{
          materialId: 'material-1', requestId: 'target-design', role: 'designImage', fileName: 'page.png',
          mediaType: 'image/png', contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68, state: 'SEALED',
        }],
        structuredTask: {
          ...response.structuredTask,
          task_type: 'design_audit',
          expected_deliverables: ['design_audit_report'],
          material_requests: [{
            id: 'target-design', role: 'designImage', kind: 'visual', label: '目标页面截图',
            required: true, multiple: false, reason: '用于设计问题标注',
          }],
        },
      },
      materials: [{
        materialId: 'material-1', requestId: 'target-design', role: 'designImage', fileName: 'page.png',
        mediaType: 'image/png', contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68, state: 'SEALED',
      }],
      onUploadMaterial: async () => undefined,
      onSubmit() {},
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /所需材料/u);
  assert.match(markup, /目标页面截图/u);
  assert.match(markup, /page\.png/u);
  assert.match(markup, /已提供/u);
  assert.match(markup, /accept="image\/png,image\/jpeg,image\/webp"/u);
});

test('hydrates selected Materials from stored bindings instead of every uploaded Artifact', async () => {
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
        taskMaterials: [{
          materialId: 'selected-1', requestId: 'screens', role: 'screens', fileName: 'selected.png',
          mediaType: 'image/png', contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68, state: 'SEALED',
        }, {
          materialId: 'available-2', requestId: 'screens', role: 'screens', fileName: 'removed.png',
          mediaType: 'image/png', contentSha256: `sha256:${'2'.repeat(64)}`, byteSize: 68, state: 'SEALED',
        }],
        materialBindings: [{ requestId: 'screens', materialIds: ['selected-1'] }],
        structuredTask: {
          ...response.structuredTask,
          material_requests: [{
            id: 'screens', role: 'screens', kind: 'visual', label: '页面截图',
            required: false, multiple: true, reason: '可选截图',
          }],
        },
      },
      onUploadMaterial: async () => undefined,
      onSubmit() {},
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /selected\.png/u);
  assert.doesNotMatch(markup, /removed\.png/u);
});

test('renders dynamic grouped and explicit paired controls for two multi-image requests', async () => {
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
        taskMaterials: [
          {
            materialId: 'ours-1', requestId: 'ours', role: 'primaryScreens', fileName: 'ours-one.png',
            mediaType: 'image/png', contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68, state: 'SEALED',
          },
          {
            materialId: 'theirs-1', requestId: 'theirs', role: 'comparisonScreens', fileName: 'theirs-one.png',
            mediaType: 'image/png', contentSha256: `sha256:${'2'.repeat(64)}`, byteSize: 68, state: 'SEALED',
          },
        ],
        structuredTask: {
          ...response.structuredTask,
          task_type: 'competitive_research',
          expected_deliverables: ['competitive_analysis_report'],
          material_requests: [
            { id: 'ours', role: 'primaryScreens', kind: 'visual', label: '我方截图', required: true, multiple: true, reason: '对比' },
            { id: 'theirs', role: 'comparisonScreens', kind: 'visual', label: '竞品截图', required: true, multiple: true, reason: '对比' },
          ],
        },
      },
      onUploadMaterial: async () => undefined,
      onSubmit() {},
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /图片对比方式/u);
  assert.match(markup, /checked="" value="grouped"/u);
  assert.match(markup, /value="paired"/u);
  assert.match(markup, /不推断一一对应关系/u);
});

test('renders stored explicit image pairs with both material selections', async () => {
  const { CurrentStage1Clarify } = await loadClarificationComponent();
  const globals = globalThis as typeof globalThis & { React?: unknown };
  const previousReact = globals.React;
  globals.React = react;
  let markup: string;
  const taskMaterials = [{
    materialId: 'ours-1', requestId: 'ours', role: 'primaryScreens', fileName: 'ours-one.png',
    mediaType: 'image/png' as const, contentSha256: `sha256:${'1'.repeat(64)}`, byteSize: 68, state: 'SEALED' as const,
  }, {
    materialId: 'theirs-1', requestId: 'theirs', role: 'comparisonScreens', fileName: 'theirs-one.png',
    mediaType: 'image/png' as const, contentSha256: `sha256:${'2'.repeat(64)}`, byteSize: 68, state: 'SEALED' as const,
  }];
  try {
    markup = renderToStaticMarkup(react.createElement(CurrentStage1Clarify, {
      response: {
        ...response,
        planningGuidance: undefined,
        taskMaterials,
        materialComparison: {
          mode: 'paired', primaryRequestId: 'ours', comparisonRequestId: 'theirs',
          pairs: [{ label: '首屏', primaryMaterialId: 'ours-1', comparisonMaterialId: 'theirs-1' }],
        },
        structuredTask: {
          ...response.structuredTask,
          task_type: 'competitive_research',
          expected_deliverables: ['competitive_analysis_report'],
          material_requests: [
            { id: 'ours', role: 'primaryScreens', kind: 'visual', label: '我方截图', required: true, multiple: true, reason: '对比' },
            { id: 'theirs', role: 'comparisonScreens', kind: 'visual', label: '竞品截图', required: true, multiple: true, reason: '对比' },
          ],
        },
      },
      materials: taskMaterials,
      onUploadMaterial: async () => undefined,
      onSubmit() {},
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /checked="" value="paired"/u);
  assert.match(markup, /aria-label="对比项 1 场景名称" value="首屏"/u);
  assert.match(markup, /ours-one\.png/u);
  assert.match(markup, /theirs-one\.png/u);
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
