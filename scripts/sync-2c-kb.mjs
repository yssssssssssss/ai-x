#!/usr/bin/env node
// KB 与 2C-DesignWiki 源差异检查(方案 §2.3 · 修正版)
//
// 背景:项目 knowledge-base/skills/*/SKILL.md 是 2C 源的**派生+增强版本**,
// indexer 会给每个 SKILL 加上 id/source/content_hash/guide_tags/task_types 等召回用 frontmatter。
// 盲 rsync 覆盖会碾掉这些字段(实测 diff 减 3715 行)。
//
// 所以本脚本**只报告差异,不做修改**。定期跑,人肉判断 2C 有没有新增/更新内容值得吸收。
//
// 用法: node scripts/sync-2c-kb.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const projectRoot = resolve(new URL('..', import.meta.url).pathname);
const src = resolve(projectRoot, 'references/2C-DesignWiki/jd-design-system-md-v16/horizontal/user-research');
const dst = resolve(projectRoot, 'knowledge-base');

if (!existsSync(src)) {
  console.error(`✗ 源目录不存在: ${src}`);
  process.exit(2);
}

const areas = ['methods', 'models', 'assets', 'skills'];

// 递归收集所有 .md 文件的相对路径
function walk(root, area) {
  const out = new Set();
  const base = join(root, area);
  if (!existsSync(base)) return out;
  const stack = [base];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name.endsWith('.md')) out.add(relative(base, p));
    }
  }
  return out;
}

let sourceOnly = 0, dstOnly = 0, common = 0;
console.log(`[sync-2c-kb · diff 模式] ${src} vs ${dst}\n`);

for (const area of areas) {
  const srcFiles = walk(src, area);
  const dstFiles = walk(dst, area);
  const onlyInSrc = [...srcFiles].filter((f) => !dstFiles.has(f));
  const onlyInDst = [...dstFiles].filter((f) => !srcFiles.has(f));
  const shared = [...srcFiles].filter((f) => dstFiles.has(f));

  console.log(`### ${area}/`);
  console.log(`  · 源=${srcFiles.size} · 项目=${dstFiles.size} · 共有=${shared.length}`);
  if (onlyInSrc.length) {
    console.log(`  · 仅源有(2C 新增,可考虑吸收): ${onlyInSrc.length}`);
    for (const f of onlyInSrc.slice(0, 8)) console.log(`    + ${f}`);
    if (onlyInSrc.length > 8) console.log(`    ... 还有 ${onlyInSrc.length - 8} 个`);
  }
  if (onlyInDst.length) {
    console.log(`  · 仅项目有(项目独有,不动): ${onlyInDst.length}`);
    for (const f of onlyInDst.slice(0, 5)) console.log(`    - ${f}`);
  }
  sourceOnly += onlyInSrc.length;
  dstOnly += onlyInDst.length;
  common += shared.length;
  console.log('');
}

console.log('---');
console.log(`汇总: 源独有=${sourceOnly} · 项目独有=${dstOnly} · 共有=${common}`);
console.log('');
console.log('说明:');
console.log('  - 项目 KB 的 SKILL.md 由 indexer 增补 frontmatter(id/source/content_hash/guide_tags),');
console.log('    盲 rsync 覆盖会碾掉这些字段。本脚本只报告差异,不写入。');
console.log('  - 要吸收 2C 新增的方法/skill,请手工 cp 单个文件到 knowledge-base/,再跑 indexer 补 frontmatter。');
