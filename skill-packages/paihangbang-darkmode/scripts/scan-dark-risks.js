// Phase 3: scan risks only. Do not modify anything.
// Replace ORIGINAL_ID and COPY_ID before running in use_design_script.

const ORIGINAL_ID = 'REPLACE_WITH_ORIGINAL_ID';
// Phase 3: scan risks only. Do not modify anything.
const COPY_ID = 'REPLACE_WITH_COPY_NODE_ID';
const copy = await relay.getNodeByIdAsync(COPY_ID);
const original = await relay.getNodeByIdAsync(ORIGINAL_ID);
if (!copy || !original) throw new Error('original or copy not found');

function isHeadUiInverse(path) { return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|arrow-left|more|time|搜索|胶囊|常规-主流程|模式=日间模式/i.test(path.join('/')); }
function isImageLabelPath(path) { return /商品图|店铺图|菜品图|image|图片|图\s*>|容器 2406|场景榜图片|主图/i.test(path.join(' > ')) && /top|TOP|标签|贴纸|角标|上榜理由|榜首|自营/i.test(path.join(' > ')); }
function isProductUiPath(path) { return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|加购|上榜理由|文本|优惠|导航|月销量|评分|门店|地址|起送|免运费|AI|ai|解读区域|换一换|推荐更多/i.test(path.join('/')); }
function isFrozenPath(path) { const s=path.join('/'); if (isHeadUiInverse(path)) return false; if (isImageLabelPath(path)) return true; if (isProductUiPath(path) && !/商品图|店铺图|菜品图|主图|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false; return /商品图|店铺图|菜品图|logo|image|图片|贴纸|异形|背景图|banner|kv|主视觉|运营|会场|模特|品牌图|色块标签|自营|5个以上左对齐/i.test(s); }
function isProductPath(path) { return !isFrozenPath(path) && (isProductUiPath(path) || /楼层|容器|背景|商品|榜/i.test(path.join('/'))); }
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function hex(c, op) { const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'); const b = `#${h(c.r)}${h(c.g)}${h(c.b)}`.toLowerCase(); return op != null && op < 1 ? b + Math.round(op * 255).toString(16).padStart(2, '0') : b; }
function isPrimaryRed(c) { return c.r > 0.85 && c.g < 0.15 && c.b < 0.25; }
function isLargeLightSurface(node, paint, key, path) { if (node.type === 'TEXT') return false; if (isHeadUiInverse(path)) return false; if (key !== 'fills') return false; const area = (node.width || 0) * (node.height || 0); const op = paint.opacity == null ? 1 : paint.opacity; return area > 1000 && lum(paint.color) > 0.75 && op > 0.55; }
function isMainBodySurface(node, path) { const s = path.join('/'); const y = node.absoluteBoundingBox ? node.absoluteBoundingBox.y : node.y; return /feeds|商卡feeds|楼层|商品榜单卡片|商品卡|店铺榜|美食榜|AI荐榜|容器 111170704|容器 20121213959/i.test(s) && (node.width || 0) > 250 && (node.height || 0) > 40; }
function isDarkTextRisk(node, paint, key, path) { if (key !== 'fills' || node.type !== 'TEXT') return false; if (isPrimaryRed(paint.color)) return false; if (!/商卡|feeds|商品名称|标题|参数|卖点|利益点|价格|到手价|菜|门店|优惠|评分|月销量|导航到店|店铺|楼层|AI|ai/.test(path.join('/'))) return false; return lum(paint.color) < 0.45; }
function isServiceTagPath(path) { const s = path.join('/'); return !/二级tab|tab|Frame 2085664464|容器 111171520/i.test(s) && /上榜理由|榜单特性|服务标签|免费上门|贴坏包赔|好评|买后说好|服务金/i.test(s); }
function isTabBackgroundPath(path) { return /二级tab|一级tab|tab行|频道tab|筛选|chip|小方块|Frame 2085664464|Frame 2085664463|分页- 单行文字|页面一级tab|容器 111171520/i.test(path.join('/')); }
function isPromoLightBg(node, paint, key, path) { if (key !== 'fills' || node.type === 'TEXT') return false; if (isServiceTagPath(path)) return false; if (!/下单返|满\d+减|满减|优惠|加购|ellipse 9225|按钮=红/i.test(path.join('/'))) return false; const op = paint.opacity == null ? 1 : paint.opacity; return lum(paint.color) > 0.65 && op > 0.45; }
function isServiceLightBg(node, paint, key, path) { if (key !== 'fills' || node.type === 'TEXT') return false; if (!isServiceTagPath(path)) return false; const op = paint.opacity == null ? 1 : paint.opacity; return lum(paint.color) > 0.55 && op > 0.45; }

const risks = { mainBodyLight: [], largeLightSurface: [], darkText: [], promoLightBg: [], serviceTagBg: [], strokeOrMask: [] };
const stats = { frozen: 0, productPaints: 0, whiteForeground: 0 };
function push(kind, node, key, paint, path, role) { if (risks[kind].length >= 150) return; risks[kind].push({ id: node.id, name: node.name, type: node.type, key, color: paint && paint.color ? hex(paint.color, paint.opacity) : null, role, path: path.slice(-6).join(' > ') }); }
function walk(node, path) {
  const next = path.concat(node.name || node.type);
  if (isFrozenPath(next)) { stats.frozen += 1; return; }
  const product = isProductPath(next);
  for (const key of ['fills', 'strokes']) {
    const paints = node[key];
    if (!Array.isArray(paints)) continue;
    for (const paint of paints) {
      if (!paint || paint.type !== 'SOLID' || !paint.color) continue;
      if ((node.type === 'TEXT' || /icon|图标|arrow|返回|more|搜索|购物车/i.test(node.name || '')) && lum(paint.color) > 0.75) stats.whiteForeground += 1;
      if (!product) continue;
      stats.productPaints += 1;
      if (isMainBodySurface(node, next) && isLargeLightSurface(node, paint, key, next)) push('mainBodyLight', node, key, paint, next, 'surface/page');
      else if (isLargeLightSurface(node, paint, key, next)) push('largeLightSurface', node, key, paint, next, 'surface/component');
      if (isDarkTextRisk(node, paint, key, next)) push('darkText', node, key, paint, next, 'text');
      if (isServiceLightBg(node, paint, key, next)) push('serviceTagBg', node, key, paint, next, 'serviceBg');
      if (isPromoLightBg(node, paint, key, next)) push('promoLightBg', node, key, paint, next, 'primaryLight');
      if (key === 'strokes' && isTabBackgroundPath(next)) push('strokeOrMask', node, key, paint, next, 'tabBgStrokeRemove');
      else if (key === 'strokes' && isServiceTagPath(next)) push('strokeOrMask', node, key, paint, next, 'serviceLine');
      else if (key === 'strokes' && (node.width || 0) * (node.height || 0) > 1000) push('strokeOrMask', node, key, paint, next, 'border');
    }
  }
  if (node.children) node.children.forEach(child => walk(child, next));
}
walk(copy, []);

return {
  phase: 'scan-dark-risks',
  copy: { id: copy.id, name: copy.name, explicitModeCount: Object.keys(copy.explicitVariableModes || {}).length },
  geometry: { sameSize: Math.abs(original.width - copy.width) < 0.01 && Math.abs(original.height - copy.height) < 0.01, rightSide: copy.x > original.x },
  stats,
  risks,
  failFast: { mainBodyLightCount: risks.mainBodyLight.length, shouldFail: risks.mainBodyLight.length > 0 },
};
