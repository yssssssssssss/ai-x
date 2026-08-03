import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  EvaluationManifest,
  LoadedEvaluationCase,
  SkillEvaluationRecord,
} from './types.ts';

const DISCLAIMER = '自动评分仅供人工评估参考';

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, 'utf8');
  renameSync(temporaryPath, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeAtomic(path, prettyJson(value));
}

export function writeManifest(
  runDirectory: string,
  manifest: EvaluationManifest,
): void {
  writeJsonAtomic(join(runDirectory, 'manifest.json'), manifest);
}

export function writeInputArtifact(
  skillDirectory: string,
  loadedCase: LoadedEvaluationCase,
): void {
  writeJsonAtomic(join(skillDirectory, 'input.json'), loadedCase.data);
}

export function writeEvaluationArtifacts(
  skillDirectory: string,
  record: SkillEvaluationRecord,
): void {
  if (record.status === 'failed') {
    writeJsonAtomic(join(skillDirectory, 'error.json'), record);
    return;
  }

  if (record.output !== undefined) {
    writeJsonAtomic(join(skillDirectory, 'output.json'), record.output);
    writeAtomic(
      join(skillDirectory, 'output.md'),
      `# ${record.skillId} evaluation output\n\n\`\`\`json\n${prettyJson(record.output)}\`\`\`\n`,
    );
  }
  if (record.scorecard !== undefined) {
    writeJsonAtomic(join(skillDirectory, 'scorecard.json'), record.scorecard);
  }
}

function summaryRecords(
  records: SkillEvaluationRecord[],
): SkillEvaluationRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftScore = left.record.scorecard?.total_score;
      const rightScore = right.record.scorecard?.total_score;
      if (leftScore === null || leftScore === undefined) {
        return rightScore === null || rightScore === undefined
          ? left.index - right.index
          : 1;
      }
      if (rightScore === null || rightScore === undefined) return -1;
      return rightScore - leftScore || left.index - right.index;
    })
    .map(({ record }) => record);
}

function renderList(values: string[] | undefined): string {
  return values?.join('; ') ?? '';
}

function markdownCell(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', '<br>');
}

function csvCell(value: string | number | null | undefined): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

export function writeSummaries(
  runDirectory: string,
  records: SkillEvaluationRecord[],
): void {
  const rows = summaryRecords(records);
  const columns = [
    'skill',
    'status',
    'verdict',
    'total score',
    'elapsed ms',
    'model',
    'critical defects',
    'review notes',
  ];
  const values = rows.map((record) => [
    record.skillId,
    record.status,
    record.scorecard?.verdict,
    record.scorecard?.total_score,
    record.elapsedMs,
    [record.modelName, record.modelVersion].filter(Boolean).join(' '),
    renderList(record.scorecard?.critical_defects),
    renderList(record.scorecard?.review_notes),
  ]);

  const markdown = [
    '# Skill evaluation summary',
    '',
    `> ${DISCLAIMER}`,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...values.map(
      (row) => `| ${row.map((value) => markdownCell(value)).join(' | ')} |`,
    ),
    '',
  ].join('\n');
  writeAtomic(join(runDirectory, 'summary.md'), markdown);

  const csv = [
    csvCell(DISCLAIMER),
    columns.map((column) => csvCell(column)).join(','),
    ...values.map((row) => row.map((value) => csvCell(value)).join(',')),
    '',
  ].join('\n');
  writeAtomic(join(runDirectory, 'summary.csv'), csv);
}
