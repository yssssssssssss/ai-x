// 首次全量导入:整棵 wiki 副本拷进 knowledge-base/;.md 条目就地补 frontmatter,
// 其余文件(skeleton.md/scripts/*.py/images/*.png)忠实拷贝——它们是 skill 的组成部分。
// 用法: npm run kb:import
import { readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { normalizeEntry } from '../apps/orchestrator-runtime/src/knowledge/normalizer.ts';

const SRC = 'references/2C-DesignWiki/jd-design-system-md-v16/horizontal/user-research';
const DST = 'knowledge-base';

function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '.DS_Store') continue;
    const full = join(dir, n);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

let normalized = 0, copied = 0;
for (const full of walk(SRC)) {
  const rel = relative(SRC, full).split('\\').join('/');
  const dst = join(DST, rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (full.endsWith('.md')) {
    // 条目→归一补 frontmatter;非条目(导航/skeleton)→normalizeEntry 原样返回, 即忠实拷贝
    const { md } = normalizeEntry(rel, readFileSync(full, 'utf8'));
    writeFileSync(dst, md, 'utf8');
    normalized++;
  } else {
    copyFileSync(full, dst); // .py / .png 等二进制忠实拷贝
    copied++;
  }
}
console.log(`kb-import: 处理 md ${normalized}, 拷贝其它文件 ${copied}`);
