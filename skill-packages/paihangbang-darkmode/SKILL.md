---
name: paihangbang-darkmode
description: 使用 Zero MCP 为京东排行榜/金榜/频道聚合页及部分非排行榜通用页面安全生成暗黑适配副本。适用于用户提到排行榜频道、金榜、商品榜、店铺榜、美食榜、AI 全网评、数据榜、新品页、通用频道页、夜间模式、Dark Mode、深色稿、画板换暗色或批量替换颜色时；会整体 clone 原画板，先识别 ranking-channel 与 generic-home-like 页面类型，冻结头图、Banner/运营楼层、商品图、图内排行标、自营标和强运营视觉，只适配页面/feeds/Tab/标准商卡/店铺卡等产品化 UI，并按 JD V16 语义或 fallback dark hex 修复浅底、暗字、Tab 描边和错误 token。
version: 1.23.0
allowed-tools: [mcp__zero-design__get_design_metadata, mcp__zero-design__get_design_context, mcp__zero-design__get_screenshot, mcp__zero-design__get_variables, mcp__zero-design__use_design_script, Read]
---

# Zero 暗黑模式适配

## 目标

在不修改原稿的前提下，为选中画板创建或更新暗黑副本。定位是缓存驱动的暗黑设计稿生成器，不是实时组件库巡检器。默认先走 Fast Mode 2.0：整体 clone 原画板 → 跳过冻结区 → 按区域分类扫描 P0 风险 → 只修 P0 风险节点 → 截图验收。默认不再执行 switch-dark-mode；只有用户要求使用变量模式或当前稿件已高质量绑定 V16 时，才可额外切暗色模式。复制阶段必须只做 clone，不允许遍历或改内部节点；主体区域白底、一级频道选中白色承托底和关键标题暗字是一票否决项。默认区域目标色统一为：页面/频道底 #14171A，频道 icon 区、一级/二级 Tab 行、页面承托、卡片、楼层 #1F2226，块状 Tab/未选中小方块/二级筛选 chip #2A2F36，未选中文字 #A1A9B3，弱辅助文字 #717985。 非排行榜通用页面（如新品/首页-like）先进入 generic-home-like 模式：除标准商品流商卡外，首焦、腰部楼层、运营楼层、天天领惊喜、试用/限量/营销模块等默认冻结，避免把运营图文拆成产品 UI 改色。不再默认使用 #000000 作为页面底，除非用户明确指定纯黑视觉。若 Fast Mode 验收不通过，不要暂停询问，自动进入 Full Mode 继续处理 P1/P2 风险；只有 Full Mode 后仍失败，才报告阻塞。

资源加载

按需读取，不要一次性加载所有资源：

资源	何时读取
references/dark-mode-switching.md	切换暗色模式前必读
references/semantic-freeze-rules.md	语义分区与冻结前必读
references/rebind-light-to-v16.md	主路径：日间色重绑定到 V16 前必读
references/v16-role-token-rules.md	绑定/匹配 V16 token 前必读
references/validation-playbook.md	验收前必读
references/data-rank-playbook.md	数据榜类页面必读
references/ranking-page-playbook.md	排行榜/金榜页面必读
references/product-card-playbook.md	商品榜/商品卡页面必读
references/white-risk-rules.md	白色前景与白底风险判断前必读
references/donts.md	失败恢复或不确定时读取
cache/v16-color-token-cache.json	需要离线 token 映射时读取

可复用脚本模板：

脚本	用途
scripts/clone-only.js	Phase 1：只整体复制副本，禁止内部处理
scripts/switch-dark-mode.js	Phase 2：只切换副本暗色模式
scripts/semantic-guards.js	统一语义守卫规则，所有扫描/修复脚本必须保持一致
scripts/scan-fast-risks.js	Fast Phase 3：只读扫描 P0 风险节点 ID
scripts/fix-fast-risks.js	Fast Phase 4：只按 P0 风险 ID 修复
scripts/scan-dark-risks.js	Full Phase 3：只读扫描全部风险节点 ID
scripts/fix-risk-nodes.js	Full Phase 4：只按全部风险 ID 修复
scripts/clone-and-switch-dark.js	旧版兼容：复制副本并切暗色模式
scripts/scan-unbound-product-ui.js	旧版兼容：扫描产品化 UI 未绑定项
scripts/build-v16-token-cache.js	在 16.0 组件库文件中生成 token cache seed
scripts/bind-v16-token-by-role.js	按角色绑定 V16 token / fallback
scripts/validate-dark-result.js	验收暗黑副本
核心约束
原画板只读，不修改、不重命名、不移动。
副本与原画板同级，默认命名为原画板名加 _暗黑适配，位置为原画板右侧。
复制阶段必须只整体 clone 原画板，不得逐层重画或重建节点。
clone-only 阶段只允许改副本根节点 name / x / y / shared plugin data；禁止遍历子节点、改 fill/stroke、加载字体、截图修复。
除副本根节点预定位置外，不改变几何、布局、层级和文本。
已绑定 token 不等于正确；副本内非冻结 product-ui 如果绑定了非 V16、旧库、错误角色 token，或切暗后视觉仍不符合目标层级，必须允许解绑并修复，不得因为存在 boundVariables 就跳过。
对于已判定必须修复的风险节点，写入必须可见：直接替换目标属性的 fills/strokes 数组并清理错误 boundVariables，或确保目标 paint 位于最上层；不得把新颜色写在旧渐变/旧 fill 下方。
如果风险节点是 Frame/Instance 等容器，且真实颜色由内部 Union/Vector/Rectangle/BooleanOperation 承载，应向下钻取到最末可绘制子层并替换实际 paint。
优先使用副本根节点的变量模式切换获得暗色结果。
最终目标是设计师可接受的暗黑视觉稿；token 绑定是手段，不是唯一目标。
运营主视觉/切图区域冻结；头图上的状态栏、返回、更多、标题等 UI 可作为 head-ui-inverse 保持浅色反显。
顶部导航、商卡色块标签默认冻结当前视觉；自营标全局冻结，不管什么页面都不受暗黑模式影响，不做 V16 重绑定、切暗或 fallback 改色；只有用户明确点名“只改自营标”时才例外。
商卡信息区内的上榜理由标签、下单返/满减等促销弱底和加购按钮属于 product-ui，应参与暗黑适配；商品图/菜品图内非标上榜理由、TOP、贴纸、角标及其文字仍整组冻结。
补绑 token 只允许来自 JD V16 色彩 token；不匹配业务组件库专用色。
补绑必须先判断区域语义与颜色角色，禁止跨角色匹配。
不确定区域保守跳过，报告为“待设计师确认”。
暗黑卡片/feeds 内标题和正文太暗时，默认直接提亮，不询问用户。
允许 fallback 直写 dark hex，但必须报告为 fallback-hex，不得冒充 token 绑定。
组件库语义来源

已确认 16.0 组件库包含以下颜色语义来源：

↘️ 色彩 Colors：基础色阶，含 日间模式 / 暗色模式。
↘️ 语义化统一变量：通用语义 token，值多为 alias，含 primary/text/background/mask/line/service/success/error/warning/info。
↘️ AI色彩 Colors：AI 品牌色阶，含 日间模式 / 暗黑模式。
↘️ AI语义化统一变量：AI 场景语义 token，值多为 alias。

外部文档来源：

JD V16 色彩 Token：http://xingyun.jd.com/codingRoot/JD-Design-Wiki/2C-DesignWiki/blob/main/jd-design-system-md-v16/foundations/%E8%AE%BE%E8%AE%A1%E8%AF%AD%E8%A8%80%E5%9F%BA%E7%A1%80%EF%BC%88Design%20Tokens%EF%BC%89/%E8%89%B2%E5%BD%A9Token/design.md
快速工作流
步骤 1 门禁
  → MCP 可用
  → 目标画板明确
  → 读取原稿截图与元数据
  → 确认仅追加副本，不覆盖原稿

步骤 2 Phase 1：clone-only
  → 整体 clone 原画板到右侧
  → 只允许改副本根节点 name / x / y / shared plugin data
  → 禁止遍历子节点、禁止改 fill/stroke、禁止加载字体、禁止重建结构

步骤 3 可选 Phase：switch-dark-mode
  → 默认跳过
  → 仅当用户要求使用变量模式，或当前稿件已高质量绑定 V16 时执行
  → 只对副本根节点 setExplicitVariableModeForCollection
  → 禁止内部改色

步骤 4 Fast Phase 3：scan-fast-risks
  → 只读扫描，跳过冻结区
  → 先做区域分类：page / channel-icon-zone / tab-row / tab-item / waist-card / card / text
  → 只输出 P0 风险：areaBg / textLow
  → 主体区域白底和关键标题暗字是一票否决

步骤 5 Fast Phase 4：fix-fast-risks
  → 只按 scan-fast 输出的 P0 风险节点 ID 修复
  → 不处理促销标签、边框、同组一致性、小组件细节
  → 不再全树边扫边改

步骤 6 Phase 5：validate
  → 主体白底一票否决
  → 关键标题暗字一票否决
  → 若 Fast Mode 通过：完成并报告 P1/P2 剩余项
  → 若 Fast Mode 不通过：自动进入 Full Mode，不暂停询问

步骤 7 Full Mode（仅 Fast 不通过或用户要求精修）
  → 运行 scan-dark-risks / fix-risk-nodes
  → 处理 promoLightBg / strokeOrMask / group consistency / 残留白底 / 残留暗字
  → Full Mode 后仍失败才报告阻塞

暗色模式切换原则

优先使用 explicitVariableModes，不要依赖远程库全量读取。

已验证样本方式：

const sample = await relay.getNodeByIdAsync(sampleDarkNodeId)
const modes = sample.explicitVariableModes
for (const collectionId of Object.keys(modes)) {
  const collection = await relay.variables.getVariableCollectionByIdAsync(collectionId)
  frame.setExplicitVariableModeForCollection(collection, modes[collectionId])
}


如果用户未提供样本，则在当前文件内查找名称含 色彩 / Colors / Color / 语义 的 collection，并找 mode 名含 暗色模式 / 暗黑模式 / Dark / Night。

性能纪律：

官方组件库巡检只用于刷新本地 cache，不在每次适配运行时全量读取。
运行时只巡检当前副本的非冻结 product-ui。
不要对全子树每个 paint 都调用 getVariableByIdAsync。
不要把 teamLibrary.getVariablesInLibraryCollectionAsync 作为主路径；它可能返回 0 或超时。
只通过 bound variable id/key 字符串快速判断是否 V16；必要时抽样解析。
优先处理大面积背景和必要的 strokes；TEXT 只有在不可读或明确非 V16 文本角色时处理，不把浅色文字当风险。
单次脚本处理 paint 建议不超过 150；超出应分批或报告剩余项。
初次失败后应改用更小范围脚本，不要原样重试。
批量处理不得临时手写另一套冻结/扫描逻辑；必须复用 semantic-guards.js 中的判断口径。
主体区域白底一票否决：feeds、主内容区、商品/店铺/楼层卡片、页面根背景仍为大面积浅底时，不得宣布完成。
语义分区与冻结

补绑前必须先完成语义分区。详见 references/semantic-freeze-rules.md。

必须冻结：

运营感重的 banner、KV、主视觉、会场头图、频道头图、排行榜头图、金榜头图。
商品图、模特图、品牌图、运营素材图。
通过多个色块、渐变、矢量、装饰形状绘制，但实际开发会整体切图交付的区域。
商品图左上角等非标准形状标签、贴纸、异形角标、特殊装饰标签。
不确定是否切图的装饰区。

应参与适配：

页面背景、内容背景、卡片背景。
商品卡片底色、商品标题、参数/卖点/辅助信息、价格、利益点文案、产品化按钮、上榜理由标签、加购按钮。
标准 Tab、筛选项、分割线、描边、蒙层、系统导航控件。
排行榜/金榜等产品化标签；但如果标签位于商品图内部且是非标准形状切图，仍然冻结。
V16 token 匹配

详见 references/v16-role-token-rules.md。

硬规则：

颜色角色	允许 token 类别	禁止
页面/卡片/容器背景	background / surface / container / card	primary / brand / text
标题/正文/辅助文字	title / text / help / disabled	background / border
描边/分割线	border / divider / line	text / primary
品牌红/操作强调	primary / brand / action	background / surface
金色/榜单产品化标签	service / gold / rank 相关 token	运营视觉金色不绑
蒙层/遮罩	mask / overlay	text / primary
图标	icon / text / primary，按图标语义判断	background
AI 场景	默认按普通 V16 背景/文字/边框规则；仅明确 AI 品牌标识、星星、评分、专属描边才用 AI 色阶	仅因节点名或标题含 AI 就强行匹配 AI 紫色
绑定与 fallback

优先级：

已绑定 V16：保留，后续切暗时自然生效。
产品化 UI 中非 V16 绑定：不得默认保留，应按角色和 Light 色相似度重绑到 V16 或记录 fallback 候选。
未绑定但能在当前文件找到同角色 V16 变量：绑定变量。
找不到变量但 token cache 有可靠 dark 值：fallback 直写 dark hex，并标记 fallback-hex。
低置信度或找不到同角色 token：跳过，标记 pending。

fallback 必须报告：

节点范围。
数量。
使用的 token 或 dark 值来源。
为什么不能绑定变量。
固定报告格式
**结论**
已生成/更新暗黑副本：[副本名]，节点 ID：[id]。

**路径**
门禁 → 复制副本 → 切暗色模式 → 语义分区 → 产品化 UI 补绑/fallback → 验收。

**副本信息**
- 原画板：[name] [id]
- 副本：[name] [id]
- 位置：[x, y]
- 尺寸：[width × height]

**模式切换**
- explicitVariableModes：[count]
- mode 来源：[手动样本/当前文件 collection/cache]
- 切换结果：[成功/失败]

**冻结区域**
- [区域名]：原因，如运营头图/商品图/非标准切图标签/待设计师确认

**处理统计**
- mode-switch 自然生效：[count]
- token-bound：[count]
- fallback-hex：[count]
- frozen：[count]
- pending：[count]

**跳过与待确认**
- 未匹配 V16 token：[count]
- 低置信度：[count]
- 待设计师确认：[items]

**验收结果**
- 原稿未修改：[是/否]
- 几何一致：[是/否]
- 冻结区保持：[是/否]
- 是否存在跨角色误绑：[是/否]
- 视觉结论：[可用/需复核]

失败处理
如果复制失败，停止，不修改原稿。
如果切暗色模式失败，报告无法找到可用暗色 mode，不进入全量改色。
如果找不到 V16 token 来源，只输出未绑定清单，不进行跨角色猜测。
如果 Fast Mode 验收不通过，自动进入 Full Mode，不要暂停询问。
如果 Full Mode 仍不通过，报告阻塞和剩余风险。
如果脚本超时，缩小范围重试；不要原样重试。
如果已经创建副本但后续失败，保留副本并报告状态；删除副本必须先获得用户弹窗确认。
