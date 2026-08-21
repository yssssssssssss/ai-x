import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const stylesheet = new URL('../apps/web/src/theme.css', import.meta.url);
const component = new URL('../apps/web/src/components/stages/Stage2Candidates.tsx', import.meta.url);

test('candidate plans render as an accessible, responsive carousel', async () => {
  const [css, source] = await Promise.all([
    readFile(stylesheet, 'utf8'),
    readFile(component, 'utf8'),
  ]);

  assert.match(source, /useEmblaCarousel/);
  assert.match(source, /aria-roledescription="carousel"/);
  assert.match(source, /aria-roledescription="slide"/);
  assert.match(source, /上一个方案/);
  assert.match(source, /下一个方案/);
  assert.match(source, /event\.key === 'ArrowLeft'/);
  assert.match(source, /event\.key === 'ArrowRight'/);
  assert.match(source, /tabIndex=\{candidateIndex === currentIndex \? 0 : -1\}/);
  for (const label of ['快速判断', '深度研究', '广度扫描', '聚焦关键链路', '混合方法', '决策收敛', '整改复测']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /Unknown candidate profile/);
  assert.match(source, /candidate_metadata\.recommended === true/);
  assert.match(source, /candidate-recommended/);

  assert.match(css, /\.candidate-carousel-viewport\s*\{[^}]*overflow\s*:\s*hidden/su);
  assert.match(css, /\.candidate-slide\s*\{[^}]*flex\s*:\s*0 0 min\(80%, 540px\)/su);
  assert.match(css, /\.candidate-slide\.is-current\s*\{[^}]*transform\s*:\s*scale\(1\)/su);
  assert.match(css, /\.candidate-card\s*\{[^}]*min-width\s*:\s*0\s*;/su);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*\.candidate-slide\s*\{[^}]*flex-basis\s*:\s*84%/u);
});
