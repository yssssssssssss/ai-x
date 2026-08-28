import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EditorialContractError,
  createEditorialMaterialUnitId,
  parseEditorialMaterial,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  prepareEditorialCopyEditSession,
} from '../apps/orchestrator-runtime/src/report/editorial-copy-edit-session.ts';

const SOURCE_HASH = `sha256:${'1'.repeat(64)}` as const;
const PACKAGE_HASH = `sha256:${'2'.repeat(64)}` as const;
const REQUEST_KEY = `erq_${'a'.repeat(64)}`;

function unit(pointer: string, value: string, role: 'context' | 'claim' | 'risk') {
  const id = createEditorialMaterialUnitId({
    sourceArtifactId: 'deliverable-1',
    sourceArtifactContentSha256: SOURCE_HASH,
    sourceJsonPointer: pointer,
    role,
    value,
  });
  const common = {
    id,
    value,
    metricEligible: false,
    sourceRefs: [{ artifactId: 'deliverable-1', jsonPointer: pointer }],
    basisUnitIds: [] as string[],
    evidenceIds: role === 'claim' ? ['evidence-1'] : [],
    questionIds: [] as string[],
    requiredInOutput: true,
    requiredInBody: true,
  };
  if (role === 'claim') return { ...common, role, epistemicStatus: 'fact' as const };
  if (role === 'risk') return { ...common, role, epistemicStatus: 'unknown' as const };
  return { ...common, role };
}

function materialFixture() {
  const method = unit('/methodSummary', '基于已封存材料', 'context');
  const finding = unit('/findingGraph/findings/0/statement', '已有事实', 'claim');
  const risk = unit('/risksAndOpenIssues/0', '仍需验证', 'risk');
  return parseEditorialMaterial({
    version: 'editorial-material-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    deliverableType: 'research_plan',
    presentationMode: 'current_text',
    sourceReportPackage: {
      artifactId: 'package-1',
      kind: 'report_package',
      schemaVersion: 'report-package-v1',
      contentSha256: PACKAGE_HASH,
    },
    sourceArtifacts: [
      {
        artifactId: 'package-1',
        kind: 'report_package',
        schemaVersion: 'report-package-v1',
        contentSha256: PACKAGE_HASH,
      },
      {
        artifactId: 'deliverable-1',
        kind: 'deliverable',
        schemaVersion: 'research-deliverable-v1-review-gated',
        contentSha256: SOURCE_HASH,
      },
      {
        artifactId: 'evidence-artifact-1',
        kind: 'tool_output',
        schemaVersion: 'tool-output-v1',
        contentSha256: SOURCE_HASH,
      },
    ],
    materializationWarningCodes: [],
    methodSummaryUnitId: method.id,
    units: [method, finding, risk],
    assets: [],
    evidence: [{
      id: 'evidence-1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: 'evidence-artifact-1',
      artifactContentSha256: SOURCE_HASH,
      jsonPointer: '/value',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  });
}

test('Copy Edit Session exposes bounded targets and round-trips an accepted edit', () => {
  const material = materialFixture();
  const session = prepareEditorialCopyEditSession({ material, requestKey: REQUEST_KEY });
  assert.deepEqual(Object.keys(session.requestContext), ['version', 'targets']);
  assert.deepEqual(session.requestContext.targets[0], {
    copyPointer: '/deck',
    materialUnitId: material.methodSummaryUnitId,
    currentText: '基于已封存材料',
  });

  const editPlan = {
    version: 'editorial-copy-edit-plan-v1' as const,
    edits: [{
      copyPointer: '/deck',
      materialUnitId: material.methodSummaryUnitId,
      text: '以封存材料为依据，提炼关键判断',
    }],
  };
  const applied = session.apply(editPlan);

  assert.deepEqual(applied.blueprint.deck, {
    text: '以封存材料为依据，提炼关键判断',
    mode: 'paraphrase',
    materialUnitIds: [material.methodSummaryUnitId],
  });
  assert.deepEqual(applied.editPlan, editPlan);
  assert.deepEqual(session.replay(applied.blueprint), editPlan);
});

test('Copy Edit Session rejects unknown pointers and mismatched Unit bindings', () => {
  const material = materialFixture();
  const session = prepareEditorialCopyEditSession({ material, requestKey: REQUEST_KEY });
  const base = {
    version: 'editorial-copy-edit-plan-v1' as const,
    edits: [{
      copyPointer: '/missing',
      materialUnitId: material.methodSummaryUnitId,
      text: '更清晰的编辑表达',
    }],
  };
  assert.throws(
    () => session.apply(base),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'REFERENCE_INTEGRITY'
      && error.jsonPointer === '/edits/0/copyPointer',
  );

  const target = session.requestContext.targets[0]!;
  assert.throws(
    () => session.apply({
      ...base,
      edits: [{
        ...base.edits[0],
        copyPointer: target.copyPointer,
        materialUnitId: material.units[1]!.id,
      }],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'REFERENCE_INTEGRITY'
      && error.jsonPointer === '/edits/0/materialUnitId',
  );
});

test('Copy Edit Session rejects empty, hidden-control, visually unchanged, and non-canonical edits', () => {
  const material = materialFixture();
  const session = prepareEditorialCopyEditSession({ material, requestKey: REQUEST_KEY });
  const [first, second] = session.requestContext.targets;
  assert.ok(first && second);
  assert.throws(
    () => session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [{ copyPointer: first.copyPointer, materialUnitId: first.materialUnitId, text: '   ' }],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'SCHEMA_INTEGRITY'
      && error.jsonPointer === '/edits/0/text',
  );
  assert.throws(
    () => session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [{
        copyPointer: first.copyPointer,
        materialUnitId: first.materialUnitId,
        text: `  ${first.currentText}\n`,
      }],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'CONTENT_FIDELITY'
      && error.jsonPointer === '/edits/0/text',
  );
  assert.throws(
    () => session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [{
        copyPointer: first.copyPointer,
        materialUnitId: first.materialUnitId,
        text: `改写后的\u202e文案`,
      }],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'SCHEMA_INTEGRITY'
      && error.jsonPointer === '/edits/0/text',
  );
  assert.throws(
    () => session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [{
        copyPointer: first.copyPointer,
        materialUnitId: first.materialUnitId,
        text: `${first.currentText}\u200b`,
      }],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'SCHEMA_INTEGRITY'
      && error.jsonPointer === '/edits/0/text',
  );
  assert.throws(
    () => session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [
        { copyPointer: second.copyPointer, materialUnitId: second.materialUnitId, text: '后序目标的编辑文案' },
        { copyPointer: first.copyPointer, materialUnitId: first.materialUnitId, text: '前序目标的编辑文案' },
      ],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'SCHEMA_INTEGRITY'
      && error.jsonPointer === '/edits',
  );
  assert.throws(
    () => session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [
        { copyPointer: first.copyPointer, materialUnitId: first.materialUnitId, text: '改写后的封存材料说明' },
        { copyPointer: first.copyPointer, materialUnitId: first.materialUnitId, text: '重复目标编辑文案' },
      ],
    }),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'SCHEMA_INTEGRITY'
      && error.jsonPointer === '/edits/1/copyPointer',
  );
});

test('Copy Edit Session rejects invisible and formatting Unicode characters', () => {
  const material = materialFixture();
  const session = prepareEditorialCopyEditSession({ material, requestKey: REQUEST_KEY });
  const target = session.requestContext.targets[0]!;

  for (const invisible of [
    '\u034f',
    '\u200d',
    '\ufe0f',
    '\u{e0061}',
    '\ufff9',
    '\ufffa',
    '\ufffb',
    '\u0600',
    '\u2800',
  ]) {
    assert.throws(
      () => session.apply({
        version: 'editorial-copy-edit-plan-v1',
        edits: [{
          copyPointer: target.copyPointer,
          materialUnitId: target.materialUnitId,
          text: `安全链接 https${invisible}://example.com`,
        }],
      }),
      (error: unknown) => error instanceof EditorialContractError
        && error.code === 'SCHEMA_INTEGRITY'
        && error.jsonPointer === '/edits/0/text',
      `U+${invisible.codePointAt(0)!.toString(16).toUpperCase()}`,
    );
  }

  for (const text of ['改写后\n文案', '改写后\t文案', '普通非 BMP 字符：𠀀']) {
    assert.equal(session.apply({
      version: 'editorial-copy-edit-plan-v1',
      edits: [{
        copyPointer: target.copyPointer,
        materialUnitId: target.materialUnitId,
        text,
      }],
    }).blueprint.deck.text, text);
  }
});

test('Copy Edit Session replay rejects structural drift outside accepted edits', () => {
  const material = materialFixture();
  const session = prepareEditorialCopyEditSession({ material, requestKey: REQUEST_KEY });
  const target = session.requestContext.targets[0]!;
  const applied = session.apply({
    version: 'editorial-copy-edit-plan-v1',
    edits: [{
      copyPointer: target.copyPointer,
      materialUnitId: target.materialUnitId,
      text: '将封存材料整理为清晰判断',
    }],
  });
  const drifted = structuredClone(applied.blueprint);
  drifted.sections[0]!.id = 'forged-section';

  assert.throws(
    () => session.replay(drifted),
    (error: unknown) => error instanceof EditorialContractError
      && error.code === 'CONTENT_FIDELITY',
  );
});
