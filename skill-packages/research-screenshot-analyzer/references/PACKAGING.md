# 打包与入库建议

本文说明如何把 DesignPeek 从本地工具整理为 `user-research` 下的工具型 skill。

## 推荐名称

建议使用功能型名称：

```text
research-screenshot-analyzer
```

原因：

- 比 `designpeek` 更能说明能力边界：研究截图采集与分析。
- 便于 agent 通过语义触发。
- DesignPeek 可以继续作为工具品牌名写在正文中。

## 推荐入库目录

按照 `user-research/README.md` 的新增技能约定，入库目录为：

```text
jd-design-system-md-v16/horizontal/user-research/skills/research-screenshot-analyzer/
```

## 推荐文件结构

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
    API.md
    SETUP.md
    SECURITY.md
    PACKAGING.md
    EXAMPLES.md
```

如果 wiki 允许同时挂载工具源码，可额外放入：

```text
tool/
  server.py
  analyzer.py
  exporter.py
  config.py
  requirements.txt
  setup.sh
  start.sh
  .env.example
  static/
  shortcut/
```

## 不建议入库的内容

不要上传：

- `.env`
- 真实 API Key
- `screenshots/`
- `data/analysis.json`
- `data/projects.json`
- 未脱敏截图
- 个人分析报告
- 业务研究原始数据

## 当前入库方案

为了让团队成员能够从 wiki 直接获得工具，提交文档和经过安全检查的安装包，不提交个人运行数据：

1. `SKILL.md`：主入口，说明触发条件、输入输出、工作流、安全边界。
2. `README.md`：提供能力概览和安装包入口。
3. `downloads/designpeek-v0.1.zip`：通过 `make_package.sh` 生成的安全安装包。
4. `references/API.md`：说明当前 HTTP API。
5. `references/SETUP.md`：说明本地安装和启动。
6. `references/SECURITY.md`：说明隐私和分发红线。
7. `references/EXAMPLES.md`：提供调用示例。
8. `references/PACKAGING.md`：说明入库和后续打包方案。

## 如需同步源码

如果团队希望 wiki 同时托管工具源码，建议先整理为一个干净分发包：

- 保留源码、静态前端、安装脚本和 `.env.example`。
- 排除 `.env`、截图、项目分析数据和缓存。
- 使用白名单打包。
- 打包前人工检查 zip 内文件列表。

当前 DesignPeek 已有 `make_package.sh`，采用白名单方式打包，是推荐方向。

## 后续规划（当前未实现）

以下内容均为 V0.1 之后的规划，不代表当前已经具备。

### 第一阶段：文档入库

- 固定 skill 名称。
- 固定目录结构。
- 补齐安全说明和 API 示例。

### 第二阶段：接口稳定

- 增加 `GET /api/health`。
- 增加 `GET /api/schema` 或 OpenAPI。
- 固定单图分析和项目分析 JSON schema。
- 支持 HTML / Markdown / JSON 三种导出。

### 第三阶段：工具分发

- 增加 CLI。
- 支持异步任务。
- 将 prompt 抽离到 `prompts/`。
- 整理为标准 Python package。

### 第四阶段：团队集成

- 接入团队模型网关。
- 接入 design wiki 发布流程。
- 接入设计资产库或截图素材库。
- 提供稳定的结构化输入输出，便于后续流程调用。

## 推荐列表页摘要

在 `user-research/skills/index.md` 中登记：

```text
Research Screenshot Analyzer `research-screenshot-analyzer/`：基于 DesignPeek 的本地截图采集与 AI 视觉分析工具，支持竞品/App 截图上传、整理、单图 UI 识别、项目级跨平台对比和 HTML 报告导出。适用于改版前竞品调研、设计模块拆解、截图证据沉淀和 AI/脚本调用。
```
