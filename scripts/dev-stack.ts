import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type DevStackAction = 'start' | 'restart' | 'stop';

export interface DevStackCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface DevStackService extends DevStackCommand {
  name: string;
  port: number;
  marker: string;
  healthUrl?: string;
  readyPattern?: string;
}

export interface DevStackConfig {
  root: string;
  stateDir: string;
  lockPort: number;
  migration: DevStackCommand;
  services: DevStackService[];
  readinessTimeoutMs: number;
  shutdownTimeoutMs: number;
  logger: (message: string) => void;
}

export interface DevStackResult {
  status: 'started' | 'already-running' | 'stopped' | 'not-running' | 'stale-cleared';
  pids: number[];
}

export interface DevStackController {
  start(): Promise<DevStackResult>;
  restart(): Promise<DevStackResult>;
  stop(): Promise<DevStackResult>;
  requestShutdown(): void;
}

interface RunningService {
  name: string;
  pid: number;
  pgid: number;
  processStartedAt: string;
  command: string;
  marker: string;
  port: number;
}

interface DevStackState {
  version: 1;
  generation: string;
  startedAt: string;
  services: RunningService[];
}

interface ProcessIdentity {
  pid: number;
  pgid: number;
  processStartedAt: string;
  command: string;
}


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG: DevStackConfig = {
  root,
  stateDir: join(root, '.pids'),
  lockPort: 43_991,
  migration: { command: 'pnpm', args: ['db:migrate'], cwd: root },
  services: [
    {
      name: 'api', command: 'pnpm', args: ['api:dev'], cwd: root,
      port: 3010, marker: 'api:dev', healthUrl: 'http://127.0.0.1:3010/api/healthz',
      readyPattern: 'agent-api listening',
    },
    {
      name: 'web', command: 'pnpm', args: ['--dir', 'apps/web', 'dev', '--host', '127.0.0.1'], cwd: root,
      port: 5180, marker: 'apps/web', healthUrl: 'http://127.0.0.1:5180', readyPattern: 'Local:',
    },
  ],
  readinessTimeoutMs: 30_000,
  shutdownTimeoutMs: 5_000,
  logger: console.log,
};

export const USAGE = '用法: pnpm dev:stack <start|restart|stop>';

export function parseAction(value: string | undefined): DevStackAction | null {
  return value === 'start' || value === 'restart' || value === 'stop' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

function parseState(raw: unknown): DevStackState {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.generation !== 'string' ||
      typeof raw.startedAt !== 'string' || !Array.isArray(raw.services)) {
    throw new Error('dev-stack 状态文件格式无效');
  }
  const services: RunningService[] = [];
  for (const item of raw.services) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.pid !== 'number' ||
        typeof item.pgid !== 'number' || typeof item.processStartedAt !== 'string' ||
        typeof item.command !== 'string' || typeof item.marker !== 'string' || typeof item.port !== 'number') {
      throw new Error('dev-stack 状态文件包含无效服务记录');
    }
    services.push({
      name: item.name, pid: item.pid, pgid: item.pgid,
      processStartedAt: item.processStartedAt, command: item.command,
      marker: item.marker, port: item.port,
    });
  }
  return { version: 1, generation: raw.generation, startedAt: raw.startedAt, services };
}

function psValue(pid: number, field: 'pgid' | 'lstart' | 'command'): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const value = result.stdout.trim();
  return value || null;
}

function inspectProcess(pid: number): ProcessIdentity | null {
  const pgidText = psValue(pid, 'pgid');
  const processStartedAt = psValue(pid, 'lstart');
  const command = psValue(pid, 'command');
  if (!pgidText || !processStartedAt || !command) return null;
  const pgid = Number(pgidText);
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  return { pid, pgid, processStartedAt, command };
}

function identityMatches(service: RunningService, expected?: DevStackService): boolean {
  const current = inspectProcess(service.pid);
  return current !== null && current.pgid === service.pgid &&
    current.processStartedAt === service.processStartedAt && current.command === service.command &&
    (!expected || service.command.includes(expected.marker));
}


function processGroupIsAlive(pgid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
}

async function portIsOpen(port: number): Promise<boolean> {
  const socket = connect({ host: '127.0.0.1', port });
  try {
    await once(socket, 'connect');
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

function logHasReadyPattern(service: DevStackService, logPath: string): boolean {
  if (!service.readyPattern) return true;
  return existsSync(logPath) && readFileSync(logPath, 'utf8').includes(service.readyPattern);
}

async function serviceIsReady(service: DevStackService, logPath: string): Promise<boolean> {
  if (!logHasReadyPattern(service, logPath) || !(await portIsOpen(service.port))) return false;
  if (!service.healthUrl) return true;
  try {
    const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export function createDevStackController(config: DevStackConfig = DEFAULT_CONFIG): DevStackController {
  mkdirSync(config.stateDir, { recursive: true });
  const stateFile = join(config.stateDir, 'dev-stack.json');
  let shutdownRequested = false;

  const readState = (): DevStackState | null => {
    if (!existsSync(stateFile)) return null;
    const raw: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parseState(raw);
  };

  const writeState = (state: DevStackState): void => {
    const temporary = `${stateFile}.${process.pid}.${state.generation}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2));
    renameSync(temporary, stateFile);
  };

  const removeState = (generation: string): void => {
    const current = readState();
    if (current?.generation === generation) rmSync(stateFile, { force: true });
  };

  const acquireLock = async (): Promise<Server> => {
    const server = createServer();
    try {
      server.listen(config.lockPort, '127.0.0.1');
      await once(server, 'listening');
      return server;
    } catch (error) {
      if (errorCode(error) === 'EADDRINUSE') {
        throw new Error(`已有 dev-stack 操作进行中(control port ${config.lockPort})`);
      }
      throw error;
    }
  };

  const releaseLock = async (server: Server): Promise<void> => {
    if (!server.listening) return;
    server.close();
    await once(server, 'close');
  };

  const withLock = async (operation: () => Promise<DevStackResult>): Promise<DevStackResult> => {
    const server = await acquireLock();
    try {
      return await operation();
    } finally {
      await releaseLock(server);
    }
  };

  const waitForGroupExit = async (pgid: number): Promise<boolean> => {
    const deadline = Date.now() + config.shutdownTimeoutMs;
    while (Date.now() < deadline) {
      if (!processGroupIsAlive(pgid)) return true;
      await sleep(50);
    }
    return !processGroupIsAlive(pgid);
  };

  const terminateOwned = async (services: RunningService[]): Promise<void> => {
    const active = services.filter((service) => processGroupIsAlive(service.pgid));
    for (const service of active) {
      const leader = inspectProcess(service.pid);
      if (leader && !identityMatches(service)) {
        throw new Error(`PID 身份不匹配，拒绝终止 ${service.name}(${service.pid})`);
      }
      signalProcessGroup(service.pgid, 'SIGTERM');
    }
    for (const service of active) {
      if (await waitForGroupExit(service.pgid)) continue;
      // PGID 在仍有成员时不会被复用；leader 已退出也可安全终止原组的存活后代。
      signalProcessGroup(service.pgid, 'SIGKILL');
      if (!(await waitForGroupExit(service.pgid))) {
        throw new Error(`${service.name} 进程组 ${service.pgid} 无法终止`);
      }
    }
  };

  const waitForIdentity = async (service: DevStackService, pid: number): Promise<RunningService> => {
    const deadline = Date.now() + config.readinessTimeoutMs;
    while (Date.now() < deadline) {
      const identity = inspectProcess(pid);
      if (identity) return { ...identity, name: service.name, marker: service.marker, port: service.port };
      await sleep(20);
    }
    throw new Error(`${service.name} 未能建立进程身份`);
  };

  const waitForReady = async (service: DevStackService, running: RunningService, logPath: string): Promise<void> => {
    const deadline = Date.now() + config.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (shutdownRequested) throw new Error('启动已中断');
      if (!identityMatches(running, service)) throw new Error(`${service.name} 启动进程已退出或身份改变`);
      if (await serviceIsReady(service, logPath)) return;
      await sleep(100);
    }
    const suffix = service.readyPattern ? `，未出现就绪标记 ${service.readyPattern}` : '';
    throw new Error(`${service.name} 在 ${config.readinessTimeoutMs}ms 内未就绪${suffix}`);
  };

  const stopUnlocked = async (): Promise<DevStackResult> => {
    const state = readState();
    if (!state) return { status: 'not-running', pids: [] };

    const active = state.services.filter((service) => processGroupIsAlive(service.pgid));
    for (const service of active) {
      const expected = config.services.find((candidate) => candidate.name === service.name);
      const leader = inspectProcess(service.pid);
      if (!expected || (leader && !identityMatches(service, expected))) {
        throw new Error(`PID 身份不匹配，拒绝终止 ${service.name}(${service.pid})`);
      }
    }

    await terminateOwned(active);
    removeState(state.generation);
    const status = active.length > 0 ? 'stopped' : 'stale-cleared';
    config.logger(status === 'stopped' ? 'dev-stack 已停止' : 'dev-stack stale 状态已清理');
    return { status, pids: active.map((service) => service.pid) };
  };

  const startUnlocked = async (): Promise<DevStackResult> => {
    const existing = readState();
    if (existing) {
      let allRunning = existing.services.length === config.services.length;
      for (const service of config.services) {
        const running = existing.services.find((candidate) => candidate.name === service.name);
        const logPath = join(config.stateDir, `${service.name}.log`);
        if (!running || !identityMatches(running, service) || !(await serviceIsReady(service, logPath))) {
          allRunning = false;
          break;
        }
      }
      if (allRunning) {
        return { status: 'already-running', pids: existing.services.map((service) => service.pid) };
      }
      await stopUnlocked();
    }

    for (const service of config.services) {
      if (await portIsOpen(service.port)) {
        throw new Error(`端口 ${service.port} 已被未托管进程占用，拒绝启动 ${service.name}`);
      }
    }

    config.logger('执行数据库迁移…');
    const migration = spawnSync(config.migration.command, config.migration.args, {
      cwd: config.migration.cwd, env: process.env, stdio: 'inherit',
    });
    if (migration.error) throw migration.error;
    if (migration.status !== 0) throw new Error(`数据库迁移失败(exit ${migration.status ?? 'unknown'})`);
    if (shutdownRequested) throw new Error('启动已中断');

    const generation = randomUUID();
    const startedAt = new Date().toISOString();
    const started: RunningService[] = [];
    try {
      for (const service of config.services) {
        if (shutdownRequested) throw new Error('启动已中断');
        const logPath = join(config.stateDir, `${service.name}.log`);
        const logFd = openSync(logPath, 'w');
        const child = spawn(service.command, service.args, {
          cwd: service.cwd, detached: true, env: process.env,
          stdio: ['ignore', logFd, logFd],
        });
        closeSync(logFd);
        child.on('error', (error) => config.logger(`${service.name} 启动失败: ${error.message}`));
        if (child.pid == null) throw new Error(`${service.name} 未返回 PID`);
        child.unref();

        const running = await waitForIdentity(service, child.pid);
        started.push(running);
        writeState({ version: 1, generation, startedAt, services: started });
        if (!running.command.includes(service.marker)) {
          throw new Error(`${service.name} 启动命令与 marker 不匹配`);
        }
        await waitForReady(service, running, logPath);
        config.logger(`${service.name} 已就绪:http://127.0.0.1:${service.port}`);
        if (shutdownRequested) throw new Error('启动已中断');
      }

      writeState({ version: 1, generation, startedAt, services: started });
      config.logger(`日志目录:${config.stateDir}`);
      return { status: 'started', pids: started.map((service) => service.pid) };
    } catch (error) {
      await terminateOwned(started);
      removeState(generation);
      throw error;
    }
  };

  return {
    start: () => withLock(async () => { shutdownRequested = false; return startUnlocked(); }),
    restart: () => withLock(async () => {
      shutdownRequested = false;
      await stopUnlocked();
      if (shutdownRequested) throw new Error('启动已中断');
      return startUnlocked();
    }),
    stop: () => withLock(stopUnlocked),
    requestShutdown: () => { shutdownRequested = true; },
  };
}

async function main(): Promise<void> {
  const action = parseAction(process.argv[2]);
  if (!action) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const controller = createDevStackController();
  const requestShutdown = () => controller.requestShutdown();
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  try {
    const result = await controller[action]();
    if (result.status === 'already-running') console.log('dev-stack 已运行，无需重复启动');
    if (result.status === 'not-running') console.log('dev-stack 当前未运行');
  } catch (error) {
    console.error(`dev:stack ${action} 失败:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', requestShutdown);
    process.off('SIGTERM', requestShutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
