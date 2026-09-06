暗色模式切换
目标

快速、稳定地把副本根节点切到 Zero 右侧面板中的“暗色模式”，优先使用当前稿件已经存在的显式变量模式，不依赖远程库全量读取。

关键结论

Zero 面板里的 自动（日间模式）/ 日间模式 / 暗色模式 对应节点上的 explicitVariableModes。

已经手动切暗的样本节点可以作为 mode 来源：

const modes = sampleNode.explicitVariableModes


然后把这些 collectionId/modeId 复制到副本根节点：

const collection = await relay.variables.getVariableCollectionByIdAsync(collectionId)
copy.setExplicitVariableModeForCollection(collection, modeId)

已验证样本

来自用户手动切暗样本“矩形1111”：

样本节点：7:17986
关键暗色 modeId：712:7139
主要 collection：↘️ 色彩 Colors
色彩 collection 示例：7:11343
远程 key：2029484645871009793-12:2

已验证可设置的 collectionId：

7:11334
7:11336
7:11338
7:11341
7:11343
7:11351
7:11361
7:11377
7:15135
7:17374


注意：7:11350 在样本 explicitVariableModes 中出现，但在已测文件里只有日间模式，设置前必须检查 collection 是否包含目标 modeId。

推荐切换顺序
如果用户提供已手动切暗样本节点，直接读取其 explicitVariableModes。
如果当前文件中存在同类已切暗节点，读取该节点 explicitVariableModes。
如果没有样本，则从本文件 local variable collections 中找名称含 色彩 / Colors 且 modes 含 暗色模式 的 collection。
不要用 teamLibrary.getVariablesInLibraryCollectionAsync 作为主路径；它可能返回 0 或超时。
失败处理
找不到任何暗色 mode：停止，不进入猜测式全量改色。
某个 collection 不含暗色 mode：跳过该 collection 并报告。
设置模式后应立即截图或读取变量摘要，确认是否出现暗色值，例如 primary_light 从浅粉变为深粉棕。
