import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { systemCapabilitiesRouter } from '../apps/agent-api/src/routes/system-capabilities.ts';

test('system capabilities expose live contract and registry identities without local paths', async () => {
  const featureFlagNames = [
    'REPORT_V3_WRITER_ENABLED',
    'REPORT_EDITORIAL_PLANNER_V1_ENABLED',
    'REPORT_EDITORIAL_EXPERIENCE_V1_ENABLED',
    'REPORT_EDITORIAL_SHOWCASE_V1_ENABLED',
    'STANDALONE_HTML_BUNDLE_V1_ENABLED',
  ] as const;
  const originalFeatureFlags = new Map(
    featureFlagNames.map((name) => [name, process.env[name]]),
  );
  featureFlagNames.forEach((name) => delete process.env[name]);
  const app = express();
  app.use('/api/system/capabilities', systemCapabilitiesRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/system/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body.planContractVersions, [
      'current-execution-plan-v1',
      'current-execution-plan-v2',
      'current-execution-plan-v3',
    ]);
    assert.equal(body.multiSkillPlanWriterEnabled, false);
    assert.equal(body.reportV3WriterEnabled, false);
    assert.equal(body.reportEditorialPlannerV1Enabled, false);
    assert.equal(body.reportEditorialExperienceV1Enabled, false);
    assert.equal(body.reportEditorialShowcaseV1Enabled, false);
    assert.equal(body.standaloneHtmlBundleV1Enabled, false);
    assert.deepEqual(body.capabilityDemandGraphVersions, ['capability-demand-graph-v1']);
    assert.deepEqual(body.researchContributionVersions, ['research-contribution-v1']);
    assert.deepEqual(body.researchContributionArtifactVersions, ['research-contribution-artifact-v1']);
    assert.deepEqual(body.researchContributionBundleVersions, ['research-contribution-bundle-v1']);
    assert.deepEqual(body.crossSkillReviewVersions, ['cross-skill-review-v1']);
    assert.deepEqual(body.contributionLedgerVersions, ['contribution-ledger-v1']);
    assert.deepEqual(body.contributionSummaryVersions, ['contribution-summary-v1']);
    assert.deepEqual(body.reportDocumentVersions, [
      'report-document-v1',
      'report-document-v2',
      'report-document-v3',
      'report-document-v4',
    ]);
    assert.ok((body.activeDeliverables as string[]).includes('research_plan'));
    assert.ok((body.activeDeliverables as string[]).includes('research_strategy_report'));
    assert.ok((body.activeTaskTypes as string[]).includes('research_synthesis'));
    assert.deepEqual(body.reportLayoutVersions, ['report-layout-blueprint-v1']);
    const contracts = body.deliverableContracts as Array<Record<string, unknown>>;
    const strategy = contracts.find(({ id }) => id === 'research_strategy_report');
    assert.deepEqual(strategy, {
      id: 'research_strategy_report',
      writePayloadSchema: 'research-strategy-report-v2.schema.json',
      readablePayloadSchemas: [
        'research-strategy-report.schema.json',
        'research-strategy-report-v2.schema.json',
      ],
      synthesisMode: 'reviewed_skill_assembly',
      compositionMode: 'portfolio',
      synthesizerSkillId: 'research-strategy-synthesis',
    });
    assert.ok((body.compiledSkills as string[]).includes('generate-research-plan'));
    assert.ok((body.compiledSkills as string[]).includes('research-strategy-synthesis'));
    const build = body.build as Record<string, unknown>;
    assert.match(String(build.id), /\S/u);
    assert.match(String(build.configurationHash), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(build.sourceRevision), /^[a-f0-9]{40,64}$/u);
    assert.match(String(body.toolRegistryHash), /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(body), /Users\/|storage_uri|DATABASE_URL/u);

    process.env.REPORT_EDITORIAL_PLANNER_V1_ENABLED = 'true';
    process.env.REPORT_EDITORIAL_SHOWCASE_V1_ENABLED = 'true';
    const enabledResponse = await fetch(`http://127.0.0.1:${port}/api/system/capabilities`);
    assert.equal(enabledResponse.status, 200);
    const enabledBody = await enabledResponse.json() as Record<string, unknown>;
    assert.equal(enabledBody.reportEditorialPlannerV1Enabled, true);
    assert.equal(enabledBody.reportEditorialShowcaseV1Enabled, true);
  } finally {
    for (const name of featureFlagNames) {
      const original = originalFeatureFlags.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
