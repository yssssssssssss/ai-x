import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { PlanProgress } from '../packages/api-contract/plan.ts';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const react = requireFromWeb('react') as {
  createElement(component: unknown, props: Record<string, unknown>): unknown;
};
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: unknown): string;
};
const componentModulePath: string = '../apps/web/src/components/PlanningProgressCard.tsx';

test('clarification planning exposes real progress and a loader only on the active phase', async () => {
  const { PlanProgressCard } = await import(componentModulePath) as {
    PlanProgressCard(props: unknown): unknown;
  };
  const progress: PlanProgress[] = [
    { phase: 'understand', status: 'done', label: '确认研究方向', detail: '用户旅程与需求洞察' },
    { phase: 'activate', status: 'done', label: '激活决策节点' },
    { phase: 'guidance', status: 'done', label: '召回方法论知识' },
    { phase: 'states', status: 'start', label: '判定节点状态' },
  ];
  const globals = globalThis as typeof globalThis & { React?: unknown };
  const previousReact = globals.React;
  globals.React = react;
  let markup: string;
  try {
    markup = renderToStaticMarkup(react.createElement(PlanProgressCard, {
      steps: progress,
      variant: 'clarification',
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }

  assert.match(markup, /aria-busy="true"/u);
  assert.match(markup, /AI 规划中/u);
  assert.match(markup, /3\/6 步完成/u);
  assert.match(markup, /已确认研究方向/u);
  assert.match(markup, /构建问题与证据框架/u);
  assert.match(markup, /plan-progress-step-active" data-phase="states"/u);
  assert.match(
    markup,
    /plan-progress-node plan-progress-node-active[^>]*><span class="plan-progress-node-loader"><\/span><\/span>/u,
  );
  assert.equal((markup.match(/plan-progress-node-loader/gu) ?? []).length, 1);
});
