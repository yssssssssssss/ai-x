import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Root } from '@openclaw/fs-safe';
import type {
  EvaluationManifest,
  LoadedEvaluationCase,
  SkillEvaluationRecord,
} from './types.ts';
import type { KBAssessment } from './kb/assessment.ts';
import type { KnowledgeContext, RetrievalRecord } from './kb/types.ts';

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


async function writeRootAtomic(
  root: Root,
  relativePath: string,
  content: string,
): Promise<void> {
  await root.write(relativePath, content, { overwrite: true });
}

async function writeRootJsonAtomic(
  root: Root,
  relativePath: string,
  value: unknown,
): Promise<void> {
  await root.writeJson(relativePath, value, {
    overwrite: true,
    space: 2,
    trailingNewline: true,
  });
}

function skillArtifactPath(skillId: string, filename: string): string {
  if (
    !skillId ||
    skillId === '.' ||
    skillId === '..' ||
    skillId.includes('/') ||
    skillId.includes('\\')
  ) {
    throw new Error(`Skill ID is not a safe root-relative path segment: ${skillId}`);
  }
  return `${skillId}/${filename}`;
}

async function removeRootArtifact(root: Root, relativePath: string): Promise<void> {
  if (await root.exists(relativePath)) await root.remove(relativePath);
}

export async function writeManifest(
  root: Root,
  manifest: EvaluationManifest,
): Promise<void> {
  await writeRootJsonAtomic(root, 'manifest.json', manifest);
}

export async function writeInputArtifact(
  root: Root,
  skillId: string,
  loadedCase: LoadedEvaluationCase,
): Promise<void> {
  await root.mkdir(skillId);
  await writeRootJsonAtomic(root, skillArtifactPath(skillId, 'input.json'), loadedCase.data);
}

export async function writeKbArtifacts(
  root: Root,
  skillId: string,
  artifacts: {
    knowledgeContext: KnowledgeContext;
    retrieval: RetrievalRecord;
    kbAssessment?: KBAssessment;
  },
): Promise<void> {
  await root.mkdir(skillId);
  await writeRootJsonAtomic(
    root,
    skillArtifactPath(skillId, 'knowledge-context.json'),
    artifacts.knowledgeContext,
  );
  await writeRootJsonAtomic(
    root,
    skillArtifactPath(skillId, 'retrieval.json'),
    artifacts.retrieval,
  );
  if (artifacts.kbAssessment !== undefined) {
    await writeRootJsonAtomic(
      root,
      skillArtifactPath(skillId, 'kb-assessment.json'),
      artifacts.kbAssessment,
    );
  }
}

export async function writeEvaluationArtifacts(
  root: Root,
  skillId: string,
  record: SkillEvaluationRecord,
): Promise<void> {
  await root.mkdir(skillId);
  const errorPath = skillArtifactPath(skillId, 'error.json');
  if (record.status === 'failed') {
    for (const filename of ['output.json', 'output.md', 'scorecard.json']) {
      await removeRootArtifact(root, skillArtifactPath(skillId, filename));
    }
    await writeRootJsonAtomic(root, errorPath, record);
    return;
  }

  await removeRootArtifact(root, errorPath);
  if (record.output !== undefined) {
    await writeRootJsonAtomic(root, skillArtifactPath(skillId, 'output.json'), record.output);
    await writeRootAtomic(
      root,
      skillArtifactPath(skillId, 'output.md'),
      `# ${record.skillId} evaluation output\n\n\`\`\`json\n${prettyJson(record.output)}\`\`\`\n`,
    );
  }
  if (record.scorecard !== undefined) {
    await writeRootJsonAtomic(root, skillArtifactPath(skillId, 'scorecard.json'), record.scorecard);
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

export async function writeSummaries(
  root: Root,
  records: SkillEvaluationRecord[],
): Promise<void> {
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
  await writeRootAtomic(root, 'summary.md', markdown);

  const csv = [
    csvCell(DISCLAIMER),
    columns.map((column) => csvCell(column)).join(','),
    ...values.map((row) => row.map((value) => csvCell(value)).join(',')),
    '',
  ].join('\n');
  await writeRootAtomic(root, 'summary.csv', csv);
}
