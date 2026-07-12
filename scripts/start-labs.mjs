#!/usr/bin/env node
// 一键拉起 external-tools 下 5 个工具的后端 + 前端(共 10 个进程)。
// 纯 node child_process,无新依赖。各工具是独立服务,不进主系统 pnpm 依赖。
//   node scripts/start-labs.mjs            # 起后端+前端
//   node scripts/start-labs.mjs --server   # 只起后端(编排/接口联调用)
//   node scripts/start-labs.mjs --web      # 只起前端
// Ctrl-C 一并退出所有子进程。
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const runServer = arg !== '--web';
const runWeb = arg !== '--server';

// id / 后端口 / 前端口(与各工具 config/env.ts、package.json 的 vite --port 对应)。
const LABS = [
  { id: 'aesthetic-quant-lab', server: 8801, web: 5801 },
  { id: 'attention-analysis-lab', server: 8802, web: 5802 },
  { id: 'experience-model-lab', server: 8803, web: 5803 },
  { id: 'virtual-user-lab', server: 8804, web: 5804 },
  { id: 'vision-brand-lab', server: 8805, web: 5805 },
];

console.log('拉起 external-tools 工具(Ctrl-C 全部退出):');
for (const l of LABS) {
  console.log(
    `  ${l.id.padEnd(24)} ` +
      (runServer ? `后端 http://127.0.0.1:${l.server}  ` : '') +
      (runWeb ? `前端 http://127.0.0.1:${l.web}` : ''),
  );
}
console.log('');

const children = [];
const launch = (id, script) => {
  const cwd = resolve(root, 'external-tools', id);
  const child = spawn('npm', ['run', script], { cwd, stdio: 'inherit', env: process.env });
  child.on('error', (err) => console.error(`[${id} ${script}] 启动失败:`, err.message));
  children.push(child);
};

for (const l of LABS) {
  if (runServer) launch(l.id, 'dev:server');
  if (runWeb) launch(l.id, 'dev:web');
}

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
