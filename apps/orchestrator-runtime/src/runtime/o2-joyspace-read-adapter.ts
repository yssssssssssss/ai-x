import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  ToolInvocationError,
  toolAbortError,
  throwIfToolInvocationAborted,
  type ToolAdapter,
  type ToolInvocationContext,
  type ToolInvocationReceipt,
  type ToolInvokeOptions,
  type ToolInvokeResult,
} from './tool-adapter.ts';

const JOYSPACE_HOST = 'joyspace.jd.com';
const OUTPUT_VERSION = 'joyspace-read-output-v1';
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_VIEW_BODY_BYTES = 512 * 1024;

type JoyspaceOperation = 'search' | 'view';

export interface O2RuntimeVersions extends Record<string, string> {
  o2: string;
  webcli: string;
}

export interface O2CommandRunner {
  (
    file: string,
    args: readonly string[],
    options: { signal: AbortSignal; timeoutMs: number; maxBufferBytes: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

interface O2JoyspaceReadAdapterOptions {
  binaryPath?: string;
  runner?: O2CommandRunner;
  versions?: O2RuntimeVersions;
}

interface JoyspaceInput {
  operation: JoyspaceOperation;
  target: string;
  limit?: number;
  scope?: 'auto' | 'related' | 'all';
  viewTopResult?: boolean;
}

interface SearchDocument {
  title: string;
  url: string;
  author: string | null;
  updatedAt: string | null;
  preview: string | null;
}

interface JoyspaceSearchOutput {
  version: typeof OUTPUT_VERSION;
  operation: 'search';
  status: 'available' | 'empty';
  documents: SearchDocument[];
  viewedDocument?: ViewedDocument;
  runtime: O2RuntimeVersions;
}

interface ViewedDocument {
  title: string;
  body: string;
  author: string | null;
  url: string;
  contentSha256: string;
}

function runExecFile(
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number; maxBufferBytes: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      signal: options.signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'schema', retryable: false, sanitizedMessage: `${field} is required`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function joyspaceUrl(value: unknown): string {
  const text = cleanString(value, 'url');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace returned an invalid URL',
    });
  }
  if (url.protocol !== 'https:' || url.hostname !== JOYSPACE_HOST || url.username || url.password) {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'safety', retryable: false, sanitizedMessage: 'Joyspace returned an untrusted URL',
    });
  }
  return url.toString();
}

function joyspaceDocumentUrl(value: string): string {
  const url = joyspaceUrl(value);
  if (!new URL(url).pathname.startsWith('/pages/')) {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'capability', retryable: false, sanitizedMessage: 'Joyspace view supports collaborative documents only',
    });
  }
  return url;
}

function parseJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'capacity', retryable: false, sanitizedMessage: 'Joyspace output exceeds the bounded response size',
    });
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace returned malformed JSON',
    });
  }
}

function assertO2PayloadAvailable(
  value: unknown,
  toolId: string,
  context: ToolInvocationContext,
  versions: O2RuntimeVersions,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok !== false) return;
  const diagnostic = [candidate.error, candidate.next]
    .filter((item): item is string => typeof item === 'string')
    .join(' ');
  throw processFailure(toolId, Object.assign(new Error('o2 command failed'), { stderr: diagnostic }), context, versions);
}

function unwrapRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = (value as { result?: unknown }).result;
    if (Array.isArray(result)) return result;
  }
  throw new ToolInvocationError('joyspace-read', {
    kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace response must be an array',
  });
}

function searchOutput(value: unknown, versions: O2RuntimeVersions): JoyspaceSearchOutput {
  const documents: SearchDocument[] = unwrapRows(value).map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ToolInvocationError('joyspace-read', {
        kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace search row is malformed',
      });
    }
    const row = candidate as Record<string, unknown>;
    return {
      title: cleanString(row.title, 'title'),
      url: joyspaceUrl(row.url),
      author: optionalString(row.author),
      updatedAt: optionalString(row.updated_at),
      preview: optionalString(row.preview),
    };
  });
  return {
    version: OUTPUT_VERSION,
    operation: 'search',
    status: documents.length > 0 ? 'available' : 'empty',
    documents,
    runtime: versions,
  };
}

function viewOutput(value: unknown, versions: O2RuntimeVersions): {
  output: object;
  document: ViewedDocument;
} {
  const fields = new Map<string, unknown>();
  for (const candidate of unwrapRows(value)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.field === 'string') fields.set(row.field, row.value);
  }
  const body = cleanString(fields.get('body'), 'body');
  if (Buffer.byteLength(body, 'utf8') > MAX_VIEW_BODY_BYTES) {
    throw new ToolInvocationError('joyspace-read', {
      kind: 'capacity', retryable: false, sanitizedMessage: 'Joyspace document exceeds the bounded Knowledge Snapshot size',
    });
  }
  const document: ViewedDocument = {
    title: cleanString(fields.get('title'), 'title'),
    body,
    author: optionalString(fields.get('author')),
    url: joyspaceUrl(fields.get('url')),
    contentSha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  };
  return {
    output: {
      version: OUTPUT_VERSION,
      operation: 'view',
      status: 'available',
      document,
      runtime: versions,
    },
    document,
  };
}

function processFailure(
  toolId: string,
  error: unknown,
  context: ToolInvocationContext,
  versions?: O2RuntimeVersions,
): ToolInvocationError {
  if (context.signal.aborted || Date.now() >= context.deadlineAt) {
    return toolAbortError(toolId, context.signal, context.deadlineAt);
  }
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown; message?: unknown }
    : {};
  const diagnostic = [candidate.stderr, candidate.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  let kind: ToolInvocationError['kind'] = 'unknown';
  let retryable = false;
  let message = 'Joyspace read failed';
  if (candidate.code === 'ENOENT') {
    kind = 'configuration';
    message = 'o2 executable is unavailable';
  } else if (candidate.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    kind = 'capacity';
    message = 'Joyspace output exceeds the bounded response size';
  } else if (candidate.killed === true || candidate.signal === 'SIGTERM' || /timed?\s*out|timeout/u.test(diagnostic)) {
    kind = 'timeout';
    retryable = true;
    message = 'Joyspace read timed out';
  } else if (/browser\s*bridge|浏览器扩展|chrome.*(?:bridge|extension)|bridge.*(?:missing|connect)/iu.test(diagnostic)) {
    kind = 'browser_bridge';
    message = 'Joyspace Browser Bridge is unavailable';
  } else if (/无权限|permission|forbidden|\b403\b/u.test(diagnostic)) {
    kind = 'permission';
    message = 'Joyspace permission was denied';
  } else if (/未登录|登录失效|请先登录|login|required|unauthorized|cookie/u.test(diagnostic)) {
    kind = 'authentication';
    message = 'Joyspace authentication is unavailable';
  } else if (/network|econn|enotfound|socket|fetch/u.test(diagnostic)) {
    kind = 'network';
    retryable = true;
    message = 'Joyspace network request failed';
  }
  const receipt: ToolInvocationReceipt = {
    declaredAdapterType: 'o2',
    resolvedAdapterType: 'o2',
    implementationId: 'o2-joyspace-read',
    executionMode: 'real',
    endpointHost: JOYSPACE_HOST,
    status: 'failed',
    latencyMs: 0,
    ...(versions ? { runtimeVersions: versions } : {}),
  };
  return new ToolInvocationError(toolId, {
    kind,
    retryable,
    providerStatus: null,
    sanitizedMessage: message,
    receipt,
  });
}

function remainingTimeout(context: ToolInvocationContext, configuredMs: number): number {
  return Math.max(1, Math.min(configuredMs, context.deadlineAt - Date.now()));
}

export class O2JoyspaceReadAdapter implements ToolAdapter {
  readonly adapterType = 'o2' as const;
  readonly implementationId = 'o2-joyspace-read';
  readonly executionMode = 'real' as const;
  private readonly binaryPath: string;
  private readonly runner: O2CommandRunner;
  private versions: O2RuntimeVersions | undefined;

  constructor(options: O2JoyspaceReadAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.O2_BIN?.trim() ?? 'o2';
    this.runner = options.runner ?? runExecFile;
    this.versions = options.versions;
  }

  endpointHost(): string {
    return JOYSPACE_HOST;
  }

  private async runtimeVersions(context: ToolInvocationContext): Promise<O2RuntimeVersions> {
    if (this.versions) return this.versions;
    try {
      const timeoutMs = remainingTimeout(context, 10_000);
      const [o2Result, webcliResult] = await Promise.all([
        this.runner(this.binaryPath, ['--version'], { signal: context.signal, timeoutMs, maxBufferBytes: 64 * 1024 }),
        this.runner(this.binaryPath, ['info', 'webcli', '--json'], { signal: context.signal, timeoutMs, maxBufferBytes: 256 * 1024 }),
      ]);
      const info = parseJson(webcliResult.stdout);
      const webcli = info && typeof info === 'object' && !Array.isArray(info)
        ? optionalString((info as Record<string, unknown>).version)
        : null;
      const o2 = /(?:^|\s)o2\s+([^\s]+)/u.exec(o2Result.stdout.trim())?.[1] ?? null;
      if (!o2 || !webcli) {
        throw new ToolInvocationError('joyspace-read', {
          kind: 'configuration', retryable: false, sanitizedMessage: 'o2/webcli versions are unavailable',
        });
      }
      this.versions = { o2, webcli };
      return this.versions;
    } catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      throw processFailure('joyspace-read', error, context);
    }
  }

  async invoke(options: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const startedAt = performance.now();
    throwIfToolInvocationAborted(options.toolId, options.context);
    if (
      options.toolId !== 'joyspace-read'
      || options.manifest.adapter_type !== 'o2'
      || options.manifest.entrypoint !== 'webcli joyspace'
    ) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'capability', retryable: false, sanitizedMessage: 'adapter only supports joyspace-read',
      });
    }
    const input = options.input as Partial<JoyspaceInput>;
    if (input.operation !== 'search' && input.operation !== 'view') {
      throw new ToolInvocationError(options.toolId, {
        kind: 'safety', retryable: false, sanitizedMessage: 'only Joyspace search and view are allowed',
      });
    }
    const target = cleanString(input.target, 'target');
    if (target.length > 500) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace target is too long',
      });
    }
    const limit = input.limit ?? 5;
    const scope = input.scope ?? 'auto';
    const viewTopResult = input.viewTopResult ?? false;
    if (typeof viewTopResult !== 'boolean') {
      throw new ToolInvocationError(options.toolId, {
        kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace viewTopResult must be boolean',
      });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace search limit must be between 1 and 20',
      });
    }
    if (!['auto', 'related', 'all'].includes(scope)) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace search scope is invalid',
      });
    }
    if (target.startsWith('-')) {
      throw new ToolInvocationError(options.toolId, {
        kind: 'safety', retryable: false, sanitizedMessage: 'Joyspace target cannot be a command option',
      });
    }
    if (input.operation === 'view') {
      if (/^https?:/iu.test(target)) joyspaceDocumentUrl(target);
      else if (!/^[A-Za-z0-9_-]{3,128}$/u.test(target)) {
        throw new ToolInvocationError(options.toolId, {
          kind: 'schema', retryable: false, sanitizedMessage: 'Joyspace document ID is invalid',
        });
      }
    }
    const versions = await this.runtimeVersions(options.context);
    const timeoutMs = remainingTimeout(
      options.context,
      (options.manifest.timeout_seconds ?? 60) * 1_000,
    );
    const args = input.operation === 'search'
      ? [
          'launch', 'webcli', 'joyspace', 'search', target,
          '--limit', String(limit),
          '--scope', scope,
          '-f', 'json',
        ]
      : ['launch', 'webcli', 'joyspace', 'view', target, '-f', 'json'];
    try {
      const result = await this.runner(this.binaryPath, args, {
        signal: options.context.signal,
        timeoutMs,
        maxBufferBytes: MAX_STDOUT_BYTES,
      });
      throwIfToolInvocationAborted(options.toolId, options.context);
      const parsed = parseJson(result.stdout);
      assertO2PayloadAvailable(parsed, options.toolId, options.context, versions);
      let normalized: {
        output: object;
        document: ViewedDocument | undefined;
        updatedAt: string | null;
      };
      if (input.operation === 'view') {
        const viewed = viewOutput(parsed, versions);
        normalized = { ...viewed, updatedAt: null };
      } else {
        const searched = searchOutput(parsed, versions);
        const selected = viewTopResult
          ? searched.documents.find(({ url }) => new URL(url).pathname.startsWith('/pages/'))
          : undefined;
        if (viewTopResult && !selected) {
          throw new ToolInvocationError(options.toolId, {
            kind: 'capability', retryable: false,
            sanitizedMessage: searched.documents.length === 0
              ? 'Joyspace search returned no document'
              : 'Joyspace search returned no viewable collaborative document',
            receipt: {
              declaredAdapterType: 'o2', resolvedAdapterType: 'o2',
              implementationId: this.implementationId, executionMode: 'real',
              endpointHost: JOYSPACE_HOST, status: 'failed', latencyMs: Math.round(performance.now() - startedAt),
              runtimeVersions: versions,
            },
          });
        }
        if (!selected) {
          normalized = { output: searched, document: undefined, updatedAt: null };
        } else {
          const viewedResult = await this.runner(this.binaryPath, [
            'launch', 'webcli', 'joyspace', 'view', selected.url, '-f', 'json',
          ], {
            signal: options.context.signal,
            timeoutMs: remainingTimeout(options.context, timeoutMs),
            maxBufferBytes: MAX_STDOUT_BYTES,
          });
          throwIfToolInvocationAborted(options.toolId, options.context);
          const viewedParsed = parseJson(viewedResult.stdout);
          assertO2PayloadAvailable(viewedParsed, options.toolId, options.context, versions);
          const viewed = viewOutput(viewedParsed, versions);
          normalized = {
            output: { ...searched, viewedDocument: viewed.document },
            document: viewed.document,
            updatedAt: selected.updatedAt,
          };
        }
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      const receipt: ToolInvocationReceipt = {
        declaredAdapterType: 'o2',
        resolvedAdapterType: 'o2',
        implementationId: this.implementationId,
        executionMode: 'real',
        endpointHost: JOYSPACE_HOST,
        status: 'ok',
        latencyMs,
        runtimeVersions: versions,
      };
      return {
        output: normalized.output,
        latencyMs,
        receipt,
        ...(normalized.document ? {
          knowledgeAttachments: [{
            attachmentId: 'joyspace-document',
            title: normalized.document.title,
            body: normalized.document.body,
            sourceUrl: normalized.document.url,
            author: normalized.document.author,
            updatedAt: normalized.updatedAt,
            contentSha256: normalized.document.contentSha256,
            sensitivity: 'internal' as const,
          }],
        } : {}),
      };
    } catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      throw processFailure(options.toolId, error, options.context, versions);
    }
  }
}
