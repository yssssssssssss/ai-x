import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevStackController } from '../scripts/dev-stack.ts';
import type { DevStackConfig, DevStackController } from '../scripts/dev-stack.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  server.close();
  await once(server, 'close');
  return port;
}

function writeHttpFixture(dir: string): string {
  const fixture = join(dir, 'dev-stack-http-service.mjs');
  writeFileSync(fixture, [
    "import { appendFileSync } from 'node:fs';",
    "import { createServer } from 'node:http';",
    "const port = Number(process.argv[2]);",
    "const name = process.argv[3] || 'service';",
    "const events = process.argv[4];",
    "const silent = process.argv[5] === 'silent';",
    "if (events) appendFileSync(events, name + '-start\\n');",
    "const server = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });",
    "server.listen(port, '127.0.0.1', () => {",
    "  if (events) appendFileSync(events, name + '-ready\\n');",
    "  if (!silent) console.log('READY:' + name);",
    "});",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n'));
  return fixture;
}

function writeStubbornGroupFixture(dir: string): string {
  const child = join(dir, 'dev-stack-stubborn-child.mjs');
  const parent = join(dir, 'dev-stack-stubborn-parent.mjs');
  writeFileSync(child, [
    "import { createServer } from 'node:http';",
    "const port = Number(process.argv[2]);",
    "const server = createServer((_req, res) => res.end('child'));",
    "server.listen(port, '127.0.0.1', () => console.log('READY:stubborn'));",
    "process.on('SIGTERM', () => {});",
  ].join('\n'));
  writeFileSync(parent, [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'inherit' });",
    "child.on('error', (error) => { console.error(error); process.exit(1); });",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('\n'));
  return parent;
}

function psValue(pid: number, field: 'pgid' | 'lstart' | 'command'): string {
  const result = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  return result.stdout.trim();
}

function pidsByCommandFragment(fragment: string): number[] {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const pids: number[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match?.[1] && match[2]?.includes(fragment)) pids.push(Number(match[1]));
  }
  return pids;
}

function stateService(name: string, pid: number, marker: string, port: number) {
  return {
    name,
    pid,
    pgid: Number(psValue(pid, 'pgid')),
    processStartedAt: psValue(pid, 'lstart'),
    command: psValue(pid, 'command'),
    marker,
    port,
  };
}

async function fixtureConfig(dir: string): Promise<DevStackConfig> {
  const fixture = writeHttpFixture(dir);
  const events = join(dir, 'events.log');
  const apiPort = await freePort();
  const webPort = await freePort();
  const lockPort = await freePort();
  return {
    root,
    stateDir: join(dir, '.pids'),
    lockPort,
    migration: {
      command: process.execPath,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(events)}, 'migration\\n')`],
      cwd: root,
    },
    services: [
      { name: 'api', command: process.execPath, args: [fixture, String(apiPort), 'api', events], cwd: dir, port: apiPort, marker: fixture, readyPattern: 'READY:api' },
      { name: 'web', command: process.execPath, args: [fixture, String(webPort), 'web', events], cwd: dir, port: webPort, marker: fixture, readyPattern: 'READY:web' },
    ],
    readinessTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    logger: () => {},
  };
}

const root = process.cwd();
const script = join(root, 'scripts', 'dev-stack.ts');

test('dev:stack 拒绝未知 action，并输出统一用法', () => {
  const result = spawnSync('pnpm', ['exec', 'tsx', script, 'unknown'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /用法: pnpm dev:stack <start\|restart\|stop>/);
});

test('controller 按顺序 start、幂等 start、restart、stop 两个服务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-'));
  const config = await fixtureConfig(dir);
  const controller = createDevStackController(config);
  const eventsFile = join(dir, 'events.log');
  const expectedCycle = ['migration', 'api-start', 'api-ready', 'web-start', 'web-ready'];
  try {
    const started = await controller.start();
    assert.equal(started.status, 'started');
    assert.equal(started.pids.length, 2);
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split('\n'), expectedCycle);

    const duplicate = await controller.start();
    assert.equal(duplicate.status, 'already-running');
    assert.deepEqual(duplicate.pids, started.pids);
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split('\n'), expectedCycle, '重复 start 不得重新迁移或拉进程');

    const restarted = await controller.restart();
    assert.equal(restarted.status, 'started');
    assert.equal(restarted.pids.length, 2);
    assert.notDeepEqual(restarted.pids, started.pids);
    assert.deepEqual(
      readFileSync(eventsFile, 'utf8').trim().split('\n'),
      [...expectedCycle, ...expectedCycle],
      'restart 必须完整执行 stop → migration → API ready → Web ready',
    );

    const stopped = await controller.stop();
    assert.equal(stopped.status, 'stopped');
    assert.equal(existsSync(join(config.stateDir, 'dev-stack.json')), false);
  } finally {
    await controller.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('受管 PID 存活但目标端口未就绪时重新拉起，而非误报 already-running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-unhealthy-'));
  const base = await fixtureConfig(dir);
  const service = base.services[0];
  assert.ok(service);
  const fixture = service.args[0];
  assert.ok(fixture);
  const wrongPort = await freePort();
  const events = join(dir, 'events.log');
  const idle = spawn(process.execPath, [fixture, String(wrongPort), 'api', events], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
  });
  await once(idle, 'spawn');
  assert.ok(idle.pid);
  idle.unref();

  const config: DevStackConfig = { ...base, services: [service] };
  const controller = createDevStackController(config);
  writeFileSync(join(config.stateDir, 'dev-stack.json'), JSON.stringify({
    version: 1,
    generation: 'unhealthy-generation',
    startedAt: new Date().toISOString(),
    services: [stateService(service.name, idle.pid, service.marker, service.port)],
  }));
  try {
    const result = await controller.start();
    assert.equal(result.status, 'started');
    assert.notEqual(result.pids[0], idle.pid);
  } finally {
    await controller.stop().catch(() => {});
    if (idle.pid) {
      try { process.kill(process.platform === 'win32' ? idle.pid : -idle.pid, 'SIGKILL'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知进程占用端口时拒绝启动，且不执行 migration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-port-'));
  const occupiedPort = await freePort();
  const external = createServer((_req, res) => res.end('external'));
  external.listen(occupiedPort, '127.0.0.1');
  await once(external, 'listening');
  const migrationMarker = join(dir, 'migration-ran');
  const fixture = writeHttpFixture(dir);
  const config: DevStackConfig = {
    root,
    stateDir: join(dir, '.pids'),
    lockPort: await freePort(),
    migration: {
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(migrationMarker)}, 'yes')`],
      cwd: root,
    },
    services: [
      { name: 'api', command: process.execPath, args: [fixture, String(occupiedPort)], cwd: dir, port: occupiedPort, marker: fixture },
    ],
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
    logger: () => {},
  };
  try {
    await assert.rejects(createDevStackController(config).start(), /端口.*已被未托管进程占用/);
    assert.equal(existsSync(migrationMarker), false);
  } finally {
    external.close();
    await once(external, 'close');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop 对同 marker 但出生时间不匹配的 PID 拒绝终止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-identity-'));
  const config = await fixtureConfig(dir);
  const service = config.services[0];
  assert.ok(service);
  const fixture = service.args[0];
  assert.ok(fixture);
  const bystanderPort = await freePort();
  const bystander = spawn(process.execPath, [fixture, String(bystanderPort), 'bystander', join(dir, 'events.log')], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
  });
  await once(bystander, 'spawn');
  assert.ok(bystander.pid);
  bystander.unref();

  const stateFile = join(config.stateDir, 'dev-stack.json');
  const controller = createDevStackController(config);
  const forged = stateService(service.name, bystander.pid, service.marker, service.port);
  forged.processStartedAt = 'forged-start-time';
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    generation: 'identity-generation',
    startedAt: new Date().toISOString(),
    services: [forged],
  }));
  try {
    await assert.rejects(controller.stop(), /PID 身份不匹配/);
    assert.doesNotThrow(() => process.kill(bystander.pid!, 0));
    assert.equal(existsSync(stateFile), true);
  } finally {
    try { process.kill(process.platform === 'win32' ? bystander.pid : -bystander.pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本机 action lock 端口被占用时拒绝并发 start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-lock-'));
  const config = await fixtureConfig(dir);
  const controller = createDevStackController(config);
  const lockHolder = createServer();
  lockHolder.listen(config.lockPort, '127.0.0.1');
  await once(lockHolder, 'listening');
  try {
    await assert.rejects(controller.start(), /已有 dev-stack 操作进行中/);
  } finally {
    lockHolder.close();
    await once(lockHolder, 'close');
    await controller.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn 后 marker 校验失败时终止刚创建的进程组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-marker-'));
  const base = await fixtureConfig(dir);
  const service = base.services[0];
  assert.ok(service);
  const fixture = service.args[0];
  assert.ok(fixture);
  const config: DevStackConfig = {
    ...base,
    services: [{ ...service, marker: 'marker-that-cannot-match' }],
  };
  const controller = createDevStackController(config);
  try {
    await assert.rejects(controller.start(), /marker 不匹配/);
    assert.deepEqual(pidsByCommandFragment(fixture), []);
  } finally {
    for (const pid of pidsByCommandFragment(fixture)) {
      const pgid = Number(psValue(pid, 'pgid'));
      try { process.kill(process.platform === 'win32' ? pgid : -pgid, 'SIGKILL'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('启动期间收到 shutdown 请求时清理 provisional state 和已启动服务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-interrupt-'));
  const base = await fixtureConfig(dir);
  let controller: DevStackController;
  const config: DevStackConfig = {
    ...base,
    logger: (message) => {
      if (message.startsWith('api 已就绪')) controller.requestShutdown();
    },
  };
  controller = createDevStackController(config);
  try {
    await assert.rejects(controller.start(), /启动已中断/);
    assert.equal(existsSync(join(config.stateDir, 'dev-stack.json')), false);
  } finally {
    await controller.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart 的 stop 阶段收到 shutdown 请求后不得重新启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-restart-interrupt-'));
  const base = await fixtureConfig(dir);
  let controller: DevStackController;
  const config: DevStackConfig = {
    ...base,
    logger: (message) => {
      if (message === 'dev-stack 已停止') controller.requestShutdown();
    },
  };
  controller = createDevStackController(config);
  try {
    await controller.start();
    await assert.rejects(controller.restart(), /启动已中断/);
    assert.equal(existsSync(join(config.stateDir, 'dev-stack.json')), false);
  } finally {
    await controller.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务端口可访问但缺少本次启动就绪标记时拒绝记为 ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-ready-marker-'));
  const base = await fixtureConfig(dir);
  const service = base.services[0];
  assert.ok(service);
  const config: DevStackConfig = {
    ...base,
    services: [{ ...service, args: [...service.args, 'silent'] }],
    readinessTimeoutMs: 300,
  };
  const controller = createDevStackController(config);
  try {
    await assert.rejects(controller.start(), /未出现就绪标记|未就绪/);
  } finally {
    await controller.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop 等待并终止整个进程组，不遗留忽略 SIGTERM 的后代', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-group-'));
  const parent = writeStubbornGroupFixture(dir);
  const child = join(dir, 'dev-stack-stubborn-child.mjs');
  const port = await freePort();
  const config: DevStackConfig = {
    root,
    stateDir: join(dir, '.pids'),
    lockPort: await freePort(),
    migration: { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    services: [{
      name: 'stubborn', command: process.execPath, args: [parent, child, String(port)], cwd: dir,
      port, marker: parent, readyPattern: 'READY:stubborn',
    }],
    readinessTimeoutMs: 3_000,
    shutdownTimeoutMs: 300,
    logger: () => {},
  };
  const controller = createDevStackController(config);
  let leaderPid: number | undefined;
  try {
    const started = await controller.start();
    leaderPid = started.pids[0];
    await controller.stop();
    await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
  } finally {
    if (leaderPid) {
      try { process.kill(process.platform === 'win32' ? leaderPid : -leaderPid, 'SIGKILL'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop 在没有状态文件时幂等返回 not-running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-stack-empty-'));
  const config = await fixtureConfig(dir);
  try {
    const result = await createDevStackController(config).stop();
    assert.equal(result.status, 'not-running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
