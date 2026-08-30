import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bindEditorialShowcaseEvidenceManifest,
  compileEditorialShowcase,
  createDeterministicEditorialShowcaseSpec,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import {
  EDITORIAL_SHOWCASE_RENDERER_VERSION,
  renderEditorialShowcase,
} from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-renderer.ts';
import {
  SHOWCASE_FIXTURE_SHA,
  showcaseEvidenceManifestFixture,
  showcaseIntentFixture,
  showcaseMaterialFixture,
} from './fixtures/report-editorial/showcase-fixtures.ts';

test('renderer produces traceable offline desktop HTML without image or script dependencies', () => {
  const material = showcaseMaterialFixture();
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;
  const result = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.equal(result.renderManifest.rendererVersion, EDITORIAL_SHOWCASE_RENDERER_VERSION);
  assert.equal(result.renderManifest.showcaseOutlineSignature, spec.showcaseOutlineSignature);
  assert.match(result.html, /^<!doctype html>/u);
  assert.match(result.html, /data-showcase-profile="editorial-showcase-v1"/u);
  assert.match(result.html, /当前状态仍需验证/u);
  assert.equal(result.html.match(/当前状态仍需验证。/gu)?.length, 1);
  assert.match(result.html, /支持者/u);
  assert.match(result.html, /支持后进入履约关注/u);
  assert.doesNotMatch(result.html, /<h4>P2<\/h4>/u);
  assert.match(result.html, /验证入口与链路/u);
  assert.match(result.html, /当前是否仍有稳定入口/u);
  assert.match(result.html, /data-component-id="showcase-component-001-001"/u);
  assert.match(result.html, /data-source-leaf-ids="leaf-answer"/u);
  assert.match(result.html, /置信度仅表示来源支持强度，不代表用户占比、发生概率或效果预测。/u);
  assert.match(result.html, /Content-Security-Policy/u);
  assert.doesNotMatch(result.html, /<(?:img|picture|svg|canvas|script|link)\b/iu);
  assert.doesNotMatch(result.html, /@import|url\s*\(|https?:\/\/[^"<]*\.(?:js|css|woff2?)/iu);
  assert.doesNotMatch(result.html, /transition:\s*(?:all|top)\b/iu);
  assert.doesNotMatch(result.html, /frame-ancestors/u);

  const ids = [...result.html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(
    [...result.renderManifest.ownedLeafIds].sort(),
    [...material.constraints.requiredLeafUnitIds].sort(),
  );
});

test('renderer collapses optional analysis on screen and expands it for print', () => {
  const material = showcaseMaterialFixture();
  material.presentationUnits.push({
    id: 'optional-context',
    semanticKind: 'narrative',
    title: '补充背景',
    shape: 'text',
    leafIds: ['leaf-optional-context'],
    leafId: 'leaf-optional-context',
    text: '只在完整分析附件中保留的补充背景。',
  });
  material.leafTraceIndex['leaf-optional-context'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/context',
      sourceNodeIds: ['/payload/context'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('optional-context');
  material.constraints.requiredLeafUnitIds.push('leaf-optional-context');
  material.constraints.projectionProfilesByUnitId['optional-context'] = ['paragraph', 'list'];

  const { html } = renderEditorialShowcase({
    spec: compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /<details class="appendix-disclosure">/u);
  assert.match(html, /\.appendix-disclosure>\*\{display:block!important\}/u);
  assert.match(html, /只在完整分析附件中保留的补充背景。/u);
});

test('renderer blocks Simulation Evidence from factual Showcase components', () => {
  const material = showcaseMaterialFixture();
  material.leafTraceIndex['leaf-answer']!.support.evidenceIds.push('SIM2-1');
  const evidenceManifest = showcaseEvidenceManifestFixture();
  evidenceManifest.entries.push({
    id: 'SIM2-1',
    kind: 'tool_output',
    evidenceClass: 'simulation',
    toolId: 'virtual-user-lab',
    toolTier: 'optional',
    artifactId: 'simulation-1',
    artifactContentSha256: evidenceManifest.manifestHash,
    jsonPointer: '/output/reviews/0',
    sensitivity: 'internal',
    redaction: 'none',
  });
  const spec = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;

  assert.throws(
    () => renderEditorialShowcase({ spec, material, evidenceManifest }),
    /Simulation Evidence.*quarantine/u,
  );
});

test('source register never expands an empty binding to unrelated or Simulation Evidence', () => {
  const material = showcaseMaterialFixture();
  material.leafTraceIndex['leaf-question']!.support.evidenceIds = [];
  const evidenceManifest = showcaseEvidenceManifestFixture();
  evidenceManifest.entries.push({
    id: 'SIM-UNREFERENCED',
    kind: 'tool_output',
    evidenceClass: 'simulation',
    toolId: 'virtual-user-lab',
    toolTier: 'optional',
    artifactId: 'simulation-unreferenced',
    artifactContentSha256: evidenceManifest.manifestHash,
    jsonPointer: '/output/unreferenced',
    sourceUrl: 'https://simulation.example.test/unreferenced',
    sensitivity: 'internal',
    redaction: 'none',
  });
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'analysis',
      layout: 'single',
      components: [{
        kind: 'source-register',
        variant: 'register',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['open-question'],
        sourceLeafIds: ['leaf-question'],
      }],
    }],
  }, 'model').spec;

  const result = renderEditorialShowcase({ spec, material, evidenceManifest });
  assert.match(result.html, /无已绑定 Evidence。/u);
  assert.doesNotMatch(result.html, /SIM-UNREFERENCED|simulation\.example\.test/u);
  assert.equal(result.renderManifest.evidenceIds.includes('SIM-UNREFERENCED'), false);
});

test('renderer rejects blocked Evidence before displaying a source register', () => {
  const material = showcaseMaterialFixture();
  material.leafTraceIndex['leaf-question']!.support.evidenceIds = ['E-BLOCKED'];
  const evidenceManifest = showcaseEvidenceManifestFixture();
  evidenceManifest.entries.push({
    id: 'E-BLOCKED',
    kind: 'tool_output',
    evidenceClass: 'public_source',
    toolId: 'search',
    toolTier: 'core',
    artifactId: 'blocked-evidence',
    artifactContentSha256: evidenceManifest.manifestHash,
    jsonPointer: '/output/blocked',
    sourceUrl: 'https://blocked.example.test/',
    sensitivity: 'sensitive',
    redaction: 'blocked',
  });
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'analysis',
      layout: 'single',
      components: [{
        kind: 'source-register',
        variant: 'register',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['open-question'],
        sourceLeafIds: ['leaf-question'],
      }],
    }],
  }, 'model').spec;

  assert.throws(
    () => renderEditorialShowcase({ spec, material, evidenceManifest }),
    /Blocked Evidence E-BLOCKED cannot be rendered/u,
  );
});

test('renderer requires Artifact identity for an Evidence-bound sealed Spec', () => {
  const material = showcaseMaterialFixture();
  const evidenceManifest = showcaseEvidenceManifestFixture();
  const spec = bindEditorialShowcaseEvidenceManifest(
    compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec,
    {
      artifactId: 'evidence-manifest-1',
      contentSha256: SHOWCASE_FIXTURE_SHA,
      manifestHash: evidenceManifest.manifestHash,
    },
  );

  assert.throws(
    () => renderEditorialShowcase({ spec, material, evidenceManifest }),
    /requires Artifact identity/u,
  );
  assert.doesNotThrow(() => renderEditorialShowcase({
    spec,
    material,
    evidenceManifest,
    evidenceManifestArtifact: { id: 'evidence-manifest-1', contentSha256: SHOWCASE_FIXTURE_SHA },
  }));
});

test('renderer keeps every owned Canonical value visible in summary-style components', () => {
  const material = showcaseMaterialFixture();
  const actionPlan = material.presentationUnits.find(({ id }) => id === 'action-plan');
  assert.ok(actionPlan?.shape === 'actions');
  actionPlan.actions[0]!.owner = '研究负责人';
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'decision',
      layout: 'single',
      components: [{
        kind: 'confidence-bars',
        variant: 'ledger',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['answer-Q1'],
        sourceLeafIds: ['leaf-answer'],
      }],
    }, {
      purpose: 'analysis',
      layout: 'split',
      components: [{
        kind: 'tension-map',
        variant: 'two-sided',
        emphasis: 'primary',
        span: 'wide',
        unitRefs: ['mind-model'],
        sourceLeafIds: ['leaf-node-1', 'leaf-node-2', 'leaf-edge'],
      }, {
        kind: 'source-register',
        variant: 'register',
        emphasis: 'secondary',
        span: 'third',
        unitRefs: ['open-question'],
        sourceLeafIds: ['leaf-question'],
      }],
    }, {
      purpose: 'actions',
      layout: 'columns',
      components: [{
        kind: 'priority-lanes',
        variant: 'lanes',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['action-plan'],
        sourceLeafIds: ['leaf-action-p0', 'leaf-action-p1'],
      }],
    }],
  }, 'model').spec;

  const { html } = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /当前状态仍需验证。/u);
  assert.match(html, /支持后进入履约关注/u);
  assert.match(html, /研究负责人/u);
  assert.match(html, /当前是否仍有稳定入口？/u);
});

test('renderer preserves every matrix unit when one visual component owns multiple matrices', () => {
  const material = showcaseMaterialFixture();
  for (const [suffix, value] of [['one', '第一个矩阵内容'], ['two', '第二个矩阵内容']] as const) {
    const unitId = `matrix-${suffix}`;
    const leafId = `leaf-matrix-${suffix}`;
    material.presentationUnits.push({
      id: unitId,
      semanticKind: 'strategy_map',
      title: `矩阵 ${suffix}`,
      shape: 'matrix',
      leafIds: [leafId],
      rows: ['主题'],
      columns: ['内容'],
      cells: [{ leafId, row: '主题', column: '内容', value }],
    });
    material.leafTraceIndex[leafId] = {
      ...material.leafTraceIndex['leaf-answer']!,
      origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
        ...origin,
        jsonPointer: `/payload/contentBlocks/${suffix}`,
        sourceNodeIds: [`/payload/contentBlocks/${suffix}`],
      })),
    };
    material.constraints.requiredPresentationUnitIds.push(unitId);
    material.constraints.requiredLeafUnitIds.push(leafId);
    material.constraints.projectionProfilesByUnitId[unitId] = ['record-table', 'list'];
  }
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'motivation',
      layout: 'full',
      components: [{
        kind: 'matrix',
        variant: 'table',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['matrix-one', 'matrix-two'],
        sourceLeafIds: ['leaf-matrix-one', 'leaf-matrix-two'],
      }],
    }],
  }, 'model').spec;

  const { html } = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /第一个矩阵内容/u);
  assert.match(html, /第二个矩阵内容/u);
});

test('matrix preserves record body alongside structured fields', () => {
  const material = showcaseMaterialFixture();
  material.presentationUnits.push({
    id: 'matrix-records',
    semanticKind: 'research_plan_questions',
    title: '问题矩阵',
    shape: 'records',
    leafIds: ['leaf-matrix-record'],
    records: [{
      id: 'record-1',
      leafId: 'leaf-matrix-record',
      title: '研究对象',
      body: '正文说明',
      fields: [{ key: 'method', label: '方法', value: '访谈' }],
    }],
  });
  material.leafTraceIndex['leaf-matrix-record'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/matrixRecords/0',
      sourceNodeIds: ['/payload/matrixRecords/0'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('matrix-records');
  material.constraints.requiredLeafUnitIds.push('leaf-matrix-record');
  material.constraints.projectionProfilesByUnitId['matrix-records'] = ['card-grid', 'list'];
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'motivation',
      layout: 'full',
      components: [{
        kind: 'matrix',
        variant: 'table',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['matrix-records'],
        sourceLeafIds: ['leaf-matrix-record'],
      }],
    }],
  }, 'model').spec;

  const { html } = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /正文说明/u);
  assert.match(html, /访谈/u);
});

test('renderer preserves verified Chart table values without rendering an image', () => {
  const material = showcaseMaterialFixture();
  material.presentationUnits.push({
    id: 'verified-chart',
    semanticKind: 'verified_chart',
    title: '验证指标',
    shape: 'chart',
    leafIds: ['leaf-chart'],
    leafId: 'leaf-chart',
    chartRef: {
      chartId: 'chart-1',
      chartSpecArtifactId: 'chart-spec-1',
      chartSpecArtifactContentSha256: SHOWCASE_FIXTURE_SHA,
      assetId: 'chart-asset-1',
      manifestArtifactId: 'chart-manifest-1',
    },
    specHash: SHOWCASE_FIXTURE_SHA,
    spec: {
      version: 'chart-spec-v1',
      chartId: 'chart-1',
      type: 'comparison',
      title: '验证指标',
      categories: ['样本一', '样本二'],
      series: [{ key: 'value', label: '数值', values: [12, 19], evidenceIds: [['E1-1'], ['E1-3']] }],
    },
    table: {
      caption: '验证指标表',
      columns: ['样本一', '样本二'],
      rows: [{ key: 'value', label: '数值', cells: [12, 19], evidenceIds: [['E1-1'], ['E1-3']] }],
    },
    evidenceIds: ['E1-1', 'E1-3'],
    canonicalBindingIds: ['finding-1'],
  });
  material.leafTraceIndex['leaf-chart'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/charts/0',
      sourceNodeIds: ['finding-1'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('verified-chart');
  material.constraints.requiredLeafUnitIds.push('leaf-chart');
  material.constraints.projectionProfilesByUnitId['verified-chart'] = ['chart', 'record-table'];

  const { html } = renderEditorialShowcase({
    spec: createDeterministicEditorialShowcaseSpec(material),
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /验证指标表/u);
  assert.match(html, /样本一：12/u);
  assert.match(html, /样本二：19/u);
  assert.doesNotMatch(html, /<img\b/iu);
});

test('renderer rejects a forged Spec whose component provenance drifts from Material', () => {
  const material = showcaseMaterialFixture();
  const evidenceManifest = showcaseEvidenceManifestFixture();
  const original = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;

  const wrongOwnedLeaves = structuredClone(original);
  wrongOwnedLeaves.sections[0]!.components[0]!.ownedLeafIds = ['leaf-question'];
  assert.throws(
    () => renderEditorialShowcase({ spec: wrongOwnedLeaves, material, evidenceManifest }),
    /owned leaves do not match its units/u,
  );

  const unknownSource = structuredClone(original);
  unknownSource.sections[0]!.components[0]!.sourceLeafIds.push('leaf-does-not-exist');
  assert.throws(
    () => renderEditorialShowcase({ spec: unknownSource, material, evidenceManifest }),
    /unknown source leaf/u,
  );

  const driftedEvidence = structuredClone(original);
  driftedEvidence.sections[0]!.components[0]!.evidenceIds = [];
  assert.throws(
    () => renderEditorialShowcase({ spec: driftedEvidence, material, evidenceManifest }),
    /Evidence IDs do not match its source leaves/u,
  );

  const driftedStatus = structuredClone(original);
  driftedStatus.sections[0]!.components[0]!.status = 'supported';
  assert.throws(
    () => renderEditorialShowcase({ spec: driftedStatus, material, evidenceManifest }),
    /status does not match its source leaves/u,
  );
});

test('cover reports the weakest status across primary components', () => {
  const material = showcaseMaterialFixture();
  material.leafTraceIndex['leaf-answer']!.support.status = 'supported';
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'decision',
      layout: 'columns',
      components: [{
        kind: 'editorial-hero',
        variant: 'statement',
        emphasis: 'hero',
        span: 'wide',
        unitRefs: ['answer-Q1'],
        sourceLeafIds: ['leaf-answer'],
      }, {
        kind: 'validation-list',
        variant: 'ledger',
        emphasis: 'primary',
        span: 'third',
        unitRefs: ['open-question'],
        sourceLeafIds: ['leaf-question'],
      }],
    }],
  }, 'model').spec;

  const { html } = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  const coverPanel = html.match(/<aside class="cover-panel">([\s\S]*?)<\/aside>/u)?.[1] ?? '';
  assert.match(coverPanel, /status-unanswered/u);
  assert.doesNotMatch(coverPanel, /最低来源置信度/u);
});

test('renderer rejects duplicate section IDs and a forged outline signature', () => {
  const material = showcaseMaterialFixture();
  const evidenceManifest = showcaseEvidenceManifestFixture();
  const original = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;

  const forgedSignature = structuredClone(original);
  forgedSignature.showcaseOutlineSignature = `sha256:${'b'.repeat(64)}`;
  assert.throws(
    () => renderEditorialShowcase({ spec: forgedSignature, material, evidenceManifest }),
    /outline signature does not match/u,
  );

  const duplicateSections = structuredClone(original);
  duplicateSections.sections.push({ ...structuredClone(duplicateSections.sections[0]!), components: [] });
  assert.throws(
    () => renderEditorialShowcase({ spec: duplicateSections, material, evidenceManifest }),
    /section IDs must be unique/u,
  );
});

test('narrative fallback preserves action owners and record bodies plus fields', () => {
  const material = showcaseMaterialFixture();
  const actionPlan = material.presentationUnits.find(({ id }) => id === 'action-plan');
  assert.ok(actionPlan?.shape === 'actions');
  actionPlan.actions[0]!.owner = '研究负责人';
  material.presentationUnits.push({
    id: 'research-records',
    semanticKind: 'research_plan_questions',
    title: '研究问题',
    shape: 'records',
    leafIds: ['leaf-record'],
    records: [{
      id: 'record-1',
      leafId: 'leaf-record',
      title: '问题一',
      body: '需要回答的正文',
      fields: [{ key: 'method', label: '方法', value: '访谈' }],
    }],
  });
  material.leafTraceIndex['leaf-record'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/questions/0',
      sourceNodeIds: ['/payload/questions/0'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('research-records');
  material.constraints.requiredLeafUnitIds.push('leaf-record');
  material.constraints.projectionProfilesByUnitId['research-records'] = ['card-grid', 'list'];
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'analysis',
      layout: 'single',
      components: [{
        kind: 'narrative-list',
        variant: 'list',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['action-plan', 'research-records'],
        sourceLeafIds: ['leaf-action-p0', 'leaf-action-p1', 'leaf-record'],
      }],
    }],
  }, 'model').spec;

  const { html } = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /研究负责人/u);
  assert.match(html, /需要回答的正文/u);
  assert.match(html, /方法：访谈/u);
});

test('profile grid preserves both record body and fields', () => {
  const material = showcaseMaterialFixture();
  material.presentationUnits.push({
    id: 'profile-records',
    semanticKind: 'research_plan_questions',
    title: '对象原型',
    shape: 'records',
    leafIds: ['leaf-profile-record'],
    records: [{
      id: 'profile-1',
      leafId: 'leaf-profile-record',
      title: '任务型用户',
      body: '需要完成状态判断',
      fields: [{ key: 'signal', label: '验证信号', value: '查看规则' }],
    }],
  });
  material.leafTraceIndex['leaf-profile-record'] = {
    ...material.leafTraceIndex['leaf-answer']!,
    origins: material.leafTraceIndex['leaf-answer']!.origins.map((origin) => ({
      ...origin,
      jsonPointer: '/payload/profiles/0',
      sourceNodeIds: ['/payload/profiles/0'],
    })),
  };
  material.constraints.requiredPresentationUnitIds.push('profile-records');
  material.constraints.requiredLeafUnitIds.push('leaf-profile-record');
  material.constraints.projectionProfilesByUnitId['profile-records'] = ['card-grid', 'list'];
  const spec = compileEditorialShowcase(material, {
    profileId: 'editorial-showcase-v1',
    sections: [{
      purpose: 'profiles',
      layout: 'asymmetric',
      components: [{
        kind: 'profile-grid',
        variant: 'asymmetric',
        emphasis: 'primary',
        span: 'full',
        unitRefs: ['profile-records'],
        sourceLeafIds: ['leaf-profile-record'],
      }],
    }],
  }, 'model').spec;

  const { html } = renderEditorialShowcase({
    spec,
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.match(html, /需要完成状态判断/u);
  assert.match(html, /验证信号：查看规则/u);
});

test('renderer rejects visible titles and notices that were not derived by the Compiler', () => {
  const material = showcaseMaterialFixture();
  const evidenceManifest = showcaseEvidenceManifestFixture();
  const original = compileEditorialShowcase(material, showcaseIntentFixture(), 'model').spec;

  const componentTitle = structuredClone(original);
  componentTitle.sections[0]!.components[0]!.title = '模型新增的结论';
  assert.throws(
    () => renderEditorialShowcase({ spec: componentTitle, material, evidenceManifest }),
    /component title does not match/u,
  );

  const sectionTitle = structuredClone(original);
  sectionTitle.sections[0]!.title = '模型新增章节';
  assert.throws(
    () => renderEditorialShowcase({ spec: sectionTitle, material, evidenceManifest }),
    /section title does not match/u,
  );

  const notice = structuredClone(original);
  notice.notices.push({ code: 'invented', severity: 'warning', message: '模型新增事实' });
  assert.throws(
    () => renderEditorialShowcase({ spec: notice, material, evidenceManifest }),
    /notices do not match its generation mode/u,
  );
});

test('renderer preserves content-driven structural differences instead of producing one fixed page skeleton', () => {
  const material = showcaseMaterialFixture();
  const rich = renderEditorialShowcase({
    spec: createDeterministicEditorialShowcaseSpec(material),
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });
  const narrativeMaterial = {
    ...material,
    presentationUnits: material.presentationUnits.filter(({ semanticKind }) => (
      semanticKind === 'direct_answer' || semanticKind === 'open_question'
    )),
    leafTraceIndex: {
      'leaf-answer': material.leafTraceIndex['leaf-answer']!,
      'leaf-question': material.leafTraceIndex['leaf-question']!,
    },
    constraints: {
      ...material.constraints,
      requiredPresentationUnitIds: ['answer-Q1', 'open-question'],
      requiredLeafUnitIds: ['leaf-answer', 'leaf-question'],
      projectionProfilesByUnitId: {
        'answer-Q1': material.constraints.projectionProfilesByUnitId['answer-Q1']!,
        'open-question': material.constraints.projectionProfilesByUnitId['open-question']!,
      },
    },
  };
  const narrative = renderEditorialShowcase({
    spec: createDeterministicEditorialShowcaseSpec(narrativeMaterial),
    material: narrativeMaterial,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });

  assert.notEqual(
    rich.renderManifest.showcaseOutlineSignature,
    narrative.renderManifest.showcaseOutlineSignature,
  );
  assert.match(rich.html, /<div class="showcase-profile-grid">/u);
  assert.doesNotMatch(narrative.html, /<div class="showcase-profile-grid">/u);
});
