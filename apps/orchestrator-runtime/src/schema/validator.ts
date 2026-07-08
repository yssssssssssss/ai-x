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
  | 'decision-state'
  | 'execution-plan'
  | 'skill-manifest'
  | 'tool-manifest'
  | 'research-report';

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
    const validate = this.load(name);
    if (validate(data)) return [];
    return (validate.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
    );
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
