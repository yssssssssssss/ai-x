日间色重绑定到 V16 主路径
目标

在副本中先把非冻结产品化 UI 的日间色收敛到 JD V16 色彩体系，再切换暗黑模式。这样避免旧库绑定、业务库绑定或裸色在暗黑模式下不生效。

主流程
复制副本
→ 语义分区并冻结高风险区域
→ 巡检非冻结 product-ui 的日间色
→ V16 / 非 V16 / unbound 分类
→ 按角色 + Light 色相似度匹配 V16 token
→ 绑定 V16 token，无法绑定则记录 fallback 候选
→ 切换副本暗黑模式
→ 检查大面积浅底、文字对比、红/金语义、蒙层/描边
→ 必要时 fallback 修补

为什么先重绑再切暗

如果先切暗，旧库或非 V16 绑定不会跟随 V16 暗黑模式，容易留下大片白底。正确路径是：

日间色 → V16 light token → 绑定 token → 切暗色 mode → 自动解析 V16 dark token

可处理对象

只处理非冻结 product-ui：

页面背景、内容区背景。
卡片背景、普通容器。
标题、正文、辅助文案。
价格、促销红、按钮红。
分割线、描边、蒙层。
标准 Tab、标准筛选、普通按钮。
默认冻结对象

为保证速度和稳定性，以下默认冻结，不做 V16 重绑定：

顶部导航 / 顶导航 / NavBar / 状态栏。
频道头图、运营头图、banner、KV、主视觉。
商品图、品牌图、模特图、运营素材图。
商品图内非标准角标、贴纸、异形标签。
商卡上的色块标签。
自营标。
上榜理由标签。
复杂运营装饰区、未知切图区。

冻结的含义是：保持当前视觉，不做 token 绑定、不换色、不拆解。如果冻结区里有导航 UI 需要浅色可读，归为 head-ui-inverse，保持反白，不按白底风险处理。

分类规则

对每个候选 paint 分类：

分类	处理
V16 bound 且暗黑视觉正确	保留，切暗时自然生效
V16 bound 但角色/视觉错误	进入修复候选，在副本中解绑并重绑正确 token 或 fallback
non-V16 bound	进入重绑候选，不默认保留；必要时先解绑
unbound	进入重绑候选
frozen	跳过
unknown	跳过并报告

V16 判断优先使用 bound variable id/key 是否包含 2029484645871009793；不要为每个变量调用远程解析。但 V16 bound 只说明来源可能正确，不代表视觉正确；若节点语义和实际暗黑结果不符，仍需在副本中解绑并改为正确角色。

角色匹配

先判角色，再在同角色 V16 light tokens 中按相似度匹配。

角色	候选 token 类别
页面/卡片/容器背景	background / surface / container / card
标题/正文/辅助文字	title / text / help / disabled
描边/分割线	border / divider / line
品牌红/操作强调	primary / brand / action
金色/榜单产品化标签	service / gold / rank
蒙层/遮罩	mask / overlay

禁止跨角色。例如白色卡片背景不能匹配 primary red，即使色差算法误判。

相似度建议

候选池已由角色收窄后，再计算：

score = 色差 70% + 节点语义 20% + 面积/层级 10%

精确命中 Light hex：高置信度。
近似命中且角色明确：中置信度。
多个候选接近：低置信度，跳过或待设计师确认。
性能纪律
不在运行时全量读取组件库。
不对每个 paint 调用 getVariableByIdAsync。
优先读取本地 cache/v16-color-token-cache.json。
只扫描可见且非冻结子树。
优先处理大面积背景、TEXT、strokes。
单次脚本处理 paint 数建议不超过 150；超过则分批或报告剩余项。
脚本超时后缩小范围，不原样重试。
fallback

默认允许 fallback，但必须报告为 fallback-hex。

fallback 仅用于：

找不到可绑定 V16 变量 ID。
实例内部结构不适合绑定。
视觉角色明确，且 cache 中有可靠 dark 值。

fallback 不是 token-bound，不得冒充绑定完成。
