// Fast Mode 2.0 Phase 2: scan P0 risks only. Do not modify anything.
// Replace ORIGINAL_ID and COPY_ID before running in use_design_script.
// Default flow does not require switch-dark-mode.

const ORIGINAL_ID = 'REPLACE_WITH_ORIGINAL_ID';
const COPY_ID = 'REPLACE_WITH_COPY_NODE_ID';
const original = await relay.getNodeByIdAsync(ORIGINAL_ID);
const copy = await relay.getNodeByIdAsync(COPY_ID);
if (!original || !copy) throw new Error('original or copy not found');

const ZDM_TARGET = { page:'#14171a', channelIconZone:'#1f2226', tabRow:'#1f2226', tabItem:'#2a2f36', card:'#1f2226', waistCard:'#1f2226', title:'#e1e6eb', text:'#a1a9b3', help:'#717985', primary:'#ff0f23', primaryLight:'#40262a', service:'#b38b6d', serviceBg:'#3a2b1a', serviceLine:'#4d443d', border:'#ffffff1f', mask:'#0000001a' };
function zdmPath(path){return Array.isArray(path)?path.join(' / '):String(path||'');}
function zdmLum(c){return .2126*c.r+.7152*c.g+.0722*c.b;}
function zdmIsPrimaryRed(c){return c&&c.r>.85&&c.g<.16&&c.b<.28;}
function zdmHex(c,op){const h=v=>Math.round(Math.max(0,Math.min(1,v))*255).toString(16).padStart(2,'0');const b=`#${h(c.r)}${h(c.g)}${h(c.b)}`.toLowerCase();return op!=null&&op<1?b+Math.round(op*255).toString(16).padStart(2,'0'):b;}
function zdmIsHeadUi(path){return /状态栏|status|battery|wifi|cell|返回|更多|navbar|顶部导航|排行榜顶部导航|基础导航栏|arrow-left|more|time|搜索|胶囊|常规-主流程|模式=日间模式|属性1=京东排行榜|属性1=京东金榜频道/i.test(zdmPath(path));}
function zdmIsSelfOperatedLabel(path){return /自营标|业务模式标=自营|自营文字|模式\/品牌名称.*自营|\/自营(\/|$)|自营秒送标签|组件 19\/自营秒送标签/i.test(zdmPath(path));}
function zdmIsProductUiPath(path){return /feeds|商卡feeds|商卡|商品卡|店铺卡|榜单小卡|商品榜单卡片|商品名称|商品榜|店铺榜|美食榜|tab|二级tab|筛选|chip|价格|标题|利益点|button|按钮|加购|上榜理由|文本|优惠|导航|月销量|评分|门店|地址|起送|免运费|AI|ai|解读区域|换一换|推荐更多/i.test(zdmPath(path));}
function zdmIsImageAsset(path){const s=zdmPath(path); if(zdmIsProductUiPath(path)&&!/商品图|店铺图|菜品图|主图|店铺LOGO|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s))return false; return /商品图|店铺图|菜品图|image|图片|图\s*>|主图|店铺LOGO|logo|背景图|头图|频道头图|banner|kv|主视觉|运营|会场|模特|品牌图/i.test(s);}
function zdmIsImageLabel(path){return zdmIsImageAsset(path)&&/top|TOP|标签|贴纸|角标|上榜理由|榜首|自营|排名标/i.test(zdmPath(path));}
function zdmIsFrozen(path){const s=zdmPath(path); if(zdmIsSelfOperatedLabel(path))return true; if(zdmIsHeadUi(path))return true; if(zdmIsImageLabel(path))return true; if(zdmIsProductUiPath(path)&&!/商品图|店铺图|菜品图|主图|店铺LOGO|logo|image|图片|贴纸|异形|色块标签|自营/i.test(s))return false; if(zdmIsImageAsset(path))return true; if(/色块标签|5个以上左对齐/i.test(s))return true; return false;}
function zdmArea(path,node){const s=`${zdmPath(path)} / ${node&&node.name||''}`; if(zdmIsFrozen(path))return 'frozen'; if(/频道|金榜|商品榜|店铺榜|美食榜|AI全网评|推荐|父子嵌套|选中页签|选中左侧页签/i.test(s)&&/FRAME|INSTANCE|RECTANGLE|VECTOR|BOOLEAN_OPERATION/.test(node.type))return 'channel-icon-zone'; if(/一级tab|文字类型Tabs|tab行|频道tab|容器 20121214401/i.test(s))return 'tab-row'; if(/二级tab|末级tab|筛选|按钮\/24|chip|分类|未选中|选中态|小方块|Frame 2085664463|Frame 2085664464/i.test(s))return 'tab-item'; if(/腰部|banner|楼层|场景榜|折扣排行|AI榜单卡片|解读区域|推荐更多|专属榜单|换一换/i.test(s))return 'waist-card'; if(/商卡|商品卡|店铺卡|榜单小卡|商品名称|product information|容器 2557|容器 6811794|feeds/i.test(s))return 'card'; if(/页面|画板|root/i.test(s)||(node&&node.width>=350&&node.height>=700))return 'page'; return 'unknown';}
function zdmTextRole(path,node){const s=`${zdmPath(path)} / ${node&&node.name||''}`.toLowerCase(); if(!/二级tab|tab|Frame 2085664464/i.test(s)&&/上榜理由|榜单特性|服务标签|免费上门|贴坏包赔|好评|买后说好|评分|4\.\d分|金榜分|服务金/.test(s))return 'service'; if(/价格|price|¥|到手价|同款低价|优惠类型|优惠信息/.test(s))return 'primary'; if(/划线价|原价|弱辅助|起送|45分钟/.test(s))return 'help'; if(/参数|卖点|利益点|描述|免运费|地址|km|导航到店|门店休息中|内容-|说明|解读/.test(s))return 'text'; if(/标题|榜单标题|商品名称|店名|主标题|菜名|门店名|AI榜单标题/.test(s))return 'title'; if(/tab|二级tab|频道|推荐|商品榜|店铺榜|美食榜|AI全网评/.test(s))return 'text'; return 'text';}
function zdmTargetForArea(area){return ZDM_TARGET[area]||null;}
function zdmTargetForPaint(area,path,node){const s=`${zdmPath(path)} / ${node&&node.name||''}`.toLowerCase(); if(!/二级tab|tab|Frame 2085664464/i.test(s)&&/上榜理由|榜单特性|服务标签|免费上门|贴坏包赔|好评|买后说好|服务金/.test(s)) return ZDM_TARGET.serviceBg; return zdmTargetForArea(area);}
function isLightBg(node,paint,key){if(node.type==='TEXT'||key!=='fills')return false; const area=(node.width||0)*(node.height||0); const op=paint.opacity==null?1:paint.opacity; return area>900&&zdmLum(paint.color)>.72&&op>.45;}
function isLowContrastText(node,paint,key,path){if(node.type!=='TEXT'||key!=='fills')return false; if(zdmIsPrimaryRed(paint.color))return false; const role=zdmTextRole(path,node); if(role==='primary')return false; return zdmLum(paint.color)<.55;}

const risks={areaBg:[], textLow:[]};
const stats={frozen:0, scannedPaints:0, whiteForeground:0};
function push(kind,node,key,paint,path,area,target){if(risks[kind].length>=120)return; risks[kind].push({id:node.id,name:node.name,type:node.type,key,color:zdmHex(paint.color,paint.opacity),area,target,path:path.slice(-6).join(' > ')});}
function shouldDescend(path){if(zdmIsFrozen(path))return false; const s=zdmPath(path); return /容器|frame|feeds|tab|商卡|店铺|楼层|AI|榜|商品|美食|排行榜|content|card/i.test(s)||path.length<=3;}
function walk(node,path){const next=path.concat(node.name||node.type); const area=zdmArea(next,node); if(area==='frozen'){stats.frozen++; return;} for(const key of ['fills','strokes']){const paints=node[key]; if(!Array.isArray(paints))continue; for(const paint of paints){if(!paint||paint.type!=='SOLID'||!paint.color)continue; stats.scannedPaints++; if((node.type==='TEXT'||/icon|图标|arrow|返回|more|搜索|购物车/i.test(node.name||''))&&zdmLum(paint.color)>.75)stats.whiteForeground++; if(isLightBg(node,paint,key)){const target=zdmTargetForPaint(area,next,node); if(target)push('areaBg',node,key,paint,next,area,target);} if(isLowContrastText(node,paint,key,next)){const role=zdmTextRole(next,node); const target=ZDM_TARGET[role]||ZDM_TARGET.text; push('textLow',node,key,paint,next,`text:${role}`,target);}}}
if(node.children&&shouldDescend(next))node.children.forEach(c=>walk(c,next));}
walk(copy,[]);
return {phase:'scan-fast-risks-areas', copy:{id:copy.id,name:copy.name}, geometry:{sameSize:Math.abs(original.width-copy.width)<.01&&Math.abs(original.height-copy.height)<.01,rightSide:copy.x>original.x}, stats, risks, failFast:{areaBgCount:risks.areaBg.length,textLowCount:risks.textLow.length,shouldFail:risks.areaBg.length>0||risks.textLow.length>0}};

