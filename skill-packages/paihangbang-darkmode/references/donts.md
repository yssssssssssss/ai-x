禁止项
不要修改原稿

原画板只读。不得重命名、移动、改色、拆实例、删除或覆盖原画板。

不要全量猜色
不要一开始逐色扫描全树。
不要一开始读完整远程变量库。
不要对每个 paint 调用 getVariableByIdAsync。
不要在远程变量接口超时后原样重试。
不要跨角色匹配
白色背景不得绑定 primary/brand。
文字不得绑定 background。
边框不得绑定 text。
低透明描边不得绑定正文色。
运营金色不得绑定 service/gold UI token。
不要误改切图区域
商品图不反色。
logo 不反色。
运营 banner、频道头图、主视觉不拆解。
商品图左上角非标准形状标签冻结。
不要让修复不可见

风险节点一旦决定修复，目标颜色必须在视觉上生效。不要把新颜色写在旧渐变、旧 fill 或旧多层背景下面。应直接替换目标属性的 fills/strokes 数组，或确保新 paint 在最上层。如果父 Frame/Instance 改色不生效，必须向下钻取到 Union/Vector/Rectangle/BooleanOperation 等实际绘制子层。

不要把 fallback 冒充 token 绑定

允许 fallback 写 dark hex，但必须报告为 fallback-hex，说明原因、范围、数量和来源。

不要删除失败副本

如果已创建副本但后续失败，保留副本并报告状态。删除必须通过 AskUserQuestion 弹窗二次确认。
