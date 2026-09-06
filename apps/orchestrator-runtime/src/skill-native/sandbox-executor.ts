import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SCRIPT_TIMEOUT_MS = 120_000;
const CONTAINER_CLEANUP_TIMEOUT_MS = 10_000;

export type SandboxRuntime = 'node' | 'python' | 'bash';

export interface SandboxInputFile {
  path: string;
  bytes: Uint8Array;
}

export interface SandboxOutputFile {
  path: string;
  bytes: Buffer;
}

export interface SandboxExecutionRequest {
  packageRoot: string;
  scriptPath: string;
  runtime: SandboxRuntime;
  arguments: string[];
  inputs: SandboxInputFile[];
  outputs: string[];
  readonlyMounts: Array<{ logicalPath: string; hostPath: string }>;
  signal: AbortSignal;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  outputs: SandboxOutputFile[];
}

export interface SkillSandbox {
  status(): { available: boolean; reason?: string };
  execute(input: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export interface SandboxProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SandboxProcessRunner = (
  command: string,
  args: string[],
  options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
) => Promise<SandboxProcessResult>;

function normalizedRelativePath(path: string): string {
  if (
    !path
    || isAbsolute(path)
    || path.includes('\\')
    || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) throw new Error('sandbox path must be a normalized relative path');
  return path;
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new Error('sandbox path escapes its root');
}

function defaultRunner(
  command: string,
  args: string[],
  options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
): Promise<SandboxProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;

    const finish = (error?: Error, result?: SandboxProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(result!);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > options.maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new Error('sandbox stdout/stderr exceeds 1 MiB'));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const abort = (): void => {
      child.kill('SIGKILL');
      finish(new Error('sandbox execution cancelled'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`sandbox execution timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);

    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(undefined, {
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    if (options.signal.aborted) abort();
  });
}

export class DockerSandboxExecutor implements SkillSandbox {
  private readonly workspaceRoot: string;

  constructor(private readonly options: {
    image?: string;
    workspaceRoot?: string;
    runner?: SandboxProcessRunner;
  } = {}) {
    this.workspaceRoot = resolve(
      options.workspaceRoot
      ?? `${process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces'}/skill-native`,
    );
  }

  status(): { available: boolean; reason?: string } {
    const image = this.options.image?.trim() || process.env.SKILL_SANDBOX_IMAGE?.trim();
    return image && /@sha256:[a-f0-9]{64}$/u.test(image)
      ? { available: true }
      : { available: false, reason: 'SKILL_SANDBOX_IMAGE must be configured with an immutable sha256 digest' };
  }

  async execute(input: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const availability = this.status();
    if (!availability.available) throw new Error(`script.run is unavailable: ${availability.reason}`);
    const image = (this.options.image?.trim() || process.env.SKILL_SANDBOX_IMAGE!.trim());
    const scriptPath = normalizedRelativePath(input.scriptPath);
    const expectedExtension = input.runtime === 'python' ? /\.py$/u : input.runtime === 'node' ? /\.(?:c|m)?js$/u : /\.sh$/u;
    if (!expectedExtension.test(scriptPath)) throw new Error(`script ${scriptPath} does not match runtime ${input.runtime}`);
    if (input.arguments.length > 32 || input.arguments.some((argument) => argument.length > 4_096)) {
      throw new Error('sandbox arguments exceed the supported limit');
    }

    const packageRoot = realpathSync(input.packageRoot);
    if (!lstatSync(packageRoot).isDirectory()) throw new Error('sandbox package root must be a directory');
    const script = realpathSync(resolve(packageRoot, scriptPath));
    assertContained(packageRoot, script);
    if (!lstatSync(script).isFile()) throw new Error(`sandbox script is not a file: ${scriptPath}`);

    const runRoot = resolve(this.workspaceRoot, 'sandbox', randomUUID());
    const inputRoot = resolve(runRoot, 'inputs');
    const outputRoot = resolve(runRoot, 'outputs');
    mkdirSync(inputRoot, { recursive: true, mode: 0o755 });
    mkdirSync(outputRoot, { recursive: true, mode: 0o777 });
    chmodSync(outputRoot, 0o777);
    try {
      for (const file of input.inputs) {
        const path = resolve(inputRoot, normalizedRelativePath(file.path));
        assertContained(inputRoot, path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
        writeFileSync(path, file.bytes, { mode: 0o444 });
      }
      for (const output of input.outputs) {
        const path = resolve(outputRoot, normalizedRelativePath(output));
        assertContained(outputRoot, path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o777 });
        chmodSync(dirname(path), 0o777);
      }

      const executable = input.runtime === 'python' ? 'python3' : input.runtime === 'node' ? 'node' : 'bash';
      const containerName = `skill-native-${randomUUID()}`;
      const dockerArgs = [
        'run', '--rm', '--name', containerName, '--pull', 'never',
        '--network', 'none', '--read-only', '--user', '65532:65532',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,src=${packageRoot},dst=/skill,readonly`,
        '--mount', `type=bind,src=${inputRoot},dst=/inputs,readonly`,
        '--mount', `type=bind,src=${outputRoot},dst=/outputs`,
      ];
      for (const mount of input.readonlyMounts) {
        const reserved = ['/skill', '/inputs', '/outputs', '/tmp'];
        if (
          !mount.logicalPath.startsWith('/')
          || mount.logicalPath.includes(',')
          || mount.logicalPath.includes('\\')
          || mount.logicalPath.split('/').slice(1).some((segment) => !segment || segment === '.' || segment === '..')
          || reserved.some((path) => mount.logicalPath === path || mount.logicalPath.startsWith(`${path}/`))
        ) {
          throw new Error(`sandbox external logical path is invalid: ${mount.logicalPath}`);
        }
        dockerArgs.push('--mount', `type=bind,src=${realpathSync(mount.hostPath)},dst=${mount.logicalPath},readonly`);
      }
      dockerArgs.push('--workdir', '/skill', image, executable, `/skill/${scriptPath}`, ...input.arguments);
      const runner = this.options.runner ?? defaultRunner;
      try {
        const result = await runner('docker', dockerArgs, {
          signal: input.signal,
          timeoutMs: SCRIPT_TIMEOUT_MS,
          maxOutputBytes: MAX_CAPTURE_BYTES,
        });
        if (result.exitCode !== 0) {
          throw new Error(`sandbox script exited with ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
        }

        let totalBytes = 0;
        const outputs = input.outputs.map((relativePath): SandboxOutputFile => {
          const path = resolve(outputRoot, normalizedRelativePath(relativePath));
          assertContained(outputRoot, path);
          if (!existsSync(path)) throw new Error(`sandbox output is missing: ${relativePath}`);
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`sandbox output is not a regular file: ${relativePath}`);
          const real = realpathSync(path);
          assertContained(realpathSync(outputRoot), real);
          if (stat.size > MAX_OUTPUT_FILE_BYTES) throw new Error(`sandbox output exceeds 10 MiB: ${relativePath}`);
          totalBytes += stat.size;
          if (totalBytes > MAX_OUTPUT_BYTES) throw new Error('sandbox outputs exceed 64 MiB');
          return { path: relativePath, bytes: readFileSync(real) };
        });
        return { stdout: result.stdout, stderr: result.stderr, outputs };
      } catch (error) {
        try {
          await runner('docker', ['rm', '-f', containerName], {
            signal: AbortSignal.timeout(CONTAINER_CLEANUP_TIMEOUT_MS),
            timeoutMs: CONTAINER_CLEANUP_TIMEOUT_MS,
            maxOutputBytes: MAX_CAPTURE_BYTES,
          });
        } catch {
          // Preserve the execution failure; cleanup is best-effort after the daemon command fails.
        }
        throw error;
      }
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  }
}
