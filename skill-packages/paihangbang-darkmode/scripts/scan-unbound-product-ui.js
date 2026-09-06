// Scan product UI paints after dark-mode switch. Does not resolve remote variables.
// Replace ROOT_ID before running in use_design_script.

const ROOT_ID = 'REPLACE_WITH_DARK_COPY_ROOT_ID';
const root = await relay.getNodeByIdAsync(ROOT_ID);
// Scan product UI paints after dark-mode switch. Does not resolve remote variables.
if (!root) throw new Error(`root not found: ${ROOT_ID}`);

function isSelfOperatedLabel(path) {
  return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(path.join('/'));
}
function isProductUiPath(path) {
  return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|product information|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|分割线|描边|文案|文本|上榜理由|评分|月销量|起送|免运费|地址|导航到店|换一换|推荐更多/i.test(path.join('/'));
}
function isFrozenPath(path) {
  const s = path.join('/');
  if (isSelfOperatedLabel(path)) return true;
  if (isProductUiPath(path) && !/商品图|店铺图|菜品图|主图|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false;
  return /商品图|image|图片|贴纸|异形|头图|banner|kv|主视觉|运营|会场|模特|品牌图/i.test(s);
}
function isProductPath(path) {
  return !isFrozenPath(path) && (isProductUiPath(path) || /楼层|容器|背景|商品|榜/i.test(path.join('/')));
}
function hex(c, opacity) {
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`.toLowerCase();
  if (opacity != null && opacity < 1) return base + Math.round(opacity * 255).toString(16).padStart(2, '0');
  return base;
}
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function isHeadUiInverse(path) { return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|arrow-left|more|time/i.test(path.join('/')); }
function isLargeLightSurface(node, paint, key, path) {
  if (node.type === 'TEXT') return false;
  if (isHeadUiInverse(path)) return false;
  if (key !== 'fills') return false;
  const area = (node.width || 0) * (node.height || 0);
  const opacity = paint.opacity == null ? 1 : paint.opacity;
  return area > 1000 && lum(paint.color) > 0.75 && opacity > 0.55;
}

const stats = { productBoundObserved: 0, productUnbound: 0, frozen: 0, unknown: 0, largeLightSurfaceRisk: 0 };
// productBoundObserved 仅表示观察到绑定，不代表已完成；错误 token / 错误视觉仍应进入后续修复。
const samples = [];
function walk(node, path) {
  const next = path.concat(node.name || node.type);
  const frozen = isFrozenPath(next);
  const product = isProductPath(next);
  for (const key of ['fills', 'strokes']) {
    const paints = node[key];
    if (!Array.isArray(paints)) continue;
    for (const paint of paints) {
      if (!paint || paint.type !== 'SOLID' || !paint.color) continue;
      const bound = !!(paint.boundVariables && paint.boundVariables.color);
      if (frozen) stats.frozen += 1;
      else if (product && bound) stats.productBoundObserved += 1;
      else if (product) {
        stats.productUnbound += 1;
        const opacity = paint.opacity == null ? 1 : paint.opacity;
        if (isLargeLightSurface(node, paint, key, next)) stats.largeLightSurfaceRisk += 1;
        if (samples.length < 80) samples.push({ id: node.id, name: node.name, type: node.type, area: 'product-ui', key, color: hex(paint.color, paint.opacity), largeLightSurfaceRisk: isLargeLightSurface(node, paint, key, next), path: next.slice(-5).join(' > ') });
      } else {
        stats.unknown += 1;
      }
    }
  }
  if (node.children) node.children.forEach(child => walk(child, next));
}
walk(root, []);
return { root: { id: root.id, name: root.name }, stats, samples };
