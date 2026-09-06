// Area classifier for zero-dark-mode-adapter Fast Mode 2.0.
// Default flow does not require switch-dark-mode. It clones, classifies areas, scans P0 risks, and fixes only risk nodes.

const ZDM_TARGET = {
  page: '#14171a',
// Area classifier for zero-dark-mode-adapter Fast Mode 2.0.
  channelIconZone: '#1f2226',
  tabRow: '#1f2226',
  tabItem: '#2a2f36',
  card: '#1f2226',
  waistCard: '#1f2226',
  title: '#e1e6eb',
  text: '#a1a9b3',
  help: '#717985',
  primary: '#ff0f23',
  primaryLight: '#40262a',
  border: '#ffffff1f',
  mask: '#0000001a'
};

function zdmPath(path) { return Array.isArray(path) ? path.join(' / ') : String(path || ''); }
function zdmLum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function zdmIsPrimaryRed(c) { return c && c.r > 0.85 && c.g < 0.16 && c.b < 0.28; }
function zdmIsHeadUi(path) { return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|基础导航栏|arrow-left|more|time|搜索|胶囊|常规-主流程|模式=日间模式|属性1=京东排行榜|属性1=京东金榜频道/i.test(zdmPath(path)); }
function zdmIsSelfOperatedLabel(path) { return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(zdmPath(path)); }
function zdmIsProductUiPath(path) { return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|加购|上榜理由|文本|优惠|导航|月销量|评分|门店|地址|起送|免运费|AI|ai|解读区域|换一换|推荐更多/i.test(zdmPath(path)); }
function zdmIsGenericHomeLikePath(path) { return /新品|首页|好货|特价|秒送|头部tab|底部tab|Joy Agent|天天领惊喜|首焦|A1A2|腰部|运营楼层|试用领取|限量尖货|抽签|红包|钩子品|新尖货|新首降/i.test(zdmPath(path)); }
function zdmIsStandardProductCardPath(path) { const s=zdmPath(path); return /商卡feeds|商卡|商品卡|商品名称|价格|加购|Frame 19406857|Auto Layout Vertical|product information|内容\/第一列|内容\/第二列/i.test(s) && !/首焦|A1A2|天天领惊喜|红包|抽签|试用|限量|Joy Agent|底部tab|运营楼层/i.test(s); }
function zdmIsGenericOperationalFloor(path) { const s=zdmPath(path); return zdmIsGenericHomeLikePath(path) && /首焦|A1A2|腰部|运营楼层|天天领惊喜|试用领取|限量尖货|抽签|红包|钩子品|新尖货|新首降|Joy Agent|底部tab|毛玻璃|营销阵地/i.test(s) && !zdmIsStandardProductCardPath(path); }
function zdmIsChannelBannerPath(path) { return /banner|容器 20121213730|容器 20121213732|楼层双列|排行榜招商|春节年货|全站热卖|全站折扣|全站热卖排行|全站折扣排行/i.test(zdmPath(path)); }
function zdmIsImageAsset(path) { const s=zdmPath(path); if (zdmIsChannelBannerPath(path)) return true; if (zdmIsProductUiPath(path) && !/商品图|店铺图|菜品图|主图|店铺LOGO|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false; return /商品图|店铺图|菜品图|image|图片|图\s*>|主图|店铺LOGO|logo|背景图|头图|频道头图|banner|kv|主视觉|运营|会场|模特|品牌图/i.test(s); }
function zdmIsImageLabel(path) { const s=zdmPath(path); if (/属性1=透底图|矩形 5862|排名标|排名标小/i.test(s) && /属性1=商品榜|榜单卡片区域|榜单小卡|属性1=上榜商品/i.test(s)) return true; if (/商品图109\/(商品图|矩形 5862|排名标|排名标小)|店铺LOGO/i.test(s) && /属性1=店铺榜|店铺榜feeds|店铺卡|属性1=上榜店铺/i.test(s)) return true; return zdmIsImageAsset(path) && /top|TOP|标签|贴纸|角标|上榜理由|榜首|自营|排名标/i.test(s); }
function zdmIsFrozen(path) { const s = zdmPath(path); if (zdmIsSelfOperatedLabel(path)) return true; if (/属性1=选中左侧页签|选中左侧页签|常规页签|联集 34|路径 44|路径 45/i.test(s)) return false; if (zdmIsHeadUi(path)) return true; if (zdmIsGenericOperationalFloor(path)) return true; if (zdmIsImageLabel(path)) return true; if (zdmIsProductUiPath(path) && !/商品图|店铺图|菜品图|主图|店铺LOGO|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s)) return false; if (zdmIsImageAsset(path)) return true; if (/色块标签|5个以上左对齐/i.test(s)) return true; return false; }

function zdmArea(path, node) {
  const s = `${zdmPath(path)} / ${node && node.name || ''}`;
  if (zdmIsFrozen(path)) return 'frozen';
  if (/频道|金榜|商品榜|店铺榜|美食榜|AI全网评|推荐|父子嵌套|选中页签|选中左侧页签/i.test(s) && /FRAME|INSTANCE|RECTANGLE|VECTOR|BOOLEAN_OPERATION/.test(node.type)) return 'channel-icon-zone';
  if (/一级tab|文字类型Tabs|tab行|频道tab|容器 20121214401/i.test(s)) return 'tab-row';
  if (/二级tab|末级tab|筛选|按钮\/24|chip|分类|未选中|选中态|小方块|Frame 2085664463|Frame 2085664464/i.test(s)) return 'tab-item';
  if (/商卡|商品卡|店铺卡|榜单小卡|商品名称|product information|容器 2557|容器 6811794|feeds|商品榜单卡片|属性1=商品榜|属性1=上榜商品/i.test(s)) return 'card';
  if (/腰部|banner|楼层|场景榜|折扣排行|AI榜单卡片|解读区域|推荐更多|专属榜单|换一换/i.test(s)) return 'waist-card';
  if (/页面|画板|root/i.test(s) || (node && node.width >= 350 && node.height >= 700)) return 'page';
  return 'unknown';
}

function zdmTextRole(path, node) {
  const s = `${zdmPath(path)} / ${node && node.name || ''}`.toLowerCase();
  if (!/二级tab|tab|Frame 2085664464/.test(s) && /上榜理由|榜单特性|服务标签|免费上门|贴坏包赔|好评|买后说好|评分|4\.\d分|金榜分|服务金/.test(s)) return 'service';
  if (/价格|price|¥|到手价|同款低价|优惠类型|优惠信息/.test(s)) return 'primary';
  if (/划线价|原价|弱辅助|起送|45分钟/.test(s)) return 'help';
  if (/参数|卖点|利益点|描述|免运费|地址|km|导航到店|门店休息中|内容-|说明|解读/.test(s)) return 'text';
  if (/标题|榜单标题|商品名称|店名|主标题|菜名|门店名|AI榜单标题/.test(s)) return 'title';
  if (/tab|二级tab|频道|推荐|商品榜|店铺榜|美食榜|AI全网评/.test(s)) return 'text';
  return 'text';
}

function zdmTargetForArea(area, path, node) {
  if (area === 'page') return ZDM_TARGET.page;
  if (area === 'channel-icon-zone') return ZDM_TARGET.channelIconZone;
  if (area === 'tab-row') return ZDM_TARGET.tabRow;
  if (area === 'tab-item') return ZDM_TARGET.tabItem;
  if (area === 'waist-card') return ZDM_TARGET.waistCard;
  if (area === 'card') return ZDM_TARGET.card;
  return null;
}
