// Phase 4: fix explicit risk nodes only. Do not scan-and-fix whole tree.
// Replace RISK_NODES with the output from scan-dark-risks.js.


const RISK_NODES = {
  mainBodyLight: [],
  largeLightSurface: [],
  darkText: [],
  promoLightBg: [],
  serviceTagBg: [],
  strokeOrMask: []
};


const DARK = {
  page: '#14171a',
  surface: '#1f2226',
  component: '#2a2f36',
  title: '#e1e6eb',
  text: '#a1a9b3',
  help: '#717985',
  border: '#ffffff1f',
  primary: '#ff0f23',
  primaryLight: '#40262a',
  service: '#b38b6d',
  serviceBg: '#3a2b1a',
  serviceLine: '#4d443d',
  mask: '#0000001a'
};


function pathOf(node) { const parts = []; let p = node; while (p) { parts.unshift(p.name || p.type || ''); p = p.parent; } return parts.join('/'); }
function isSelfOperatedLabel(nodeOrPath) { const s = typeof nodeOrPath === 'string' ? nodeOrPath : pathOf(nodeOrPath); return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(s); }
function isTabBackground(nodeOrPath) { const s = typeof nodeOrPath === 'string' ? nodeOrPath : pathOf(nodeOrPath); return /二级tab|一级tab|tab行|频道tab|筛选|chip|小方块|Frame 2085664464|Frame 2085664463|分页- 单行文字|页面一级tab/i.test(s); }
function clearTabStrokeIfNeeded(node, item, changed) { if (!isTabBackground(node) && !isTabBackground(item.path || '')) return; if (!('strokes' in node)) return; if (Array.isArray(node.strokes) && node.strokes.length) { node.strokes = []; changed.push({ id: node.id, name: node.name, type: node.type, key: 'strokes', kind: 'tab-bg-stroke-removed', target: 'none' }); } }
function patchPaint(paint, hex) {
  const raw = hex.replace('#', '');
  paint.color = { r: parseInt(raw.slice(0, 2), 16) / 255, g: parseInt(raw.slice(2, 4), 16) / 255, b: parseInt(raw.slice(4, 6), 16) / 255 };
  paint.opacity = raw.length >= 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
