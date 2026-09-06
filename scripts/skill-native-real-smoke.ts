import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { closePool, pool } from '../database/db.ts';
import { getUserById } from '../database/users.ts';
import { buildSkillNativeRuntime } from '../apps/agent-api/src/skill-native-runtime.ts';
import { SkillPackageStore } from '../apps/orchestrator-runtime/src/skill-native/package-store.ts';
import { DockerSandboxExecutor } from '../apps/orchestrator-runtime/src/skill-native/sandbox-executor.ts';
import { redactString } from '../apps/orchestrator-runtime/src/runtime/redaction.ts';
import type {
  OrchestrationMode,
  SkillNativeTaskView,
} from '../packages/api-contract/skill-native.ts';

const DEFAULT_OWNER_USER_ID = '00000000-0000-0000-0000-000000000001';
const REQUIRED_ENV = [
  'DATABASE_URL',
  'LLM_GATEWAY_BASE_URL',
  'LLM_GATEWAY_API_KEY',
  'SKILL_SANDBOX_IMAGE',
] as const;

export interface NativeRealSmokeReceipt {
  taskId: string;
  mode: OrchestrationMode;
  skillIds: string[];
  state: 'completed';
  primaryArtifact: {
    id: string;
    mediaType: string;
    byteSize: number;
    contentSha256: string;
  };
  modelCallCount: number;
}

export interface SandboxSmokeReceipt {
  packageId: 'journey-map';
  image: string;
  outputByteSize: number;
  outputSha256: string;
}

function nonBlank(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be non-empty`);
  return value;
}

export function assertNativeRealSmokeConfig(env: NodeJS.ProcessEnv): {
  ownerUserId: string;
  sandboxImage: string;
} {
  if (env.ALLOW_REAL_PROVIDER !== '1') throw new Error('ALLOW_REAL_PROVIDER must be exactly 1');
  if (env.LLM_PROVIDER !== 'gateway') throw new Error('LLM_PROVIDER must be exactly gateway');
  if (env.TOOL_ADAPTER !== 'real') throw new Error('TOOL_ADAPTER must be exactly real');
  if (env.ZERO_PUBLICATION_ENABLED === 'true') {
    throw new Error('ZERO_PUBLICATION_ENABLED must remain disabled during the native smoke');
  }
  for (const name of REQUIRED_ENV) nonBlank(env, name);
  if (!env.LLM_MODEL_ROUTES?.trim()) {
    nonBlank(env, 'LLM_MODEL_NAME');
    nonBlank(env, 'LLM_EXPECTED_ACTUAL_MODEL');
  }
  const sandboxImage = nonBlank(env, 'SKILL_SANDBOX_IMAGE');
  if (!/@sha256:[a-f0-9]{64}$/u.test(sandboxImage)) {
    throw new Error('SKILL_SANDBOX_IMAGE must use an immutable sha256 digest');
  }
  return {
    ownerUserId: env.SKILL_NATIVE_SMOKE_OWNER_USER_ID?.trim() || DEFAULT_OWNER_USER_ID,
    sandboxImage,
  };
}

function selectedCandidate(task: SkillNativeTaskView) {
  const recommended = task.candidates.filter(({ recommended }) => recommended);
  if (recommended.length !== 1) throw new Error(`${task.orchestrationMode} planning must return one recommended candidate`);
  return recommended[0]!;
}

async function modelCallCount(taskId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM skill_native_model_calls calls
     JOIN skill_native_attempts attempts ON attempts.id = calls.attempt_id
     WHERE attempts.task_id = $1
       AND calls.status = 'succeeded'
       AND calls.actual_model <> 'unknown'`,
    [taskId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function runTask(input: {
  ownerUserId: string;
  mode: OrchestrationMode;
  originalInput: string;
  expectedSkillIds: string[];
  materials: Record<string, string | string[]>;
}): Promise<NativeRealSmokeReceipt> {
  const tasks = buildSkillNativeRuntime().tasks;
  const created = await tasks.create(input.ownerUserId, {
    originalInput: input.originalInput,
    orchestrationMode: input.mode,
    projectId: `skill-native-real-smoke:${randomUUID()}`,
    inputs: Object.fromEntries(Object.entries(input.materials).map(([label, value]) => [
      label,
      { source: 'conversation' as const, value },
    ])),
  });
  const candidate = selectedCandidate(created);
  const actualSkillIds = candidate.skills.map(({ skillId }) => skillId);
  if (input.mode === 'single_skill' && actualSkillIds.length !== 1) {
    throw new Error('Single smoke candidate must contain exactly one Skill');
  }
  if (input.mode === 'multi_skill' && actualSkillIds.length < 2) {
    throw new Error('Multi smoke candidate must contain at least two Skills');
  }
  for (const skillId of input.expectedSkillIds) {
    if (!actualSkillIds.includes(skillId)) throw new Error(`${input.mode} smoke did not select ${skillId}`);
  }
  const selected = await tasks.select({
    taskId: created.id,
    ownerUserId: input.ownerUserId,
    expectedVersion: created.stateVersion,
    candidateId: candidate.candidateId,
  });
  const confirmed = await tasks.confirm({
    taskId: selected.id,
    ownerUserId: input.ownerUserId,
    body: { expectedVersion: selected.stateVersion, answers: {} },
  });
  const completed = await tasks.execute({
    taskId: confirmed.id,
    ownerUserId: input.ownerUserId,
    expectedVersion: confirmed.stateVersion,
  });
  if (completed.state === 'waiting_for_user') {
    throw new Error(`${input.mode} smoke requested unexpected user input: ${completed.pendingQuestions.map(({ prompt }) => prompt).join('；')}`);
  }
  if (completed.state !== 'completed' || completed.result?.status !== 'complete') {
    throw new Error(`${input.mode} smoke ended as ${completed.state}: ${completed.failure ?? completed.result?.summary ?? 'unknown'}`);
  }
  if (completed.result.gaps.length > 0 || completed.result.missingCapabilities.length > 0) {
    throw new Error(`${input.mode} smoke completed with undeclared gaps`);
  }
  const artifactId = completed.result.primaryArtifactId;
  if (!artifactId) throw new Error(`${input.mode} smoke did not produce a primary Artifact`);
  const artifact = await tasks.artifact(completed.id, input.ownerUserId, artifactId);
  if (!artifact || artifact.bytes.byteLength === 0) throw new Error(`${input.mode} smoke primary Artifact is empty`);
  const calls = await modelCallCount(completed.id);
  if (calls === 0) throw new Error(`${input.mode} smoke has no successful real model receipt`);
  return {
    taskId: completed.id,
    mode: input.mode,
    skillIds: actualSkillIds,
    state: 'completed',
    primaryArtifact: {
      id: artifact.id,
      mediaType: artifact.mediaType,
      byteSize: artifact.bytes.byteLength,
      contentSha256: artifact.contentSha256,
    },
    modelCallCount: calls,
  };
}

export async function runSandboxSmoke(sandboxImage: string): Promise<SandboxSmokeReceipt> {
  const packages = new SkillPackageStore();
  const descriptor = packages.discover().packages.find(({ id }) => id === 'journey-map');
  if (!descriptor) throw new Error('journey-map package is unavailable');
  const snapshot = packages.snapshot(`sandbox-smoke-${randomUUID()}`, descriptor);
  const sandbox = new DockerSandboxExecutor({ image: sandboxImage });
  const spec = Buffer.from(JSON.stringify({ project_title: 'Skill runtime smoke', maps: [] }), 'utf8');
  const result = await sandbox.execute({
    packageRoot: packages.snapshotRootPath(snapshot),
    scriptPath: 'scripts/render_journey_map.py',
    runtime: 'python',
    arguments: ['/inputs/spec.json', '/outputs/journey-map.html'],
    inputs: [{ path: 'spec.json', bytes: spec }],
    outputs: ['journey-map.html'],
    readonlyMounts: [],
    signal: AbortSignal.timeout(120_000),
  });
  const output = result.outputs.find(({ path }) => path === 'journey-map.html');
  if (!output || !/^<!doctype html>/iu.test(output.bytes.toString('utf8'))) {
    throw new Error('sandbox smoke did not produce the expected HTML Artifact');
  }
  return {
    packageId: 'journey-map',
    image: sandboxImage,
    outputByteSize: output.bytes.byteLength,
    outputSha256: `sha256:${createHash('sha256').update(output.bytes).digest('hex')}`,
  };
}

export async function runNativeRealSmoke(env: NodeJS.ProcessEnv = process.env) {
  const config = assertNativeRealSmokeConfig(env);
  const user = await getUserById(config.ownerUserId);
  if (!user || user.status !== 'active') throw new Error('Smoke owner is missing or inactive; run pnpm db:seed');

  const single = await runTask({
    ownerUserId: user.id,
    mode: 'single_skill',
    expectedSkillIds: ['issue-prioritization'],
    originalInput: [
      '这是无人值守真实冒烟。使用 issue-prioritization 对已提供的问题做一次版本优先级排序。',
      '材料已经完整，不要追问；只使用给定材料，不做网页搜索。',
      '输出可直接评审的排序报告，并明确数据不足处，不得编造。',
    ].join(''),
    materials: {
      '问题清单': [
        '支付按钮偶发无响应：近 7 日影响 120 人，预计修复 2 人日。',
        '搜索筛选会重置：近 7 日影响 460 人，预计修复 1 人日。',
        '订单页文案不一致：近 7 日影响 35 人，预计修复 0.5 人日。',
      ],
      '决策场景': '下一个双周版本排期；优先降低关键路径阻断，同时考虑研发成本。',
    },
  });
  const multi = await runTask({
    ownerUserId: user.id,
    mode: 'multi_skill',
    expectedSkillIds: ['code-open-feedback', 'issue-prioritization'],
    originalInput: [
      '这是无人值守真实冒烟。先使用 code-open-feedback 对反馈编码归类，再使用 issue-prioritization 对形成的问题排序。',
      '材料已经完整，不要追问；只使用给定材料，不做网页搜索。',
      '两个 Skill 必须串行执行，最后生成一份可直接评审的综合报告，不得编造。',
    ].join(''),
    materials: {
      '开放反馈': [
        '用户 A：搜索后切换品牌筛选，之前选择的价格区间消失。',
        '用户 B：支付按钮点了两次都没有反应，重新进入订单后才成功。',
        '用户 C：筛选条件总被清空，只能反复选择。',
        '用户 D：订单详情和支付页对优惠金额的叫法不一致。',
        '用户 E：支付无响应时不知道是否已经扣款。',
      ],
      '决策约束': '用于下一个双周版本；支付链路阻断优先，研发成本以低/中/高估算。',
    },
  });
  const sandbox = await runSandboxSmoke(config.sandboxImage);
  return { single, multi, sandbox };
}

async function main(): Promise<void> {
  try {
    const config = assertNativeRealSmokeConfig(process.env);
    if (process.argv.includes('--preflight')) {
      console.log(JSON.stringify({ status: 'ready', ownerUserId: config.ownerUserId, sandboxImage: config.sandboxImage }));
      return;
    }
    console.log(JSON.stringify(await runNativeRealSmoke(), null, 2));
  } catch (error) {
    const message = redactString(error instanceof Error ? error.message : String(error));
    console.error(`Skill-native real smoke failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) void main();
