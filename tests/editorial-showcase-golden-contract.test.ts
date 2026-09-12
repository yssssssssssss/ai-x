import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { loadEditorialShowcaseProfile } from '../apps/orchestrator-runtime/src/report/editorial-showcase-profile.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts';
import { validateEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-validator.ts';
import { canonicalSha256 } from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

interface GoldenContract {
  profile: { id: string; contentSha256: string };
  approvedBaseline: {
    approval: string;
    htmlSha256: string;
    specSha256: string;
    validationSha256: string;
  };
  requirements: {
    minimumSectionCountForRichMaterial: number;
    minimumTableCountForRichMaterial: number;
    requiredComponentKinds: string[];
    requiredSelectors: string[];
    forbiddenPatterns: string[];
  };
}

test('approved Golden Contract locks the profile and generic rich-report grammar', () => {
  const contract = JSON.parse(readFileSync(
    'tests/fixtures/report-editorial/universal-editorial-showcase-golden-contract-v1.json', 'utf8',
  )) as GoldenContract;
  const validator = new SchemaValidator();
  assert.deepEqual(validator.validate('universal-editorial-showcase-golden-contract-v1', contract), []);
  assert.equal(contract.approvedBaseline.approval, 'human_approved');
  assert.match(contract.approvedBaseline.htmlSha256, /^sha256:[a-f0-9]{64}$/u);

  const profile = loadEditorialShowcaseProfile();
  assert.equal(contract.profile.id, profile.profile.id);
  assert.equal(contract.profile.contentSha256, profile.hash);

  const fixture = showcaseFixture();
  const compiled = compileEditorialShowcase({ material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null });
  const rendered = renderEditorialShowcase({ spec: compiled.spec });
  const validation = validateEditorialShowcase({
    material: fixture.material,
    sourcePacket: fixture.sourcePacket,
    spec: compiled.spec,
    intent: null,
    renderResult: rendered,
  });
  const html = rendered.htmlBytes.toString('utf8');
  const componentKinds = new Set(compiled.spec.sections.flatMap(({ components }) => components.map(({ kind }) => kind)));

  assert.equal(compiled.hash, contract.approvedBaseline.specSha256);
  assert.equal(rendered.htmlHash, contract.approvedBaseline.htmlSha256);
  assert.equal(canonicalSha256(validation), contract.approvedBaseline.validationSha256);

  assert.ok(compiled.spec.sections.length >= contract.requirements.minimumSectionCountForRichMaterial);
  assert.ok((html.match(/<table\b/gu) ?? []).length >= contract.requirements.minimumTableCountForRichMaterial);
  for (const kind of contract.requirements.requiredComponentKinds) assert.ok(componentKinds.has(kind as never), kind);
  for (const selector of contract.requirements.requiredSelectors) {
    const className = selector.startsWith('.') ? selector.slice(1) : selector;
    assert.ok(html.includes(className), selector);
  }
  for (const pattern of contract.requirements.forbiddenPatterns) {
    assert.equal(html.toLowerCase().includes(pattern.toLowerCase()), false, pattern);
  }
});
