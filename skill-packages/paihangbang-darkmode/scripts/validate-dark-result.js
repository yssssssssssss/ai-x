// Validate dark copy geometry, explicit modes, frozen areas, and remaining unbound product UI paints.
// Replace ORIGINAL_ID and COPY_ID before running in use_design_script.

const ORIGINAL_ID = 'REPLACE_WITH_ORIGINAL_ID';
const COPY_ID = 'REPLACE_WITH_DARK_COPY_ID';
const original = await relay.getNodeByIdAsync(ORIGINAL_ID);
const copy = await relay.getNodeByIdAsync(COPY_ID);
if (!original || !copy) throw new Error('original or copy not found');

function isHeadUiInverse(path) { return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|arrow-left|more|time/i.test(path.join('/')); }
function isSelfOperatedLabel(path) { return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(path.join('/')); }
function isImageLabelPath(path) { return /商品图|店铺图|菜品图|image|图片|图\s*>|容器 2406|场景榜图片|主图/i.test(path.join(' > ')) && /top|TOP|标签|贴纸|角标|上榜理由|榜首|自营/i.test(path.join(' > ')); }
function isProductUiPath(path) { return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|product information|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|加购|分割线|描边|文案|文本|排行榜logo|上榜理由|战略标签|评分|月销量|起送|免运费|地址|导航到店|换一换|推荐更多/i.test(path.join('/')); }
function isFrozenPath(path) { const s=path.join('/'); if (isSelfOperatedLabel(path)) return true; if (isHeadUiInverse(path)) return false; if (isImageLabelPath(path)) return true; if (isProductUiPath(path) && !/商品图|店铺图|菜品图|主图|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false; return /商品图|店铺图|菜品图|logo|image|图片|贴纸|异形|背景图|banner|kv|主视觉|运营|会场/i.test(s); }
function isProductPath(path) { return !isFrozenPath(path) && (isProductUiPath(path) || /楼层|容器|背景|商品|榜/i.test(path.join('/'))); }
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function isLargeLightSurface(node, paint, key, path) { if (node.type === 'TEXT') return false; if (isHeadUiInverse(path)) return false; if (key !== 'fills') return false; const area = (node.width || 0) * (node.height || 0); const opacity = paint.opacity == null ? 1 : paint.opacity; return area > 1000 && lum(paint.color) > 0.75 && opacity > 0.55; }

const stats = { productBoundObserved: 0, productUnbound: 0, frozen: 0, unknown: 0, largeLightSurfaceRisk: 0 };
// productBoundObserved 仅表示观察到绑定，不代表已完成；错误 token / 错误视觉仍应修复。
const samples = [];
function walk(node, path) {
  const next = path.concat(node.name || node.type);
  const frozen = isFrozenPath(next);
  const product = isProductPath(next);
  for (const key of ['fills', 'strokes']) {
    const paints = node[key];
    if (!Array.isArray(paints)) continue;
    for (const p of paints) {
      if (!p || p.type !== 'SOLID' || !p.color) continue;
      const bound = !!(p.boundVariables && p.boundVariables.color);
      if (frozen) stats.frozen += 1;
      else if (product && bound) stats.productBoundObserved += 1;
      else if (product) {
        stats.productUnbound += 1;
        const opacity = p.opacity == null ? 1 : p.opacity;
        if (isLargeLightSurface(node, p, key, next)) {
          stats.largeLightSurfaceRisk += 1;
          if (samples.length < 50) samples.push({ id: node.id, name: node.name, type: node.type, key, path: next.slice(-5).join(' > ') });
        }
      } else stats.unknown += 1;
    }
  }
  if (node.children) node.children.forEach(child => walk(child, next));
}
walk(copy, []);

return {
  original: { id: original.id, name: original.name, x: original.x, y: original.y, width: original.width, height: original.height, childCount: original.children ? original.children.length : 0 },
  copy: { id: copy.id, name: copy.name, x: copy.x, y: copy.y, width: copy.width, height: copy.height, childCount: copy.children ? copy.children.length : 0, explicitVariableModes: copy.explicitVariableModes },
  geometry: { sameSize: Math.abs(original.width - copy.width) < 0.01 && Math.abs(original.height - copy.height) < 0.01, rightSide: copy.x > original.x },
  darkMode: { explicitModeCount: Object.keys(copy.explicitVariableModes || {}).length },
  stats,
  highLightUnboundSamples: samples,
};

