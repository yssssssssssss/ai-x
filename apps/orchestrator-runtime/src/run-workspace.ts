import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Run Workspace:任务运行期中间文件真相源(方案 §2.4)。
// 大对象/中间文件不进 PG,只在此落盘;DB 只存 run_workspace_uri 引用。

const ROOT = process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';
const configuredMaxMediaBytes = Number(process.env.MEDIA_MAX_BYTES);
const MAX_MEDIA_BYTES = Number.isFinite(configuredMaxMediaBytes) && configuredMaxMediaBytes > 0
  ? configuredMaxMediaBytes
  : 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class RunWorkspace {
  readonly dir: string;

  constructor(public readonly taskId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('非法 taskId');
    this.dir = join(ROOT, taskId);
  }

  get uri(): string {
    return this.dir;
  }

  ensure(): void {
    mkdirSync(join(this.dir, 'tool_outputs'), { recursive: true });
    mkdirSync(join(this.dir, 'artifacts'), { recursive: true });
    mkdirSync(join(this.dir, 'media'), { recursive: true });
    mkdirSync(join(this.dir, 'context_manifests'), { recursive: true });
  }

  private writeJson(name: string, data: unknown): string {
    const p = join(this.dir, name);
    writeFileSync(p, JSON.stringify(data, null, 2));
    return p;
  }

  writePlan(plan: unknown): string {
    return this.writeJson('plan.json', plan);
  }

  readPlan<T>(): T {
    const p = join(this.dir, 'plan.json');
    if (!existsSync(p)) throw new Error(`plan.json 不存在,请先运行 spike:plan: ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }

  // 候选计划:planPhase 一次产出 N 份候选,selectPlan 选中后再 writePlan。
  writeCandidates(candidates: unknown): string {
    return this.writeJson('plan_candidates.json', candidates);
  }

  readCandidates<T>(): T {
    const p = join(this.dir, 'plan_candidates.json');
    if (!existsSync(p)) throw new Error(`plan_candidates.json 不存在: ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }

  writeDecisionStates(states: unknown): string {
    return this.writeJson('decision_states.json', states);
  }

  // context_manifest:每次 LLM 调用可回放"为什么这条信息在上下文里"
  writeContextManifest(manifest: unknown): string {
    return this.writeJson('context_manifest.json', manifest);
  }

  // 执行期每次模型调用各自留存上下文清单，避免覆盖计划阶段的可回放记录。
  writeInvocationContextManifest(name: string, manifest: unknown): string {
    this.ensure();
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const p = join(this.dir, 'context_manifests', `${safeName}.json`);
    writeFileSync(p, JSON.stringify(manifest, null, 2));
    return p;
  }

  writeMediaAsset(input: { role: string; mimeType: string; data: Buffer; fileName?: string }): MediaAsset {
    this.ensure();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.role)) throw new Error('非法媒体角色');
    if (!IMAGE_MIME_TYPES.has(input.mimeType)) throw new Error(`不支持的媒体类型: ${input.mimeType}`);
    if (input.data.length === 0 || input.data.length > MAX_MEDIA_BYTES) {
      throw new Error(`媒体大小必须在 1-${MAX_MEDIA_BYTES} 字节之间`);
    }
    if (!matchesImageSignature(input.mimeType, input.data)) throw new Error('媒体内容与 Content-Type 不匹配');
    const id = randomUUID();
    const extension = mimeToExtension(input.mimeType);
    const fileName = `${id}.${extension}`;
    const storagePath = join(this.dir, 'media', fileName);
    writeFileSync(storagePath, input.data);
    const asset: MediaAsset = {
      id,
      role: input.role,
      mimeType: input.mimeType,
      bytes: input.data.length,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      fileName: input.fileName,
      storageUri: storagePath,
      createdAt: new Date().toISOString(),
    };
    this.writeMediaIndex([...this.readMediaAssets(), asset]);
    return asset;
  }

  readMediaAsset(assetId: string): MediaAsset {
    const asset = this.readMediaAssets().find((item) => item.id === assetId);
    if (!asset) throw new Error(`媒体资产不存在: ${assetId}`);
    return asset;
  }

  readMediaData(assetId: string): Buffer {
    const asset = this.readMediaAsset(assetId);
    const mediaDir = resolve(this.dir, 'media');
    const storagePath = resolve(asset.storageUri);
    if (!storagePath.startsWith(`${mediaDir}${sep}`)) throw new Error('媒体路径越界');
    const data = readFileSync(storagePath);
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== asset.sha256) throw new Error(`媒体资产校验失败: ${assetId}`);
    return data;
  }

  readMediaDataUrl(assetId: string): string {
    const asset = this.readMediaAsset(assetId);
    return `data:${asset.mimeType};base64,${this.readMediaData(assetId).toString('base64')}`;
  }

  readMediaAssets(): MediaAsset[] {
    const p = join(this.dir, 'media', 'assets.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as MediaAsset[] : [];
  }

  private writeMediaIndex(assets: MediaAsset[]): void {
    const target = join(this.dir, 'media', 'assets.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(assets, null, 2));
    renameSync(temporary, target);
  }

  writeToolOutput(stepNo: number, output: unknown): string {
    const p = join(this.dir, 'tool_outputs', `step${stepNo}.json`);
    writeFileSync(p, JSON.stringify(output, null, 2));
    return p;
  }

  // resume 时读回单步已落盘输出,重建 toolOutputs(不重放前序步)。
  readToolOutput<T>(stepNo: number): T {
    const p = join(this.dir, 'tool_outputs', `step${stepNo}.json`);
    if (!existsSync(p)) throw new Error(`tool_outputs/step${stepNo}.json 不存在: ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }

  // run_state:执行中断点。停在失败步时落盘,resume 据此重建上下文并从下一步续跑。
  writeRunState(state: unknown): string {
    return this.writeJson('run_state.json', state);
  }

  readRunState<T>(): T {
    const p = join(this.dir, 'run_state.json');
    if (!existsSync(p)) throw new Error(`run_state.json 不存在(任务未处于可恢复状态): ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }

  writeArtifactFile(name: string, content: string): string {
    const p = join(this.dir, 'artifacts', name);
    writeFileSync(p, content);
    return p;
  }

  // 失败记录:每行一条 JSON,用于回放与规则补强(不只留日志)
  appendFailure(record: {
    task_id: string;
    stage: string;
    selected_skill?: string;
    selected_tool?: string;
    input_ref?: string;
    output_ref?: string;
    error_type: string;
    error_message: string;
    context_manifest_ref?: string;
  }): string {
    const p = join(this.dir, 'failures.jsonl');
    appendFileSync(p, JSON.stringify(record) + '\n');
    return p;
  }
}

export interface MediaAsset {
  id: string;
  role: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  fileName?: string;
  storageUri: string;
  createdAt: string;
}

function mimeToExtension(mimeType: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mimeType] ?? 'bin';
}

function matchesImageSignature(mimeType: string, data: Buffer): boolean {
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/gif') return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}
