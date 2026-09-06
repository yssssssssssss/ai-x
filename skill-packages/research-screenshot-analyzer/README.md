# Research Screenshot Analyzer

Research Screenshot Analyzer 是一个面向设计用研任务的截图采集与 AI 视觉分析能力包，当前由本地工具 DesignPeek / 设计透视承载。

## 版本信息

- 当前版本：V0.1
- 发布日期：2026-07-15
- 维护人：李艺
- 问题反馈：李艺（ERP：liyi285）

## 下载与安装

[下载 DesignPeek V0.1 安装包](downloads/designpeek-v0.1.zip)

下载后解压安装包，并按照 [安装与启动说明](references/SETUP.md) 完成依赖安装、AI Key 配置和首次启动。安装包不包含真实 Key、用户截图或个人分析数据。

在 2C Design Wiki 中的入库位置：

```text
jd-design-system-md-v16/
  horizontal/
    user-research/
      skills/
        research-screenshot-analyzer/
```

## 能力边界

本 skill 负责：

- 采集 App / 竞品 / 设计走查截图。
- 整理截图素材，按 App、页面、模块或研究项目归档。
- 对单张截图做 AI 视觉识别，提取页面类型、UI 组件、视觉风格、布局和交互特征。
- 对一组截图做模块归类和跨平台对比。
- 导出截图分析报告，作为后续竞品分析、设计走查或 wiki 沉淀的证据材料。

本 skill 不负责：

- 判断竞品战略意图。
- 决定我方是否跟进竞品功能。
- 替代正式用研结论。
- 分析未脱敏业务数据或用户隐私截图。

## 何时调用

当一个用研任务进入「采集分析工具到位吗？」这个决策问题时，如果需要收集、整理、识别和导出截图素材，可以调用本 skill。

典型触发语：

- 我要整理一批竞品截图。
- 帮我把这些 App 页面截图按模块归类。
- 我想做一个截图对比看板。
- 这些截图能不能先做 AI 视觉识别？
- 这次设计走查的截图需要归档并导出报告。

## 文件结构

```text
research-screenshot-analyzer/
  SKILL.md
  README.md
  downloads/
    designpeek-v0.1.zip
  examples/
    good/
    bad/
  anti-patterns.md
  references/
```

当前 `references/` 中包含 API、安装、安全、打包和调用示例说明。
