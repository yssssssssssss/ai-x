import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const react = requireFromWeb('react') as {
  createElement(component: unknown, props: Record<string, unknown>): unknown;
};
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: unknown): string;
};

const composerModulePath: string = '../apps/web/src/components/Composer.tsx';

interface ComposerModule {
  Composer(props: unknown): unknown;
}

async function renderComposer(multiSkillEnabled: boolean): Promise<string> {
  const { Composer } = await import(composerModulePath) as unknown as ComposerModule;
  const globals = globalThis as typeof globalThis & { React?: unknown };
  const previousReact = globals.React;
  globals.React = react;
  try {
    return renderToStaticMarkup(react.createElement(Composer, {
      disabled: false,
      multiSkillEnabled,
      onSubmit() {},
    }));
  } finally {
    if (previousReact === undefined) delete globals.React;
    else globals.React = previousReact;
  }
}

test('Composer defaults to single Skill and exposes the two task modes', async () => {
  const markup = await renderComposer(true);

  assert.match(markup, /运行模式/u);
  assert.match(markup, /单 Skill/u);
  assert.match(markup, /多 Skill 协作/u);
  assert.match(markup, /name="orchestration-mode" checked="" value="single_skill"/u);
  assert.match(markup, /name="orchestration-mode" value="multi_skill"/u);
});

test('Composer disables multi Skill when the server capability is closed', async () => {
  const markup = await renderComposer(false);

  assert.match(markup, /disabled="" value="multi_skill"/u);
  assert.match(markup, /当前环境尚未开放多 Skill 协作/u);
});
