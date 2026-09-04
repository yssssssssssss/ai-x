import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const theme = new URL('../apps/web/src/theme.css', import.meta.url);
const workbench = new URL('../apps/web/src/pages/Workbench.tsx', import.meta.url);
const sidebar = new URL('../apps/web/src/components/Sidebar.tsx', import.meta.url);
const composer = new URL('../apps/web/src/components/Composer.tsx', import.meta.url);
const nativeFlow = new URL('../apps/web/src/components/SkillNativeTaskFlow.tsx', import.meta.url);
const nativeHook = new URL('../apps/web/src/hooks/useSkillNativeFlow.ts', import.meta.url);

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

test('new workbench tasks use the Skill-native API while both older task stores stay read-only', async () => {
  const source = await readFile(workbench, 'utf8');
  assert.match(source, /useSkillNativeFlow/u);
  assert.match(source, /api\.listResearchTasks\(\)/u);
  assert.match(source, /api\.listControlTasks\(\)/u);
  assert.match(source, /api\.controlTask\(task\.id\)/u);
  assert.match(source, /api\.taskDetail\(task\.id\)/u);
  assert.match(source, /<CurrentStage4Report[\s\S]*?readOnly/u);
  assert.doesNotMatch(source, /useTaskFlow/u);
});

test('new task timeline renders the native flow and keeps the composer outside the scroll chain', async () => {
  const source = await readFile(workbench, 'utf8');
  const timelineStart = source.indexOf('<div className="chat-column"');
  const timelineEnd = source.indexOf('<Composer', timelineStart);
  assert.ok(timelineStart >= 0 && timelineEnd > timelineStart, 'Skill-native task timeline must exist');
  const timeline = source.slice(timelineStart, timelineEnd);
  assert.match(timeline, /flow\.phase === 'idle'/u);
  assert.match(timeline, /<SkillNativeTaskFlow/u);
  assert.match(timeline, /phase=\{flow\.phase\}/u);
});

test('Skill-native task failures expose frozen-plan retry and explicit replan', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /phase === 'paused' \|\| phase === 'failed'/u);
  assert.match(source, /void onRetry\(\)/u);
  assert.match(source, /void onReplan\(\)/u);
  assert.match(source, /使用冻结 Plan 重试/u);
  assert.match(source, /phase === 'done'[\s\S]*?读取最新 Skill 定义重新规划/u);
});

test('Skill-native report iframe permits printing without enabling scripts', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /sandbox="allow-modals allow-same-origin"/u);
  assert.doesNotMatch(source, /allow-scripts/u);
});

test('automatic input bindings are visible and correctable before confirmation', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /已自动绑定，可在确认前纠正/u);
  assert.match(source, /\{input\.preview\}/u);
  assert.match(source, />纠正<\/button>/u);
  assert.match(source, /不使用，记为 Gap/u);
  assert.match(source, /Array\.isArray\(value\.value\)[\s\S]*?\.join\('\\n'\)/u);
});

test('replacement plans explain the fallback and require an explicit unavailable choice', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /失败或关键资料缺失时改用 \$\{skill\.replacementSkillName\}/u);
  assert.match(source, /requirement\.missingPolicy === 'replace' \? '无法提供，按方案替换 Skill'/u);
  assert.match(source, /question\.missingPolicy === 'replace' \? '无法提供，按方案替换 Skill'/u);
  assert.match(source, /event\.target\.checked \? null/u);
});

test('native async responses are fenced when the active task changes', async () => {
  const source = await readFile(nativeHook, 'utf8');
  assert.match(source, /const currentGeneration = generation\.current;/u);
  assert.match(source, /loadTask\(task\.id, currentGeneration, false\)/u);
  assert.doesNotMatch(source, /applyTask\([^;]+generation\.current\)/su);
  assert.match(source, /输入确认失败'[\s\S]*?loadTask\(currentTask\.id, currentGeneration, false\)/u);
  assert.match(source, /重新规划失败'[\s\S]*?loadTask\(currentTask\.id, currentGeneration, false\)/u);
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
