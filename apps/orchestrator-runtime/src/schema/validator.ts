import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

// schema 校验器:段1/段2/段4 的 LLM 结构化输出、tool 输入输出都过这里。
// 校验不通过即抛错或触发重试——"所有输出必须满足 schema 校验"的硬约束落点。

// 所有命令经 pnpm scripts 从项目根运行,cwd 恒为项目根。
const schemasDir = join(process.cwd(), 'schemas');

export type SchemaName =
  | 'research-task'
  | 'research-task-v2'
  | 'decision-state'
  | 'problem-graph'
  | 'capability-demand-graph-v1'
  | 'execution-plan'
  | 'current-execution-plan'
  | 'current-execution-plan-v3'
  | 'current-plan-candidates'
  | 'skill-manifest'
  | 'tool-manifest'
  | 'research-report'
  | 'research-contribution-v1'
  | 'contribution-ledger-v1'
  | 'scenario-guidance'
  | 'report-review';

// checkReportReferences 消费的最小形状(结构由 ajv 保证,此处只取引用完整性所需字段)。
interface ResearchReportShape {
  findings: Array<{ id: string }>;
  sub_questions: Array<{
    finding_ids: string[];
    analysis: Array<{ based_on: string[] }>;
  }>;
}

export class SchemaValidator {
  private readonly ajv: Ajv;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(customSchemasDir?: string) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this.dir = customSchemasDir ?? schemasDir;
  }

  private readonly dir: string;

  // 按 schemas/{name}.schema.json 加载(项目标准 schema)
  private load(name: string): ValidateFunction {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const raw = JSON.parse(readFileSync(join(this.dir, `${name}.schema.json`), 'utf8'));
    const validate = this.ajv.compile(raw);
    this.cache.set(name, validate);
    return validate;
  }

  // 按任意文件路径加载 schema(用于 tool/skill 目录下的 input/output schema)。
  // 删除 $id 避免 ajv 跨 schema 的 $id 冲突/重复注册。
  private loadFromPath(absPath: string): ValidateFunction {
    const cached = this.cache.get(absPath);
    if (cached) return cached;
    const raw = JSON.parse(readFileSync(absPath, 'utf8'));
    delete raw.$id;
    const validate = this.ajv.compile(raw);
    this.cache.set(absPath, validate);
    return validate;
  }

  // 返回错误信息数组;空数组表示通过。
  validate(name: SchemaName | string, data: unknown): string[] {
    const schemaName = name === 'current-execution-plan'
      && typeof data === 'object'
      && data !== null
      && 'execution_contract_version' in data
      && data.execution_contract_version === 'current-execution-plan-v3'
      ? 'current-execution-plan-v3'
      : name;
    const validate = this.load(schemaName);
    const structural = validate(data)
      ? []
      : (validate.errors ?? []).map(
          (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
        );
    // research-report:draft-07 表达不了跨数组引用,结构通过后追加受控语义校验。
    if (name === 'research-report' && structural.length === 0) {
      return this.checkReportReferences(data as ResearchReportShape);
    }
    return structural;
  }

  // based_on / finding_ids 引用的发现 id 必须真实存在于 findings 全局证据池。
  private checkReportReferences(report: ResearchReportShape): string[] {
    const ids = new Set(report.findings.map((f) => f.id));
    const errors: string[] = [];
    report.sub_questions.forEach((sq, qi) => {
      sq.finding_ids.forEach((fid) => {
        if (!ids.has(fid)) {
          errors.push(`/sub_questions/${qi}/finding_ids 引用不存在的发现 id ${fid}`);
        }
      });
      sq.analysis.forEach((a, ai) => {
        a.based_on.forEach((fid) => {
          if (!ids.has(fid)) {
            errors.push(`/sub_questions/${qi}/analysis/${ai}/based_on 引用不存在的发现 id ${fid}`);
          }
        });
      });
    });
    return errors;
  }

  // 硬校验:不合规直接抛错。用于 tool 输入、报告入库等不可降级场景。
  validateOrThrow(name: SchemaName | string, data: unknown): void {
    const errors = this.validate(name, data);
    if (errors.length > 0) {
      throw new SchemaValidationError(name, errors);
    }
  }

  // 按文件路径校验(tool/skill 目录下的 schema)。返回错误数组,空=通过。
  validateFile(absPath: string, data: unknown): string[] {
    const validate = this.loadFromPath(absPath);
    if (validate(data)) return [];
    return (validate.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
    );
  }

  validateFileOrThrow(absPath: string, data: unknown): void {
    const errors = this.validateFile(absPath, data);
    if (errors.length > 0) throw new SchemaValidationError(absPath, errors);
  }

  validateSchemaOrThrow(schema: object, value: unknown, label: string): void {
    const validate = this.ajv.compile(schema);
    if (validate(value)) return;
    const errors = (validate.errors ?? []).map(
      (error) => `${error.instancePath || '(root)'} ${error.message ?? 'invalid'}`,
    );
    throw new SchemaValidationError(label, errors);
  }

  // 软校验:不合规先重试一次(regenerate),仍失败则由调用方降级为 need_clarify。
  // regenerate 返回新数据;返回 null 视为放弃。
  async validateOrRetry<T>(
    name: SchemaName | string,
    first: T,
    regenerate: () => Promise<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; errors: string[] }> {
    let errors = this.validate(name, first);
    if (errors.length === 0) return { ok: true, data: first };

    const second = await regenerate();
    errors = this.validate(name, second);
    if (errors.length === 0) return { ok: true, data: second };

    return { ok: false, errors };
  }
}

export class SchemaValidationError extends Error {
  constructor(
    public readonly schemaName: string,
    public readonly errors: string[],
  ) {
    super(`schema "${schemaName}" validation failed:\n  - ${errors.join('\n  - ')}`);
    this.name = 'SchemaValidationError';
  }
}
