import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import type {
  ArtifactRole,
  ExternalKnowledgeSnapshot,
  SkillPackageSnapshot,
  TaskArtifact,
} from '../../../../packages/api-contract/skill-native.ts';
import {
  getConfigRoot,
  loadToolInputSchema,
  loadToolManifest,
  loadToolRegistry,
} from '../runtime/config-loader.ts';
import {
  containsBlockedSensitiveData,
  redactSensitiveValue,
  redactToolOutput,
} from '../runtime/redaction.ts';
import {
  ToolInvocationError,
  type ToolAdapter,
  type ToolInvocationReceipt,
} from '../runtime/tool-adapter.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { SkillPackageStore } from './package-store.ts';
import type {
  SandboxRuntime,
  SkillSandbox,
} from './sandbox-executor.ts';
import type {
  SkillNativeArtifactInput,
  SkillNativeArtifactRecord,
  SkillNativeTaskStore,
  SkillNativeToolCallRecordInput,
} from './store.ts';

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_INVOCATION_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;

export interface SkillExternalReadMount {
  id: string;
  logicalPath: string;
  hostPath: string;
}

function normalizedLogicalPath(path: string): string {
  const withoutTrailingSlash = path.length > 1 ? path.replace(/\/+$/u, '') : path;
  if (
    withoutTrailingSlash === '/'
    || !withoutTrailingSlash.startsWith('/')
    || withoutTrailingSlash.includes('\\')
    || withoutTrailingSlash.split('/').slice(1).some((segment) => !segment || segment === '.' || segment === '..')
  ) throw new Error('external mount logicalPath must be an absolute normalized path');
  return withoutTrailingSlash;
}

export function parseSkillExternalReadMounts(raw = process.env.SKILL_EXTERNAL_READ_MOUNTS): SkillExternalReadMount[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SKILL_EXTERNAL_READ_MOUNTS must be a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('SKILL_EXTERNAL_READ_MOUNTS must be a JSON array');
  const mounts = parsed.map((value, index): SkillExternalReadMount => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`SKILL_EXTERNAL_READ_MOUNTS[${index}] must be an object`);
    }
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(item.id)) {
      throw new Error(`SKILL_EXTERNAL_READ_MOUNTS[${index}].id is invalid`);
    }
    if (typeof item.logicalPath !== 'string') {
      throw new Error(`SKILL_EXTERNAL_READ_MOUNTS[${index}].logicalPath is invalid`);
    }
    if (typeof item.hostPath !== 'string' || !isAbsolute(item.hostPath)) {
      throw new Error(`SKILL_EXTERNAL_READ_MOUNTS[${index}].hostPath must be absolute`);
    }
    if (resolve(item.hostPath) === '/') {
      throw new Error(`SKILL_EXTERNAL_READ_MOUNTS[${index}].hostPath must not be the filesystem root`);
    }
    return {
      id: item.id,
      logicalPath: normalizedLogicalPath(item.logicalPath),
      hostPath: resolve(item.hostPath),
    };
  });
  if (new Set(mounts.map(({ id }) => id)).size !== mounts.length) {
    throw new Error('SKILL_EXTERNAL_READ_MOUNTS contains duplicate ids');
  }
  if (new Set(mounts.map(({ logicalPath }) => logicalPath)).size !== mounts.length) {
    throw new Error('SKILL_EXTERNAL_READ_MOUNTS contains duplicate logicalPath values');
  }
  return mounts;
}

export interface SkillNativeToolResult {
  output: object;
  artifactIds: string[];
  receipt?: ToolInvocationReceipt;
}

export interface SkillNativeToolPort {
  list(): Array<{ id: string; name: string }>;
  invoke(input: {
    toolId: string;
    arguments: object;
    invocationId: string;
    signal: AbortSignal;
    attemptId: string;
    scope: { taskId: string; ownerUserId: string; projectId: string };
  }): Promise<SkillNativeToolResult>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function inputHash(value: object): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function failureRecord(error: unknown): Record<string, unknown> {
  if (error instanceof ToolInvocationError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      providerStatus: error.providerStatus,
      message: error.sanitizedMessage,
    };
  }
  return { kind: 'unknown', retryable: false, message: safeError(error) };
}

export class RegistryToolPort implements SkillNativeToolPort {
  constructor(
    private readonly adapter: ToolAdapter,
    private readonly validator = new SchemaValidator(),
    private readonly persistence?: Pick<SkillNativeTaskStore, 'writeArtifact' | 'recordToolCall'>,
  ) {}

  list(): Array<{ id: string; name: string }> {
    return loadToolRegistry().tools
      .filter(({ status, risk_level: riskLevel }) => status === 'active' && riskLevel === 'low')
      .map(({ id, name }) => ({ id, name }));
  }

  async invoke(input: {
    toolId: string;
    arguments: object;
    invocationId: string;
    signal: AbortSignal;
    attemptId: string;
    scope: { taskId: string; ownerUserId: string; projectId: string };
  }): Promise<SkillNativeToolResult> {
    const entry = loadToolRegistry().tools.find(({ id, status, risk_level: riskLevel }) => (
      id === input.toolId && status === 'active' && riskLevel === 'low'
    ));
    if (!entry) throw new Error(`tool ${input.toolId} is unavailable or not read-only`);
    const manifest = loadToolManifest(entry.path);
    const redactionPolicy = manifest.redaction_policy ?? {};
    if (redactionPolicy.sensitive_business_data === 'block' && containsBlockedSensitiveData(input.arguments)) {
      throw new Error(`tool ${input.toolId} input is blocked by its sensitive-data policy`);
    }
    const toolInput = redactSensitiveValue(input.arguments, redactionPolicy) as object;
    this.validator.validateSchemaOrThrow(loadToolInputSchema(manifest.input_schema), toolInput, `${input.toolId} input`);
    const startedAt = new Date();
    let receipt: ToolInvocationReceipt | undefined;
    try {
      const result = await this.adapter.invoke({
        toolId: input.toolId,
        input: toolInput,
        manifest,
        context: {
          signal: input.signal,
          deadlineAt: Date.now() + (manifest.timeout_seconds ?? 90) * 1_000,
        },
        attemptId: input.attemptId,
      });
      receipt = result.receipt;
      if (input.signal.aborted) throw new Error('skill-native execution cancelled');
      this.validator.validateFileOrThrow(`${getConfigRoot()}/${manifest.output_schema}`, result.output);
      if (redactionPolicy.sensitive_business_data === 'block' && containsBlockedSensitiveData(result.output)) {
        throw new Error(`tool ${input.toolId} output is blocked by its sensitive-data policy`);
      }
      const output = redactToolOutput(result.output, redactionPolicy) as object;
      const artifacts: SkillNativeArtifactInput[] = [
        ...(result.mediaAttachments ?? []).map((attachment) => ({
          id: randomUUID(),
          ...input.scope,
          invocationId: input.invocationId,
          relativePath: `tool/${input.toolId}/${attachment.attachmentId}`,
          fileName: `${attachment.attachmentId}.${attachment.mediaType.split('/')[1]}`,
          mediaType: attachment.mediaType,
          role: 'working' as const,
          bytes: attachment.bytes,
          contentSha256: attachment.contentSha256,
          sourceArtifactIds: [],
        })),
        ...(result.knowledgeAttachments ?? []).map((attachment) => {
          const bytes = Buffer.from(attachment.body, 'utf8');
          return {
            id: randomUUID(),
            ...input.scope,
            invocationId: input.invocationId,
            relativePath: `tool/${input.toolId}/${attachment.attachmentId}.md`,
            fileName: `${attachment.attachmentId}.md`,
            mediaType: 'text/markdown',
            role: 'working' as const,
            bytes,
            contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            sourceArtifactIds: [],
          };
        }),
      ];
      for (const artifact of artifacts) await this.persistence?.writeArtifact(artifact, input.attemptId);
      await this.recordToolCall({
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        toolId: input.toolId,
        inputHash: inputHash(toolInput),
        output,
        sources: artifacts.map(({ id, fileName, mediaType }) => ({ artifactId: id, fileName, mediaType })),
        receipt,
        status: 'succeeded',
        startedAt,
        finishedAt: new Date(),
      });
      return { output, artifactIds: artifacts.map(({ id }) => id), receipt };
    } catch (error) {
      await this.recordToolCall({
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        toolId: input.toolId,
        inputHash: inputHash(toolInput),
        ...(receipt ? { receipt } : {}),
        status: 'failed',
        failure: failureRecord(error),
        startedAt,
        finishedAt: new Date(),
      });
      throw error;
    }
  }

  private async recordToolCall(input: SkillNativeToolCallRecordInput): Promise<void> {
    await this.persistence?.recordToolCall?.(input);
  }
}

export interface CapabilityContext {
  snapshot: SkillPackageSnapshot;
  invocationId: string;
  attemptId: string;
  taskId: string;
  ownerUserId: string;
  projectId: string;
  planKey: string;
  externalKnowledge: ExternalKnowledgeSnapshot[];
  onExternalSnapshot?: (snapshot: ExternalKnowledgeSnapshot) => void | Promise<void>;
  signal: AbortSignal;
}

export class SkillNativeCapabilityBroker {
  constructor(private readonly dependencies: {
    packages: SkillPackageStore;
    artifacts: Pick<SkillNativeTaskStore, 'listArtifacts' | 'getArtifactOwned' | 'writeArtifact' | 'recordScriptCall'>;
    tools: SkillNativeToolPort;
    externalMounts?: SkillExternalReadMount[];
    sandbox?: SkillSandbox;
  }) {}

  describe(): Array<{ name: string; description: string }> {
    return [
      { name: 'package.list', description: '列出当前冻结 Skill 包内的全部文件。' },
      { name: 'package.read', description: '分块读取当前冻结 Skill 包内文件。参数：path，可选 offset、limit。' },
      {
        name: 'external.list',
        description: `递归列出已授权外部知识目录。参数：path。挂载：${(this.dependencies.externalMounts ?? []).map(({ id, logicalPath }) => `${id}=${logicalPath}`).join(', ') || '无（调用会返回缺少 SKILL_EXTERNAL_READ_MOUNTS）'}`,
      },
      { name: 'external.read', description: '分块读取已授权且按任务冻结的外部知识文件。参数：path，可选 offset、limit。' },
      { name: 'artifact.list', description: '列出当前任务已有 Artifact。' },
      { name: 'artifact.read', description: '分块读取文本或二进制 Artifact。参数：artifactId，可选 offset、limit。' },
      { name: 'artifact.write', description: '写入 Artifact。参数：path、mediaType、content、encoding、role、sourceArtifactIds。' },
      {
        name: 'script.run',
        description: this.dependencies.sandbox?.status().available
          ? '在隔离 OCI 容器运行包内 Node.js、Python 或 Bash 脚本。参数：runtime、scriptPath、arguments、inputs、outputs。输入位于 /inputs，输出写入 /outputs。'
          : `当前不可用：${this.dependencies.sandbox?.status().reason ?? 'SKILL_SANDBOX_IMAGE 未配置'}`,
      },
      { name: 'tool.invoke', description: `调用已授权只读 Tool。参数：toolId、input。可用：${this.dependencies.tools.list().map(({ id }) => id).join(', ') || '无'}` },
    ];
  }

  async execute(name: string, args: Record<string, unknown>, context: CapabilityContext): Promise<unknown> {
    if (name === 'package.list') return this.dependencies.packages.list(context.snapshot);
    if (name === 'package.read') {
      if (typeof args.path !== 'string') throw new Error('package.read requires path');
      const bytes = this.dependencies.packages.read(context.snapshot, args.path);
      return this.fileContent(args.path, bytes, args);
    }
    if (name === 'external.list') {
      if (typeof args.path !== 'string') throw new Error('external.list requires path');
      const opened = await this.openExternal(args.path, context);
      return {
        mountId: opened.snapshot.mountId,
        logicalPath: opened.snapshot.logicalPath,
        contentHash: opened.snapshot.contentHash,
        ...this.dependencies.packages.listExternal(opened.snapshot, opened.relativePath),
      };
    }
    if (name === 'external.read') {
      if (typeof args.path !== 'string') throw new Error('external.read requires path');
      const opened = await this.openExternal(args.path, context);
      if (!opened.relativePath) throw new Error('external.read requires a file path below the mount root');
      const bytes = this.dependencies.packages.readExternal(opened.snapshot, opened.relativePath);
      return {
        mountId: opened.snapshot.mountId,
        contentHash: opened.snapshot.contentHash,
        ...this.fileContent(args.path, bytes, args),
      };
    }
    if (name === 'artifact.list') {
      return this.dependencies.artifacts.listArtifacts({
        taskId: context.taskId,
        ownerUserId: context.ownerUserId,
        projectId: context.projectId,
      });
    }
    if (name === 'artifact.read') {
      if (typeof args.artifactId !== 'string') throw new Error('artifact.read requires artifactId');
      const artifact = await this.dependencies.artifacts.getArtifactOwned({
        artifactId: args.artifactId,
        taskId: context.taskId,
        ownerUserId: context.ownerUserId,
        projectId: context.projectId,
      });
      if (!artifact) throw new Error(`Artifact ${args.artifactId} does not exist`);
      return { artifact: this.metadata(artifact), ...this.fileContent(artifact.fileName, artifact.bytes, args) };
    }
    if (name === 'artifact.write') return this.writeArtifact(args, context);
    if (name === 'script.run') return this.runScript(args, context);
    if (name === 'tool.invoke') {
      if (typeof args.toolId !== 'string') throw new Error('tool.invoke requires toolId');
      if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
        throw new Error('tool.invoke requires an input object');
      }
      return this.dependencies.tools.invoke({
        toolId: args.toolId,
        arguments: args.input as object,
        invocationId: context.invocationId,
        signal: context.signal,
        attemptId: context.attemptId,
        scope: {
          taskId: context.taskId,
          ownerUserId: context.ownerUserId,
          projectId: context.projectId,
        },
      });
    }
    throw new Error(`capability ${name} is unavailable`);
  }

  readPackageText(context: CapabilityContext, path: string): string {
    const bytes = this.dependencies.packages.read(context.snapshot, path);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error(`Skill package file is not valid UTF-8 text: ${path}`);
    }
    return content;
  }

  async writeTextArtifact(input: {
    context: CapabilityContext;
    content: string;
    role: ArtifactRole;
    relativePath: string;
    mediaType?: string;
    sourceArtifactIds?: string[];
  }): Promise<TaskArtifact> {
    return this.writeArtifact({
      path: input.relativePath,
      mediaType: input.mediaType ?? 'text/markdown',
      content: input.content,
      encoding: 'utf8',
      role: input.role,
      sourceArtifactIds: input.sourceArtifactIds ?? [],
    }, input.context);
  }

  private async writeArtifact(args: Record<string, unknown>, context: CapabilityContext): Promise<TaskArtifact> {
    if (typeof args.path !== 'string') throw new Error('artifact.write requires path');
    const path = args.path;
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('artifact path must be a normalized relative path');
    }
    if (typeof args.mediaType !== 'string' || !args.mediaType.trim()) throw new Error('artifact.write requires mediaType');
    if (typeof args.content !== 'string') throw new Error('artifact.write requires string content');
    const encoding = args.encoding === 'base64' ? 'base64' : args.encoding === undefined || args.encoding === 'utf8' ? 'utf8' : null;
    if (!encoding) throw new Error('artifact encoding must be utf8 or base64');
    const role = args.role;
    if (role !== 'working' && role !== 'output' && role !== 'report') throw new Error('artifact role is invalid');
    const sourceArtifactIds = args.sourceArtifactIds === undefined
      ? []
      : Array.isArray(args.sourceArtifactIds) && args.sourceArtifactIds.every((id) => typeof id === 'string')
        ? [...new Set(args.sourceArtifactIds as string[])]
        : null;
    if (!sourceArtifactIds) throw new Error('sourceArtifactIds must be an array of strings');
    const bytes = Buffer.from(args.content, encoding);
    if (bytes.byteLength === 0) throw new Error('Artifact content must not be empty');
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds 10 MiB');
    const existing = await this.dependencies.artifacts.listArtifacts({
      taskId: context.taskId,
      ownerUserId: context.ownerUserId,
      projectId: context.projectId,
    });
    const existingIds = new Set(existing.map(({ id }) => id));
    const missingSource = sourceArtifactIds.find((id) => !existingIds.has(id));
    if (missingSource) throw new Error(`source Artifact ${missingSource} does not belong to this task`);
    const invocationBytes = existing
      .filter(({ invocationId }) => invocationId === context.invocationId)
      .reduce((total, artifact) => total + artifact.byteSize, 0);
    if (invocationBytes + bytes.byteLength > MAX_INVOCATION_ARTIFACT_BYTES) {
      throw new Error('Invocation Artifact output exceeds 64 MiB');
    }
    const artifact: SkillNativeArtifactInput = {
      id: randomUUID(),
      taskId: context.taskId,
      ownerUserId: context.ownerUserId,
      projectId: context.projectId,
      invocationId: context.invocationId,
      relativePath: path,
      fileName: basename(path),
      mediaType: args.mediaType.trim().toLowerCase(),
      role,
      bytes,
      contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sourceArtifactIds,
    };
    await this.dependencies.artifacts.writeArtifact(artifact, context.attemptId);
    return this.metadata({ ...artifact, bytes: Buffer.from(artifact.bytes) });
  }

  private metadata(artifact: SkillNativeArtifactRecord): TaskArtifact {
    return {
      id: artifact.id,
      ...(artifact.invocationId ? { invocationId: artifact.invocationId } : {}),
      relativePath: artifact.relativePath,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      role: artifact.role,
      byteSize: artifact.bytes.byteLength,
      contentSha256: artifact.contentSha256,
      sourceArtifactIds: [...artifact.sourceArtifactIds],
      ...(artifact.createdAt ? { createdAt: artifact.createdAt.toISOString() } : {}),
    };
  }

  private async openExternal(path: string, context: CapabilityContext): Promise<{
    snapshot: ExternalKnowledgeSnapshot;
    relativePath: string;
  }> {
    const requested = normalizedLogicalPath(path);
    const mount = [...(this.dependencies.externalMounts ?? [])]
      .sort((left, right) => right.logicalPath.length - left.logicalPath.length)
      .find(({ logicalPath }) => requested === logicalPath || requested.startsWith(`${logicalPath}/`));
    if (!mount) {
      throw new Error(`external path ${requested} is not mounted; configure SKILL_EXTERNAL_READ_MOUNTS`);
    }
    const expected = context.externalKnowledge.find(({ mountId }) => mountId === mount.id);
    const snapshot = this.dependencies.packages.snapshotExternal({
      taskId: context.taskId,
      snapshotKey: context.planKey,
      mountId: mount.id,
      logicalPath: mount.logicalPath,
      hostPath: mount.hostPath,
      ...(expected ? { expected } : {}),
    });
    if (!expected) await context.onExternalSnapshot?.(snapshot);
    return {
      snapshot,
      relativePath: requested === mount.logicalPath ? '' : requested.slice(mount.logicalPath.length + 1),
    };
  }

  private async runScript(args: Record<string, unknown>, context: CapabilityContext): Promise<unknown> {
    const sandbox = this.dependencies.sandbox;
    const availability = sandbox?.status();
    if (!sandbox || !availability?.available) {
      throw new Error(`script.run is unavailable: ${availability?.reason ?? 'SKILL_SANDBOX_IMAGE is not configured'}`);
    }
    if (args.runtime !== 'node' && args.runtime !== 'python' && args.runtime !== 'bash') {
      throw new Error('script.run runtime must be node, python, or bash');
    }
    if (typeof args.scriptPath !== 'string') throw new Error('script.run requires scriptPath');
    const scriptPath = this.normalizedArtifactPath(args.scriptPath, 'scriptPath');
    if (!context.snapshot.files.some(({ path }) => path === scriptPath)) {
      throw new Error(`script.run package file does not exist: ${scriptPath}`);
    }
    const scriptArguments = args.arguments === undefined ? [] : args.arguments;
    if (!Array.isArray(scriptArguments) || scriptArguments.some((value) => typeof value !== 'string')) {
      throw new Error('script.run arguments must be an array of strings');
    }
    const inputSpecs = args.inputs === undefined ? [] : args.inputs;
    if (!Array.isArray(inputSpecs)) throw new Error('script.run inputs must be an array');
    const inputs = [];
    const sourceArtifactIds: string[] = [];
    for (const [index, value] of inputSpecs.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`script.run inputs[${index}] must be an object`);
      }
      const item = value as Record<string, unknown>;
      if (typeof item.artifactId !== 'string' || typeof item.path !== 'string') {
        throw new Error(`script.run inputs[${index}] requires artifactId and path`);
      }
      const artifact = await this.dependencies.artifacts.getArtifactOwned({
        artifactId: item.artifactId,
        taskId: context.taskId,
        ownerUserId: context.ownerUserId,
        projectId: context.projectId,
      });
      if (!artifact) throw new Error(`script.run input Artifact ${item.artifactId} does not exist`);
      inputs.push({ path: this.normalizedArtifactPath(item.path, `inputs[${index}].path`), bytes: artifact.bytes });
      sourceArtifactIds.push(artifact.id);
    }
    const outputSpecs = args.outputs;
    if (!Array.isArray(outputSpecs) || outputSpecs.length === 0) {
      throw new Error('script.run outputs must be a non-empty array');
    }
    const outputs = outputSpecs.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`script.run outputs[${index}] must be an object`);
      }
      const item = value as Record<string, unknown>;
      if (typeof item.path !== 'string' || typeof item.mediaType !== 'string' || !item.mediaType.trim()) {
        throw new Error(`script.run outputs[${index}] requires path and mediaType`);
      }
      const role = item.role ?? 'output';
      if (role !== 'working' && role !== 'output' && role !== 'report') {
        throw new Error(`script.run outputs[${index}].role is invalid`);
      }
      return {
        path: this.normalizedArtifactPath(item.path, `outputs[${index}].path`),
        mediaType: item.mediaType.trim().toLowerCase(),
        role,
      } as const;
    });
    if (new Set(outputs.map(({ path }) => path)).size !== outputs.length) {
      throw new Error('script.run output paths must be unique');
    }
    const runtime = args.runtime as SandboxRuntime;
    const startedAt = new Date();
    let result;
    try {
      result = await sandbox.execute({
        packageRoot: this.dependencies.packages.snapshotRootPath(context.snapshot),
        scriptPath,
        runtime,
        arguments: scriptArguments as string[],
        inputs,
        outputs: outputs.map(({ path }) => path),
        readonlyMounts: context.externalKnowledge.map((snapshot) => ({
          logicalPath: snapshot.logicalPath,
          hostPath: this.dependencies.packages.externalRootPath(snapshot),
        })),
        signal: context.signal,
      });
    } catch (error) {
      await this.dependencies.artifacts.recordScriptCall?.({
        attemptId: context.attemptId,
        invocationId: context.invocationId,
        runtime,
        scriptPath,
        arguments: redactSensitiveValue(scriptArguments, { pii: 'mask' }) as unknown[],
        inputArtifactIds: [...new Set(sourceArtifactIds)],
        outputArtifactIds: [],
        status: 'failed',
        failure: safeError(error),
        startedAt,
        finishedAt: new Date(),
      });
      throw error;
    }
    const existing = await this.dependencies.artifacts.listArtifacts({
      taskId: context.taskId,
      ownerUserId: context.ownerUserId,
      projectId: context.projectId,
    });
    const existingBytes = existing
      .filter(({ invocationId }) => invocationId === context.invocationId)
      .reduce((total, artifact) => total + artifact.byteSize, 0);
    const outputBytes = result.outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
    if (existingBytes + outputBytes > MAX_INVOCATION_ARTIFACT_BYTES) {
      throw new Error('Invocation Artifact output exceeds 64 MiB');
    }
    const artifacts: TaskArtifact[] = [];
    for (const output of result.outputs) {
      const spec = outputs.find(({ path }) => path === output.path)!;
      const artifact: SkillNativeArtifactInput = {
        id: randomUUID(),
        taskId: context.taskId,
        ownerUserId: context.ownerUserId,
        projectId: context.projectId,
        invocationId: context.invocationId,
        relativePath: `outputs/${output.path}`,
        fileName: basename(output.path),
        mediaType: spec.mediaType,
        role: spec.role,
        bytes: output.bytes,
        contentSha256: `sha256:${createHash('sha256').update(output.bytes).digest('hex')}`,
        sourceArtifactIds: [...new Set(sourceArtifactIds)],
      };
      await this.dependencies.artifacts.writeArtifact(artifact, context.attemptId);
      artifacts.push(this.metadata({ ...artifact, bytes: Buffer.from(output.bytes) }));
    }
    await this.dependencies.artifacts.recordScriptCall?.({
      attemptId: context.attemptId,
      invocationId: context.invocationId,
      runtime,
      scriptPath,
      arguments: redactSensitiveValue(scriptArguments, { pii: 'mask' }) as unknown[],
      inputArtifactIds: [...new Set(sourceArtifactIds)],
      outputArtifactIds: artifacts.map(({ id }) => id),
      status: 'succeeded',
      startedAt,
      finishedAt: new Date(),
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, artifacts };
  }

  private normalizedArtifactPath(path: string, field: string): string {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`${field} must be a normalized relative path`);
    }
    return path;
  }

  private fileContent(
    path: string,
    bytes: Uint8Array,
    args: Record<string, unknown>,
  ): {
    encoding: 'utf8' | 'base64';
    content: string;
    byteSize: number;
    offset: number;
    returnedBytes: number;
    nextOffset: number | null;
  } {
    const offset = args.offset === undefined ? 0 : args.offset;
    const limit = args.limit === undefined ? DEFAULT_READ_BYTES : args.limit;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('read offset must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_READ_BYTES) {
      throw new Error(`read limit must be an integer between 1 and ${MAX_READ_BYTES}`);
    }
    const start = Number(offset);
    if (start > bytes.byteLength) throw new Error('read offset exceeds file size');
    const end = Math.min(bytes.byteLength, start + Number(limit));
    const chunk = Buffer.from(bytes).subarray(start, end);
    const textType = /\.(?:md|txt|json|ya?ml|csv|tsv|html?|css|js|mjs|cjs|ts|tsx|py|sh|svg)$/iu.test(path);
    return {
      encoding: textType ? 'utf8' : 'base64',
      content: textType ? chunk.toString('utf8') : chunk.toString('base64'),
      byteSize: bytes.byteLength,
      offset: start,
      returnedBytes: chunk.byteLength,
      nextOffset: end < bytes.byteLength ? end : null,
    };
  }
}
