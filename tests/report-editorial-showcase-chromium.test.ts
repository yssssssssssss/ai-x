import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium, type Browser } from 'playwright';

import { createDeterministicEditorialShowcaseSpec } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/report-editorial-showcase-renderer.ts';
import {
  showcaseEvidenceManifestFixture,
  showcaseMaterialFixture,
} from './fixtures/report-editorial/showcase-fixtures.ts';

async function launchRequiredChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      'Editorial Showcase Chromium smoke requires the pinned Playwright Chromium. Run `pnpm playwright:install:chromium`.',
      { cause: error },
    );
  }
}

test('Editorial Showcase passes offline 1440px and print validation without its source example', {
  timeout: 30_000,
  skip: process.env.PLAYWRIGHT_CONTRACT !== '1'
    ? 'set PLAYWRIGHT_CONTRACT=1 in the isolated CI job'
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'editorial-showcase-chromium-'));
  const htmlPath = join(root, 'editorial-showcase.html');
  const material = showcaseMaterialFixture();
  const rendered = renderEditorialShowcase({
    spec: createDeterministicEditorialShowcaseSpec(material),
    material,
    evidenceManifest: showcaseEvidenceManifestFixture(),
  });
  await writeFile(htmlPath, rendered.html, 'utf8');

  let browser: Browser | undefined;
  try {
    browser = await launchRequiredChromium();
    const context = await browser.newContext({
      offline: true,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('request', (request) => {
      if (/^(?:https?|wss?):/u.test(request.url())) externalRequests.push(request.url());
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });

    const screen = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
        componentCount: document.querySelectorAll('[data-component-id]').length,
        imageCount: document.querySelectorAll('img, picture, svg, canvas').length,
      };
    });
    assert.equal(screen.clientWidth, 1440);
    assert.equal(screen.scrollWidth, 1440);
    assert.deepEqual(screen.duplicateIds, []);
    assert.equal(screen.imageCount, 0);
    assert.equal(screen.componentCount, rendered.renderManifest.componentIds.length);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);

    await page.emulateMedia({ media: 'print' });
    assert.equal(
      await page.locator('[data-component-id]').evaluateAll((elements) => elements.every((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })),
      true,
    );
    await context.close();
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }

  for (const source of [
    'apps/orchestrator-runtime/src/report/report-editorial-showcase-profile.ts',
    'apps/orchestrator-runtime/src/report/report-editorial-showcase-compiler.ts',
    'apps/orchestrator-runtime/src/report/report-editorial-showcase-renderer.ts',
  ]) {
    assert.doesNotMatch(await readFile(source, 'utf8'), /run-workspaces\//u);
  }
});
