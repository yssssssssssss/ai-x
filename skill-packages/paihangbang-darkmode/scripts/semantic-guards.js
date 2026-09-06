// Shared semantic guards for zero-dark-mode-adapter scripts.
// Copy this block unchanged into use_design_script snippets.
// Keep scan/fix/batch scripts aligned with this source.

function zdmPath(path) {
// Shared semantic guards for zero-dark-mode-adapter scripts.
  return Array.isArray(path) ? path.join(' / ') : String(path || '');
}

function zdmIsHeadUiInverse(path) {
  const s = zdmPath(path);
  return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|基础导航栏|arrow-left|more|time|搜索|胶囊|常规-主流程|模式=日间模式|属性1=京东排行榜|属性1=京东金榜频道/i.test(s);
}

function zdmIsImageLabelPath(path) {
  const s = zdmPath(path);
  if (/属性1=透底图|矩形 5862|排名标|排名标小/i.test(s) && /属性1=商品榜|榜单卡片区域|榜单小卡|属性1=上榜商品/i.test(s)) return true;
  if (/商品图109\/(商品图|矩形 5862|排名标|排名标小)|店铺LOGO/i.test(s) && /属性1=店铺榜|店铺榜feeds|店铺卡|属性1=上榜店铺/i.test(s)) return true;
  return /商品图|店铺图|菜品图|image|图片|图\s*>|容器 2406|场景榜图片|主图|店铺LOGO|logo/i.test(s) && /top|TOP|标签|贴纸|角标|上榜理由|榜首|自营|排名标/i.test(s);
}

function zdmIsProductUiPath(path) {
  const s = zdmPath(path);
  return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|加购|上榜理由|文本|优惠|导航|月销量|评分|门店|地址|起送|免运费|AI|ai|解读区域|换一换|推荐更多/i.test(s);
}

function zdmIsGenericHomeLikePath(path) {
  const s = zdmPath(path);
  return /新品|首页|好货|特价|秒送|头部tab|底部tab|Joy Agent|天天领惊喜|首焦|A1A2|腰部|运营楼层|试用领取|限量尖货|抽签|红包|钩子品|新尖货|新首降/i.test(s);
}

function zdmIsStandardProductCardPath(path) {
  const s = zdmPath(path);
  return /商卡feeds|商卡|商品卡|商品名称|价格|加购|Frame 19406857|Auto Layout Vertical|product information|内容\/第一列|内容\/第二列/i.test(s) && !/首焦|A1A2|天天领惊喜|红包|抽签|试用|限量|Joy Agent|底部tab|运营楼层/i.test(s);
}

function zdmIsGenericOperationalFloor(path) {
  const s = zdmPath(path);
  return zdmIsGenericHomeLikePath(path) && /首焦|A1A2|腰部|运营楼层|天天领惊喜|试用领取|限量尖货|抽签|红包|钩子品|新尖货|新首降|Joy Agent|底部tab|毛玻璃|营销阵地/i.test(s) && !zdmIsStandardProductCardPath(path);
}

function zdmIsChannelBannerPath(path) {
  const s = zdmPath(path);
  return /banner|容器 20121213730|容器 20121213732|楼层双列|排行榜招商|春节年货|全站热卖|全站折扣|全站热卖排行|全站折扣排行/i.test(s);
}

function zdmIsOperationalVisual(path) {
  const s = zdmPath(path);
  if (zdmIsChannelBannerPath(path)) return true;
  if (zdmIsProductUiPath(path)) return false;
// Shared semantic guards for zero-dark-mode-adapter scripts.
}

function zdmIsFrozenPath(path) {
  const s = zdmPath(path);
  if (/属性1=选中左侧页签|选中左侧页签|常规页签|联集 34|路径 44|路径 45/i.test(s)) return false;
  if (zdmIsHeadUiInverse(path)) return true;
  if (zdmIsGenericOperationalFloor(path)) return true;
  if (zdmIsImageLabelPath(path)) return true;
  if (zdmIsProductUiPath(path) && !/商品图|店铺图|菜品图|主图|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false;
  if (zdmIsOperationalVisual(path)) return true;
  if (/商品图|店铺图|菜品图|logo|image|图片|贴纸|异形|色块标签|自营|5个以上左对齐/i.test(s)) return true;
  return false;
}

function zdmIsProductPath(path) {
  if (zdmIsFrozenPath(path)) return false;
  return zdmIsProductUiPath(path) || /楼层|容器|背景|商品|榜/i.test(zdmPath(path));
}

function zdmIsTargetContainer(path) {
  const s = zdmPath(path);
  if (zdmIsFrozenPath(path)) return false;
  return /feeds|商卡feeds|楼层|商品榜单卡片|商品卡|店铺榜|美食榜|AI荐榜|店铺|商卡|AI榜单卡片|解读区域|容器 2557|容器 6811794/i.test(s);
}

function zdmIsCriticalTitle(path, node) {
  const s = `${zdmPath(path)} / ${node && node.name || ''}`;
  if (zdmIsFrozenPath(path)) return false;
  return /标题|榜单标题|商品名称|店名|主标题|菜名|门店名|AI榜单标题/i.test(s);
}

function zdmIsChannelSelectedBg(path, node) {
  const s = `${zdmPath(path)} / ${node && node.name || ''}`;
  if (zdmIsFrozenPath(path)) return false;
  return /频道|金榜|商品榜|店铺榜|美食榜|AI全网评|推荐|选中页签|选中左侧页签|选中态/.test(s) && /FRAME|INSTANCE|RECTANGLE|VECTOR|BOOLEAN_OPERATION/.test(node.type);
}

function zdmIsPrimaryRed(c) {
  return c && c.r > 0.85 && c.g < 0.15 && c.b < 0.25;
}

function zdmLum(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function zdmHex(c, op) {
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const b = `#${h(c.r)}${h(c.g)}${h(c.b)}`.toLowerCase();
  return op != null && op < 1 ? b + Math.round(op * 255).toString(16).padStart(2, '0') : b;
}

function zdmIsLargeLightSurface(node, paint, key, path) {
  if (!node || !paint || !paint.color) return false;
  if (node.type === 'TEXT') return false;
  if (zdmIsFrozenPath(path)) return false;
  if (key !== 'fills') return false;
  const area = (node.width || 0) * (node.height || 0);
  const op = paint.opacity == null ? 1 : paint.opacity;
  return area > 1000 && zdmLum(paint.color) > 0.75 && op > 0.55;
}

function zdmIsDarkCriticalText(node, paint, key, path) {
  if (!node || !paint || !paint.color) return false;
  if (key !== 'fills' || node.type !== 'TEXT') return false;
  if (zdmIsFrozenPath(path)) return false;
  if (zdmIsPrimaryRed(paint.color)) return false;
  if (!zdmIsCriticalTitle(path, node)) return false;
  return zdmLum(paint.color) < 0.55;
}
