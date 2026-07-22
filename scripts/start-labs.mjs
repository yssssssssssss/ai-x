#!/usr/bin/env node
// 一键拉起 external-tools 下 5 个工具的后端 + 前端(共 10 个进程)。
// 纯 node child_process,无新依赖。各工具是独立服务,不进主系统 pnpm 依赖。
//   node scripts/start-labs.mjs            # 起后端+前端
//   node scripts/start-labs.mjs --server   # 只起后端(编排/接口联调用)
//   node scripts/start-labs.mjs --web      # 只起前端
// Ctrl-C 一并退出所有子进程。
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const runServer = !args.includes('--web');
const runWeb = !args.includes('--server');
const selectedIds = args.find((arg) => arg.startsWith('--labs='))
  ?.slice('--labs='.length)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// 读主项目 .env 注入工具子进程——让工具用上 LLM 网关等配置(工具 server 只读 process.env,不自载 .env)。
// 工具自身若有独立 .env(工具 server 会 loadEnvFile 加载),优先级更高。
function loadRootEnv() {
  const p = join(root, '.env');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
const rootEnv = loadRootEnv();

// id / 后端口 / 前端口(与各工具 config/env.ts、package.json 的 vite --port 对应)。
const LABS = [
  { id: 'aesthetic-quant-lab', server: 8801, web: 5801 },
  { id: 'attention-analysis-lab', server: 8802, web: 5802 },
  { id: 'experience-model-lab', server: 8803, web: 5803 },
  { id: 'virtual-user-lab', server: 8804, web: 5804 },
  { id: 'vision-brand-lab', server: 8805, web: 5805 },
];
const labs = selectedIds?.length
  ? LABS.filter((lab) => selectedIds.includes(lab.id))
  : LABS;
if (selectedIds?.length) {
  const unknown = selectedIds.filter((id) => !LABS.some((lab) => lab.id === id));
  if (unknown.length) throw new Error(`未知实验室: ${unknown.join(', ')}`);
}

console.log('拉起 external-tools 工具(Ctrl-C 全部退出):');
for (const l of labs) {
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
  const child = spawn('npm', ['run', script], { cwd, stdio: 'inherit', env: { ...process.env, ...rootEnv } });
  child.on('error', (err) => console.error(`[${id} ${script}] 启动失败:`, err.message));
  children.push(child);
};

for (const l of labs) {
  if (runServer) launch(l.id, 'dev:server');
  if (runWeb) launch(l.id, 'dev:web');
}

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
