import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

const CSP = "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

test('renders one deterministic desktop Showcase with real component-specific DOM', () => {
  const fixture = showcaseFixture();
  const compiled = compileEditorialShowcase({
    material: fixture.material,
    sourcePacket: fixture.sourcePacket,
    intent: null,
  });
  const first = renderEditorialShowcase({ spec: compiled.spec });
  const second = renderEditorialShowcase({ spec: compiled.spec });
  const html = first.htmlBytes.toString('utf8');

  assert.deepEqual(first.htmlBytes, second.htmlBytes);
  assert.equal(first.renderManifestHash, second.renderManifestHash);
  assert.match(html, /<title>宠物食品心智设计表达研究<\/title>/u);
  assert.ok(html.indexOf('<h1>') < html.indexOf('<h2>'));
  assert.match(html, /^<!doctype html><html lang="zh-CN">/u);
  assert.ok(html.includes(`content="${CSP}"`));
  assert.ok(html.includes('<meta name="editorial-profile-id" content="universal-editorial-showcase-v1">'));
  assert.equal((html.match(/<style>/gu) ?? []).length, 1);
  assert.equal(/<script|<img|<svg|<canvas|<iframe|<form|@import|url\s*\(/iu.test(html), false);
  assert.ok(html.includes('&lt;内容平台&gt;会影响用户后续求证'));
  assert.ok(html.includes('class="showcase-rail"'));
  assert.match(html, /class="[^"]*showcase-hero/u);
  assert.ok(html.includes('class="showcase-evidence-grid"'));
  assert.ok(html.includes('class="showcase-metric-strip"'));
  assert.ok(html.includes('class="showcase-stage-track"'));
  assert.ok(html.includes('class="showcase-stage-duration"'));
  assert.ok(html.includes('class="showcase-stage-outputs"'));
  assert.ok(html.includes('class="showcase-scope-table"'));
  assert.ok(html.includes('class="showcase-dimension-table"'));
  assert.ok(html.includes('class="showcase-method-board"'));
  assert.ok(html.includes('class="showcase-deliverable-map"'));
  assert.ok(html.includes('class="showcase-answer-main"'));
  assert.ok(html.includes('class="showcase-answer-evidence-grid"'));
  assert.equal(html.includes('class="showcase-answer-question"'), false);
  assert.equal(html.includes('class="showcase-answer-layout"'), false);
  assert.equal(html.slice(html.indexOf('<main')).split('品牌心智如何贯穿四链路').length - 1, 1);
  assert.ok(html.includes('class="showcase-record-grid"'));
  assert.ok(html.includes('class="showcase-validation-list"'));
  assert.equal(html.includes('class="card-grid"'), false);
  assert.ok(html.includes('data-component-kind="answer-chain"'));
  assert.ok(html.includes('data-component-kind="stage-flow"'));
  assert.ok(html.includes(`data-owned-unit-ids="${fixture.ids.phaseOne} ${fixture.ids.phaseOneAction} ${fixture.ids.phaseOneDuration} ${fixture.ids.phaseOneOutput} ${fixture.ids.phaseTwo} ${fixture.ids.phaseTwoAction} ${fixture.ids.phaseTwoDuration} ${fixture.ids.phaseTwoOutput}"`));
  assert.ok(html.includes('href="https://example.com/report"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));

  assert.equal(first.renderManifest.version, 'universal-editorial-showcase-render-manifest-v1');
  assert.equal(first.renderManifest.profileId, 'universal-editorial-showcase-v1');
  assert.equal(first.renderManifest.profileHash, first.profileHash);
  assert.equal(first.renderManifest.specHash, compiled.hash);
  assert.equal(first.renderManifest.htmlHash, first.htmlHash);
  assert.deepEqual(
    first.renderManifest.renderedComponents.map(({ kind }) => kind),
    compiled.spec.sections.flatMap(({ components }) => components.map(({ kind }) => kind)),
  );
  assert.match(first.htmlHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(first.renderManifestHash, /^sha256:[a-f0-9]{64}$/u);
});

test('sets the standalone document language from the reviewed title without translating content', () => {
  const fixture = showcaseFixture();
  const compiled = compileEditorialShowcase({
    material: fixture.material,
    sourcePacket: fixture.sourcePacket,
    intent: null,
  });
  const spec = structuredClone(compiled.spec);
  const hero = spec.sections.flatMap(({ components }) => components)
    .find((component) => component.kind === 'editorial-hero');
  assert.ok(hero?.kind === 'editorial-hero');
  hero.content.title.value = 'Customer research plan';
  const html = renderEditorialShowcase({ spec }).htmlBytes.toString('utf8');
  assert.match(html, /^<!doctype html><html lang="en">/u);
  assert.match(html, /Customer research plan/u);
});
