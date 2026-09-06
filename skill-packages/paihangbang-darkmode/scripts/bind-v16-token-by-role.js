// Bind non-V16-bound and unbound product UI paints to V16 variables by role, with fallback option.
// Replace ROOT_ID and TOKEN_IDS before running. Do not run on frozen areas.
// A paint is actionable when it is unbound OR its bound variable is not from JD V16 (key/id does not include 2029484645871009793).

const ROOT_ID = 'REPLACE_WITH_DARK_COPY_ROOT_ID';
// Bind non-V16-bound and unbound product UI paints to V16 variables by role, with fallback option.
const ALLOW_FALLBACK_HEX = true;

// Fill with variable IDs available in the current file. Prefer semantic variables.
const TOKEN_IDS = {
  surface: 'REPLACE_WITH_BACKGROUND_SURFACE_VARIABLE_ID',
  component: 'REPLACE_WITH_BACKGROUND_COMPONENT_VARIABLE_ID',
  title: 'REPLACE_WITH_TEXT_TITLE_VARIABLE_ID',
  text: 'REPLACE_WITH_TEXT_BODY_VARIABLE_ID',
  help: 'REPLACE_WITH_TEXT_HELP_VARIABLE_ID',
  border: 'REPLACE_WITH_BORDER_VARIABLE_ID',
  primary: 'REPLACE_WITH_PRIMARY_VARIABLE_ID',
  primaryLight: 'REPLACE_WITH_PRIMARY_LIGHT_VARIABLE_ID',
  service: 'REPLACE_WITH_SERVICE_TEXT_VARIABLE_ID',
  serviceBg: 'REPLACE_WITH_SERVICE_BG_VARIABLE_ID',
  serviceDecor: 'REPLACE_WITH_SERVICE_DECOR_VARIABLE_ID',
  mask: 'REPLACE_WITH_MASK_VARIABLE_ID'
};

const FALLBACK_DARK = {
  surface: '#1f2226',
  component: '#2a2f36',
  title: '#e1e6eb',
  text: '#a1a9b3',
  help: '#717985',
  border: '#ffffff1f',
  primary: '#ff0f23',
  primaryLight: '#40262a',
  mask: '#0000001a',
  service: '#b38b6d',
  serviceBg: '#3a2b1a',
  serviceDecor: '#f2dbc2'
};

const root = await relay.getNodeByIdAsync(ROOT_ID);
if (!root) throw new Error(`root not found: ${ROOT_ID}`);

const variables = {};
for (const key of Object.keys(TOKEN_IDS)) {
  const id = TOKEN_IDS[key];
  if (!id || id.startsWith('REPLACE_')) continue;
  try {
    const v = await relay.variables.getVariableByIdAsync(id);
    if (v) variables[key] = v;
  } catch (e) {}
// Bind non-V16-bound and unbound product UI paints to V16 variables by role, with fallback option.

function rgbaPaintPatch(hex) {
  const raw = hex.replace('#', '');
  const color = { r: parseInt(raw.slice(0, 2), 16) / 255, g: parseInt(raw.slice(2, 4), 16) / 255, b: parseInt(raw.slice(4, 6), 16) / 255 };
  const opacity = raw.length >= 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
  return { color, opacity };
}
function isHeadUiInverse(path) { return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|arrow-left|more|time/i.test(path.join('/')); }
function isSelfOperatedLabel(path) { return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(path.join('/')); }
function isImageLabelPath(path) { return /商品图|店铺图|菜品图|image|图片|图\s*>|容器 2406|场景榜图片|主图/i.test(path.join(' > ')) && /top|TOP|标签|贴纸|角标|上榜理由|榜首|自营/i.test(path.join(' > ')); }
function isProductUiPath(path) { return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|product information|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|加购|分割线|描边|文案|文本|排行榜logo|上榜理由|战略标签|评分|月销量|起送|免运费|地址|导航到店|换一换|推荐更多/i.test(path.join('/')); }
function isFrozenPath(path) { const s=path.join('/'); if (isSelfOperatedLabel(path)) return true; if (isHeadUiInverse(path)) return false; if (isImageLabelPath(path)) return true; if (isProductUiPath(path) && !/商品图|店铺图|菜品图|主图|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false; return /商品图|店铺图|菜品图|logo|image|图片|贴纸|异形|背景图|banner|kv|主视觉|运营|会场/i.test(s); }
function isProductPath(path) { return !isFrozenPath(path) && (isProductUiPath(path) || /楼层|容器|背景|商品|榜/i.test(path.join('/'))); }
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function isLargeLightSurface(node, paint, key, path) {
  if (node.type === 'TEXT') return false;
  if (isHeadUiInverse(path)) return false;
  if (key !== 'fills') return false;
  const area = (node.width || 0) * (node.height || 0);
  const opacity = paint.opacity == null ? 1 : paint.opacity;
  return area > 1000 && lum(paint.color) > 0.75 && opacity > 0.55;
}
function isRankingSmallComponent(path) {
  return /tab|筛选|按钮\/24|chip|分类|选中态|未选中|父子嵌套|左对齐/i.test(path.join('/'));
}
function isProductCardTextRisk(node, paint, path, key) {
  if (key !== 'fills' || node.type !== 'TEXT') return false;
  if (!/商卡|product information|商品名称|标题|参数|卖点|利益点|价格|到手价|划线价|评分|月销量|起送|免运费|地址|导航到店|优惠|门店|店铺|菜/.test(path.join('/'))) return false;
  return lum(paint.color) < 0.45;
}
function inferRole(node, path, key, paint) {
  const s = `${path.join('/')} ${node.name || ''} ${node.type}`.toLowerCase();
  const l = lum(paint.color);
  if (isHeadUiInverse(path) || isSelfOperatedLabel(path)) return null;
  if (key === 'strokes') return 'border';
  if (node.type === 'TEXT') {
    if (!/二级tab|tab|frame 2085664464/.test(s) && /上榜理由|榜单特性|服务标签|免费上门|贴坏包赔|好评|买后说好|评分|4\.\d分|金榜分|服务金/.test(s)) return 'service';
    if (/价格|price|¥|到手价|同款低价|优惠类型|优惠信息/.test(s)) return 'primary';
    if (/划线价|原价|起送|45分钟/.test(s)) return 'help';
// Bind non-V16-bound and unbound product UI paints to V16 variables by role, with fallback option.
    if (/商品名称|标题|模式\/品牌名称|菜|寿喜烧|烧烤|和牛|放题|店/.test(s)) return 'title';
    if (/麦穗|金榜品牌|榜单标题/.test(s)) return 'serviceDecor';
    return null;
  }
  if (/mask|蒙层|透明层/.test(s)) return 'mask';
  if (!/二级tab|tab|frame 2085664464/.test(s) && /上榜理由|榜单特性|服务标签|免费上门|贴坏包赔|好评|买后说好|服务金/.test(s)) return 'serviceBg';
  if (/下单返|满\d+减|满减/.test(s)) return 'primaryLight';
  if (/ellipse 9225|按钮=红|红色|加购|union|价格/.test(s)) return 'primary';
  if (/商品名称|商卡类型=热卖商卡/.test(s)) return 'surface';
  if (/frame 2085664464|筛选|tab|分页|单行文字|背景|容器/.test(s) && l > 0.75) return 'surface';
  if (/矩形 4145|商卡|容器|背景|frame/.test(s)) return 'component';
  if (/麦穗|榜单|金/.test(s)) return 'serviceDecor';
  return null;
}

const changed = [];
const fallback = [];
const skipped = [];
function walk(node, path) {
  const next = path.concat(node.name || node.type);
  if (isFrozenPath(next)) return;
  const product = isProductPath(next);
  for (const key of ['fills', 'strokes']) {
    const paints = node[key];
    if (!Array.isArray(paints)) continue;
    let arr = null;
    for (let i = 0; i < paints.length; i++) {
      const p = paints[i];
      if (!p || p.type !== 'SOLID' || !p.color) continue;
      const boundId = p.boundVariables && p.boundVariables.color ? String(p.boundVariables.color.id || '') : '';
      const isV16Bound = /2029484645871009793/.test(boundId);
      const visualRisk = isLargeLightSurface(node, p, key, next) || isProductCardTextRisk(node, p, next, key) || key === 'strokes';
      const semanticForce = /价格|price|¥|到手价|同款低价|加购|按钮=红|ellipse 9225|下单返|满\d+减|满减|上榜理由|评分|月销量|起送|免运费|地址|导航到店|服务标签|免费上门|好评|买后说好/.test(next.join('/'));
      const shouldProcess = product && (!isV16Bound || visualRisk || semanticForce);
      if (!shouldProcess) continue;
      if (isRankingSmallComponent(next) && !isLargeLightSurface(node, p, key, next) && key !== 'strokes') continue;
      const role = inferRole(node, next, key, p);
      if (!role) { skipped.push({ id: node.id, name: node.name, reason: 'no-role' }); continue; }
      if (!arr) arr = paints.map(x => JSON.parse(JSON.stringify(x)));
      if (variables[role]) {
        arr[i] = relay.variables.setBoundVariableForPaint(arr[i], 'color', variables[role]);
        changed.push({ id: node.id, name: node.name, key, role, mode: 'token-bound', tokenName: variables[role].name });
      } else if (ALLOW_FALLBACK_HEX && FALLBACK_DARK[role]) {
        const patch = rgbaPaintPatch(FALLBACK_DARK[role]);
        arr[i].color = patch.color;
        arr[i].opacity = patch.opacity;
        delete arr[i].boundVariables;
        fallback.push({ id: node.id, name: node.name, key, role, mode: 'fallback-hex', darkHex: FALLBACK_DARK[role], opacity: patch.opacity });
      } else {
        skipped.push({ id: node.id, name: node.name, key, role, reason: 'no-token' });
      }
    }
    if (arr) node[key] = arr;
  }
  if (node.children) node.children.forEach(child => walk(child, next));
}
walk(root, []);
return { tokenBound: changed.length, fallbackHex: fallback.length, skipped: skipped.slice(0, 80), changed: changed.slice(0, 80), fallback: fallback.slice(0, 80), mutatedNodeIds: [...new Set(changed.concat(fallback).map(x => x.id))] };
