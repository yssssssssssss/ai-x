import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const theme = new URL('../apps/web/src/theme.css', import.meta.url);
const workbench = new URL('../apps/web/src/pages/Workbench.tsx', import.meta.url);
const sidebar = new URL('../apps/web/src/components/Sidebar.tsx', import.meta.url);
const composer = new URL('../apps/web/src/components/Composer.tsx', import.meta.url);

test('workbench has one contained scroll chain and a non-scrolling bottom composer', async () => {
  const [css, workbenchSource, composerSource] = await Promise.all([
    readFile(theme, 'utf8'),
    readFile(workbench, 'utf8'),
    readFile(composer, 'utf8'),
  ]);

  assert.match(css, /\.workbench\s*\{[^}]*position:\s*fixed[^}]*overflow:\s*hidden/su);
  assert.match(css, /\.workbench-main\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
  assert.match(css, /\.workbench-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior-y:\s*contain/su);
  assert.match(css, /\.composer\s*\{[^}]*flex:\s*0 0 auto/su);
  assert.doesNotMatch(workbenchSource, /overflowY:\s*'auto'/u);
  assert.match(workbenchSource, /className="workbench-scroll"/u);
  assert.match(composerSource, /className="composer"/u);
});

test('sidebar exposes four status tabs and persistent item management actions', async () => {
  const source = await readFile(sidebar, 'utf8');

  for (const label of ['待处理', '进行中', '已完成', '失败']) assert.match(source, new RegExp(label));
  assert.match(source, /role="tablist"/u);
  assert.match(source, /aria-haspopup="menu"/u);
  assert.match(source, /置顶/u);
  assert.match(source, /重命名/u);
  assert.match(source, /确认删除/u);
  assert.match(source, /hidden:\s*true/u);
  assert.match(source, /ArrowLeft/u);
  assert.match(source, /ArrowRight/u);
});
