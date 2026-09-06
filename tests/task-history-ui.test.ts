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

test('workbench history uses only the Skill-native task API', async () => {
  const source = await readFile(workbench, 'utf8');
  assert.match(source, /useSkillNativeFlow/u);
  assert.match(source, /api\.listResearchTasks\(\)/u);
  assert.doesNotMatch(source, /listControlTasks|controlTask|taskDetail|CurrentStage4Report/u);
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
  assert.match(source, /phase === 'paused' && task\.pendingQuestions\.length > 0/u);
  assert.match(source, /phase === 'paused' && !asksRuntimeQuestions\) \|\| phase === 'failed'/u);
  assert.match(source, /void onRetry\(\)/u);
  assert.match(source, /void onReplan\(\)/u);
  assert.match(source, />恢复</u);
  assert.match(source, /phase === 'done'[\s\S]*?读取最新 Skill 包重新规划/u);
});

test('Skill-native report iframe permits printing without enabling scripts', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /sandbox="allow-modals"/u);
  assert.doesNotMatch(source, /allow-same-origin/u);
  assert.doesNotMatch(source, /allow-scripts/u);
});

test('runtime questions support text, choice, and file answers', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /question\.answerType === 'choice'/u);
  assert.match(source, /question\.answerType === 'file'/u);
  assert.match(source, /type="file"/u);
  assert.match(source, /source: 'upload'/u);
  assert.match(source, /fileDataUrl/u);
});

test('plan confirmation freezes whole Skill packages without fixed input forms', async () => {
  const source = await readFile(nativeFlow, 'utf8');
  assert.match(source, /确认后会冻结这些 Skill 包的全部文件/u);
  assert.match(source, /Skill 私有问题将在执行到对应步骤时再询问/u);
  assert.doesNotMatch(source, /replacementSkillName|missingPolicy/u);
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
