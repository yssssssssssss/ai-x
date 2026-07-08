import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Run Workspace:任务运行期中间文件真相源(方案 §2.4)。
// 大对象/中间文件不进 PG,只在此落盘;DB 只存 run_workspace_uri 引用。

const ROOT = process.env.RUN_WORKSPACE_ROOT ?? './run-workspaces';

export class RunWorkspace {
  readonly dir: string;

  constructor(public readonly taskId: string) {
    this.dir = join(ROOT, taskId);
  }

  get uri(): string {
    return this.dir;
  }

  ensure(): void {
    mkdirSync(join(this.dir, 'tool_outputs'), { recursive: true });
    mkdirSync(join(this.dir, 'artifacts'), { recursive: true });
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

  writeDecisionStates(states: unknown): string {
    return this.writeJson('decision_states.json', states);
  }

  // context_manifest:每次 LLM 调用可回放"为什么这条信息在上下文里"
  writeContextManifest(manifest: unknown): string {
    return this.writeJson('context_manifest.json', manifest);
  }

  writeToolOutput(stepNo: number, output: unknown): string {
    const p = join(this.dir, 'tool_outputs', `step${stepNo}.json`);
    writeFileSync(p, JSON.stringify(output, null, 2));
    return p;
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
