import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium, type Browser } from 'playwright';
import type { ReportDocumentV3 } from '../packages/api-contract/report-document.ts';
import { renderStandaloneReport } from '../apps/orchestrator-runtime/src/report/standalone-html-report-renderer.ts';
import {
  REPORT_DOCUMENT_V3_FIXTURE_SHA,
  reportDocumentV3Fixture,
  reportDocumentV3Trace,
} from './fixtures/report-document-v3.ts';

async function launchRequiredChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      'Standalone HTML Chromium smoke requires the pinned Playwright Chromium. Run `pnpm playwright:install:chromium`.',
      { cause: error },
    );
  }
}

function smokeDocument(): ReportDocumentV3 {
  const document = reportDocumentV3Fixture();
  const table = document.sections[0]!.blocks[0]!;
  assert.equal(table.type, 'record-table');
  for (let index = 3; index <= 10; index += 1) {
    const leafId = `matrix-c${index}`;
    const columnKey = `column-${index}`;
    table.columns.push({ key: columnKey, label: `验证维度 ${index}` });
    table.rows[0]!.cells.push({
      leafRef: leafId,
      columnKey,
      value: `不可换行的宽表验证内容-${index}-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`,
    });
    table.leafRefs.push(leafId);
    document.traceIndex[leafId] = reportDocumentV3Trace(`/payload/contentBlocks/${leafId}`);
    document.semanticManifest.leafUnitIds.push(leafId);
  }
  document.sections[1]!.blocks[0]!.visibility = 'collapsible';
  const priorityBoard = document.sections[2]!.blocks[0]!;
  assert.equal(priorityBoard.type, 'priority-board');
  priorityBoard.groups[0]!.items[0]!.action =
    'Required provisional Contribution demand:market_landscape:Q1_context_truth_requires_manual_validation';
  return document;
}

test('standalone HTML passes required offline Chromium interaction, responsive, and print smoke', {
  timeout: 30_000,
  skip: process.env.PLAYWRIGHT_CONTRACT !== '1'
    ? 'set PLAYWRIGHT_CONTRACT=1 in the isolated CI job'
    : false,
}, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'standalone-report-chromium-'));
  const reportPath = join(temporaryRoot, 'report.html');
  const rendered = renderStandaloneReport({
    document: smokeDocument(),
    sourceReportDocumentContentSha256: REPORT_DOCUMENT_V3_FIXTURE_SHA,
  });
  await writeFile(reportPath, rendered.html, 'utf8');

  let browser: Browser | undefined;
  try {
    browser = await launchRequiredChromium();
    const context = await browser.newContext({
      offline: true,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      if (/^(?:https?|wss?):/u.test(request.url())) externalRequests.push(request.url());
    });

    await page.goto(pathToFileURL(reportPath).href, { waitUntil: 'load' });
    assert.deepEqual(externalRequests, [], 'offline report must make no network requests');

    const pageFitsViewport = async (): Promise<boolean> => page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth <= root.clientWidth + 1
        && document.body.scrollWidth <= document.body.clientWidth + 1;
    });
    assert.equal(await pageFitsViewport(), true, 'desktop page must not overflow horizontally');

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await pageFitsViewport(), true, '390px page must not overflow horizontally');
    assert.equal(
      await page.locator('.table-scroll').first().evaluate((element) => (
        element.scrollWidth > element.clientWidth
      )),
      true,
      'wide tables must scroll inside their own container',
    );

    let focusedSummary = false;
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      focusedSummary = await page.evaluate(() => document.activeElement?.tagName === 'SUMMARY');
      if (focusedSummary) break;
    }
    assert.equal(focusedSummary, true, 'keyboard navigation must reach a disclosure summary');
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false),
      true,
      'keyboard-focused summary must expose focus-visible state',
    );
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle),
      'none',
      'focus-visible summary must have a visible outline',
    );
    const focusedDetailsWasOpen = await page.evaluate(() => (
      document.activeElement?.parentElement?.hasAttribute('open') ?? false
    ));
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate(() => document.activeElement?.parentElement?.hasAttribute('open') ?? false),
      !focusedDetailsWasOpen,
      'Enter must toggle the focused disclosure',
    );

    for (const details of await page.locator('details').all()) await details.evaluate((node) => node.removeAttribute('open'));
    await page.emulateMedia({ media: 'print' });
    assert.equal(
      await page.evaluate((expectedLeafIds) => expectedLeafIds.every((leafId) => (
        Array.from(document.querySelectorAll(`[data-leaf-ref="${CSS.escape(leafId)}"], [data-print-leaf-ref="${CSS.escape(leafId)}"]`))
          .some((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && rect.width > 0
              && rect.height > 0;
          })
      )), rendered.renderManifest.semantics.leafUnitIds),
      true,
      'print media must expose every core report leaf even when disclosures are closed',
    );
    assert.equal(
      await page.locator('[data-print-audit-record-id="audit-1"]').evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      }),
      true,
      'print media must expose the closed audit appendix',
    );
    assert.equal(
      await page.locator('summary').evaluateAll((elements) => elements.every((element) => (
        element.getClientRects().length === 0
      ))),
      true,
      'print media must hide disclosure controls rather than their contents',
    );
    assert.deepEqual(externalRequests, [], 'responsive and print rendering must remain offline');
    await context.close();
  } finally {
    await browser?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
