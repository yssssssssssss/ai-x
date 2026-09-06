// Fast Mode 2.0 Phase 4: fix P0 risk nodes only, using area+target from scan-fast-risks.js.
// Replace FAST_RISKS with output from scan-fast-risks.js.

const FAST_RISKS = { areaBg: [], textLow: [] };

// Fast Mode 2.0 Phase 4: fix P0 risk nodes only, using area+target from scan-fast-risks.js.
function patchPaint(paint, hex) {
  const raw = hex.replace('#', '');
  paint.color = { r: parseInt(raw.slice(0, 2), 16) / 255, g: parseInt(raw.slice(2, 4), 16) / 255, b: parseInt(raw.slice(4, 6), 16) / 255 };
  paint.opacity = raw.length >= 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
  delete paint.boundVariables;
}
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function pathOf(node) { const parts = []; let p = node; while (p) { parts.unshift(p.name || p.type || ''); p = p.parent; } return parts.join('/'); }
function isSelfOperatedLabel(nodeOrPath) { const s = typeof nodeOrPath === 'string' ? nodeOrPath : pathOf(nodeOrPath); return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(s); }
function isTabBackground(nodeOrPath) { const s = typeof nodeOrPath === 'string' ? nodeOrPath : pathOf(nodeOrPath); return /二级tab|一级tab|tab行|频道tab|筛选|chip|小方块|Frame 2085664464|Frame 2085664463|分页- 单行文字|页面一级tab/i.test(s); }
function clearTabStrokeIfNeeded(node, item, changed) { if (!isTabBackground(node) && !isTabBackground(item.path || '')) return; if (!('strokes' in node)) return; if (Array.isArray(node.strokes) && node.strokes.length) { node.strokes = []; changed.push({ id: node.id, name: node.name, type: node.type, key: 'strokes', kind: 'tab-bg-stroke-removed', target: 'none', replacePaintArray: true }); } }
function shouldFixDescendantPaint(node, paint, key) {
  if (!paint || paint.type !== 'SOLID' || !paint.color || key !== 'fills') return false;
  if (node.visible === false) return false;
  const area = (node.width || 0) * (node.height || 0);
  const op = paint.opacity == null ? 1 : paint.opacity;
  const drawable = /VECTOR|RECTANGLE|POLYGON|ELLIPSE|BOOLEAN_OPERATION|FRAME|INSTANCE/.test(node.type);
  return drawable && area > 400 && lum(paint.color) > 0.72 && op > 0.45;
}
function collectDescendantPaintTargets(root, maxCount = 24) {
  const targets = [];
  function walk(n) {
    if (targets.length >= maxCount) return;
    const paints = n.fills;
    if (Array.isArray(paints) && paints.some(p => shouldFixDescendantPaint(n, p, 'fills'))) targets.push({ node: n, key: 'fills' });
    if (targets.length >= maxCount) return;
    if (n.children) n.children.forEach(walk);
  }
  if (root.children) root.children.forEach(walk);
  return targets;
}

const all = [];
for (const item of FAST_RISKS.areaBg || []) all.push({ kind: 'areaBg', ...item });
for (const item of FAST_RISKS.textLow || []) all.push({ kind: 'textLow', ...item });

const fonts = new Map();
for (const item of all) {
  if (item.kind !== 'textLow') continue;
  const node = await relay.getNodeByIdAsync(item.id);
  if (!node || node.type !== 'TEXT') continue;
  const fn = node.fontName;
  if (fn && fn !== relay.mixed) fonts.set(`${fn.family}|${fn.style}`, fn);
  else if (typeof node.characters === 'string') {
    for (let i = 0; i < node.characters.length; i++) {
      const r = node.getRangeFontName(i, i + 1);
      if (r && r !== relay.mixed) fonts.set(`${r.family}|${r.style}`, r);
    }
  }
}
await Promise.all([...fonts.values()].map(f => relay.loadFontAsync(f)));

const changed = [];
const skipped = [];
for (const item of all) {
  const node = await relay.getNodeByIdAsync(item.id);
  if (!node) { skipped.push({ id: item.id, kind: item.kind, reason: 'node not found' }); continue; }
  if (isSelfOperatedLabel(node) || isSelfOperatedLabel(item.path || '')) { skipped.push({ id: item.id, kind: item.kind, reason: 'self-operated label frozen' }); continue; }
  const key = item.key || 'fills';
  const paints = node[key];
  if (!Array.isArray(paints)) { skipped.push({ id: item.id, kind: item.kind, reason: 'no paints' }); continue; }
  const target = item.target;
  if (!target) { skipped.push({ id: item.id, kind: item.kind, reason: 'no target' }); continue; }

  const solid = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: 'NORMAL' };
  patchPaint(solid, target);
  node[key] = [solid];
  changed.push({ id: node.id, name: node.name, type: node.type, key, kind: item.kind, area: item.area, target, replacePaintArray: true });
  clearTabStrokeIfNeeded(node, item, changed);

  if (item.kind === 'areaBg') {
    const descendants = collectDescendantPaintTargets(node);
    for (const d of descendants) {
      const childSolid = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: 'NORMAL' };
      patchPaint(childSolid, target);
      d.node[d.key] = [childSolid];
      changed.push({ id: d.node.id, name: d.node.name, type: d.node.type, key: d.key, kind: `${item.kind}:descendant`, area: item.area, target, replacePaintArray: true });
    }
  }
}
return { phase: 'fix-fast-risks-areas', fontCount: fonts.size, changedCount: changed.length, skipped: skipped.slice(0, 80), changed: changed.slice(0, 120), mutatedNodeIds: [...new Set(changed.map(x => x.id))] };
