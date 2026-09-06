JD V16 颜色角色与 token 匹配规则
来源

优先来源：

16.0 组件库当前文件中的变量集合。
JD-Design-Wiki V16 色彩 Token 文档：jd-design-system-md-v16/foundations/设计语言基础（Design Tokens）/色彩Token/design.md。
本 skill 缓存：cache/v16-color-token-cache.json。
组件库内已确认的色彩语义集合

当前 16.0 组件库中，除基础 ↘️ 色彩 Colors 外，还存在以下语义集合，应纳入 token 规则：

↘️ 色彩 Colors：基础色阶，含日间/暗色模式。
↘️ 语义化统一变量：通用语义 token，值多为 alias，含 primary/text/background/mask/line/service/success/error/warning/info。
↘️ AI色彩 Colors：AI 品牌色阶，含日间/暗黑模式。
↘️ AI语义化统一变量：AI 场景语义 token，值多为 alias。
基础色彩集合示例

↘️ 色彩 Colors：

Token	日间	暗色	角色建议
灰阶/gray_7	#11141a	#e1e6eb	text/title
灰阶/gray_6	#4f5259	#a1a9b3	text/body
灰阶/gray_5	#8d9199	#717985	text/help
灰阶/gray_4	#b4b8bf	#4b5159	disabled/border/icon
灰阶/gray_3	#f2f4f7	#14171a	background/page
灰阶/gray_2	#ebedf2	#2a2f36	background/component
灰阶/gray_1	#ffffff	#1f2226	surface/card/overlay
蒙层/mask_1	#11141a05	#0000001a	mask/light
蒙层/mask_2	#11141a14	#ffffff1f	border/mask
蒙层/mask_5	#11141a66	#00000066	mask/part
蒙层/mask_6	#11141ab2	#000000b2	mask/block
品牌色/jdred_6	#ff0f23	#ff0f23	primary/brand
品牌色/red_1	#ffe8ee	#40262a	primary-light-bg
品牌色/red_2	#ffccd7	#3d2128	primary-light-pressed
服务金/servicegold_1	#fff4e0	#3a2b1a	service-bg
服务金/servicegold_2	#f2ba79	#d1995a	service
服务金/servicegold_4	#80512d	#b38b6d	service-text
语义化统一变量示例
Token	Alias 指向	角色
主色 primary/color_primary	品牌色/jdred_6	primary
主色 primary/color_primary_text	灰阶/white	primary-text
主色 primary/color_primary_light	品牌色/red_1	primary-light-bg
主色 primary/color_primary_light_pressed	品牌色/red_2	primary-light-pressed
文本 Text/color_title	灰阶/gray_7	text/title
文本 Text/color_text	灰阶/gray_6	text/body
文本 Text/color_text_help	灰阶/gray_5	text/help
文本 Text/color_text_disabled	灰阶/gray_4	text/disabled
背景 Background/color_background	灰阶/gray_3	background/page
背景 Background/color_background_overlay	灰阶/gray_1	surface/overlay
背景 Background/color_background_component	灰阶/gray_2	surface/component
蒙层 Mask/color_mask	蒙层/mask_6	mask/block
蒙层 Mask/color_mask_part	蒙层/mask_5	mask/part
蒙层 Mask/color_mask_fault_toleran	蒙层/mask_1	mask/light
线 Line（颜色）/color_border	蒙层/mask_2	border/divider
服务 Service/color_service	服务金/servicegold_2	service
服务 Service/color_service_bground	服务金/servicegold_1	service-bg
服务 Service/color_service_text	服务金/servicegold_4	service-text
频道暗黑组件映射

来自用户手调案例“上下对比2”的最终口径：频道、强暗黑频道、金榜、真榜、O2O 榜单统一使用同一套深灰层级，不再默认使用纯黑页面底。先按组件语义定角色，再匹配 V16 token 或 fallback，不要只按色值最近邻。

组件/区域	日间常见色	暗黑目标	优先角色/token
页面根 / feed 外底 / 真正画布底	#f2f3f5 / #f5f6fa / #ffffff	#14171a	background/page
频道 icon 区 / 一级 Tab 外层行 / 内容区底座	#ffffff / #f7f8fa	#14171a 或 #1f2226	background/page；若处在头图视觉内先判断冻结
一级频道选中承托底，如 联集 34	#ffffff	#1f2226	surface/overlay；若真实 paint 在 Union/Vector 子层，必须下钻替换
一级频道左右装饰/背板路径	#d9d9d9 / #000000 / #408cff / 渐变	默认冻结或保留	frozen/head-visual；除非它是产品化选中承托底
一级频道选中/未选中文字	#ffffff / #ffffffe6	保持 #ffffff / #ffffffe6	head-ui-inverse；头图反显文字不转灰
二级 Tab 行整行背景	#ffffff	#1f2226	surface/row；不能残留可见白底；移除外描边
二级筛选 chip / 块状 Tab 未选中底 / 小方块容器	#f0f2f7 / #ebedf2 / #f2f4f7 / #ffffff	#2a2f36	background/component；Tab/chip 背景不加外描边
二级筛选选中弱红底	#ffe8ee / #fff2f4 / #ffebf1	#40262a	primary-light-bg
二级筛选选中文字/描边/icon	#ff0f23	#ff0f23	primary/brand
商品卡 / 店铺卡 / 榜单卡 / 普通白底容器	#ffffff	#1f2226	surface/card
商品图占位底 / 菜品图占位底	#ffdddd / 图片色 / #ffffff	保持原样	image/frozen；不要当作促销弱底或卡片底处理
标题 / 商品名 / 店铺名 / AI 评语正文	#11141a / #171a26	#e1e6eb	text/title
正文 / 参数 / 卖点 / 二级 Tab 未选中文字	#4f5259 / #666a73 / #828794	#a1a9b3	text/body
弱辅助 / 划线价 / 次级说明 / 起送距离	#8d9199 / #b4b8bf	#717985	text/help 或 text/disabled
价格 / 强促销 / 加购 +	#ff0f23 / #ff0400 / 京东红	保持红色	primary/brand
下单返 / 满减 / 到手价 / 加购弱底 / 浅粉促销底	#fff1f1 / #fff0f4 / #ffe8ee / #ffebf1	#40262a	primary-light-bg；前提是产品化 UI，不是图片内贴纸
分割线 / 卡片描边 / 弱蒙层线	#11141a14 / #00000014 / #ffffff80	#ffffff14 或 #ffffff1f	line/border/mask
服务/棕金标签底 / 上榜理由棕金底 / 榜单金弱底	#fff4e0 / #fff4e8	#3a2b1a	service-bg
服务/棕金标签文字与图标 / 标签内好评 / 买后说好 / 免费上门测量 / 金榜产品化标签文字	#80512d / #966530 / #966830 / #b5691a	#b38b6d	service/service-text；二级 Tab 文案如“好评榜”不按服务标签处理
服务/棕金标签分割线	#80512d / #ccb9ab	#b38b6d 或 #4d443d	service-line；优先低对比分割线 #4d443d
AI 品牌标识/评分/星星/专属描边	#7e17e6 / #cba2f5	保留 AI 紫或映射 AI token	AI brand；仅限明确 AI 品牌组件
普通内容中出现“AI”字样的标题/正文/卡片	#11141a / #ffffff / #f2f3f5	按普通背景和文本规则	不因名称含 AI 自动紫化
自营标	#ff3333 / #ffffff / 任意组合色	始终保持原样	frozen-label；全局冻结，除非用户明确点名只改自营标
秒送/商卡色块标签	#ffd939 / #665005 / #ffffff / 任意组合色	默认保持原样	frozen-label；除非用户明确要求产品化适配
顶部导航反白 / 头图白色 UI	#ffffff	保持 #ffffff	head-ui-inverse，冻结或保留
商品图、菜品图、运营头图、图片内贴纸	任意	保持原样	frozen，不参与映射

强制层级：页面底 #14171a；承托/Tab 行/卡片 #1f2226；chip/组件块 #2a2f36。页面底不得与卡片底同色；卡片底不得与 chip 同色；文字层级必须满足 title > body > help；AI 紫只用于品牌标识，不外溢到普通内容。

Tab 背景描边规则：一级/二级 Tab 行、块状 Tab、筛选 chip、小方块容器的背景层不需要外描边；如果日间或自动修复后出现 0.5px、约 7.84% 透明度的外描边，应在暗黑适配中移除。该规则只针对 Tab/chip 背景层，不影响卡片分割线、服务标签分割线和必要的内容边界线。

角色匹配硬规则

补绑必须先判断颜色角色，再进入色差匹配。禁止跨角色匹配。

颜色角色	允许 token 类别	禁止
页面/卡片/容器背景	background / surface / container / card	primary / brand / text
标题/正文/辅助文字	title / text / help / disabled	background / border
描边/分割线	border / divider / line	text / primary
品牌红/操作强调	primary / brand / action	background / surface
金色/榜单产品化标签	service / gold / rank 相关 token	运营视觉金色不绑
蒙层/遮罩	mask / overlay	text / primary
图标	icon / text / primary，按图标语义判断	background
AI 场景	默认按普通 V16 背景/文字/边框规则；仅明确 AI 品牌组件/AI 专属视觉才用 AI 色阶	仅因节点名或标题含 AI 就强行匹配 AI 紫色
匹配优先级
同角色 token 中 Light 值精确命中。
同角色 token 中 Light 值近似命中。
结合节点语义微调：TEXT 优先 text，容器优先 background/surface，stroke 优先 border。
多候选且置信度接近时，不自动绑定，列为“待设计师确认”。
产品化 UI 中非 V16 绑定不得默认保留，应先解绑，再按角色和 Light 色相似性重绑到 V16。
即使已绑定 V16，只要角色不对或暗黑视觉不符合目标层级，也不得跳过；应在副本中解绑并改为正确 token 或 fallback。
找不到同角色 token 时，允许 fallback 写 dark hex，但必须报告，不得冒充 token 绑定。
必须避免
白色背景不得绑定到 primary red 或 brand red。
黑色/灰色文字不得绑定到 background token。
低透明黑边框不得绑定到 text token。
运营头图里的金色、红色、白色不得按 UI token 逐层绑定。
商品图内的异形促销标签不得当作产品化标签处理。
