# Changelog

本文件记录项目的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循语义化版本。

## [Unreleased]

### 新增
- 建立 HelloAGENTS 项目知识库与“任务执行状态机加固与质量门”方案包。
- 增加执行状态机离线回归：必传媒体、并发领取、终态重试和 resume 前置状态。
- 增加 Node 原生 HTTP 集成测试、当前 owner 的反馈聚合 API，以及评分、采纳率和脱敏评论计数。
- 增加 `report:replay` 固定对比指标：证据引用率、无依据推断数、行动项验证覆盖率和生成模式。
- 增加 `npm run quality` 与 GitHub Actions 质量工作流；CI 使用临时 PostgreSQL、mock LLM 和 fake Tool adapter。
- 研究报告升级为需求驱动结构：`research-report` schema 新增 `method_summary`、`sub_questions`(问题→发现→分析→小结)、`overall_conclusion`,`findings` 全局证据池且每条带唯一 id(`^F[0-9]+$`)。
- validator 增加报告引用完整性校验:`sub_questions.finding_ids` 与 `analysis.based_on` 只能引用已存在的 finding id。
- 新增 `reportToMarkdown` 纯函数与共享 `SOURCE_LABEL`,Stage4Report 网页版式与导出 Markdown 同源;报告页支持一键导出与历史报告降级渲染。

### 变更
- 任务执行、恢复和终止改为 PostgreSQL 条件更新；未领取的请求不会调用外部能力。
- 媒体角色、数量、类型和任务归属在执行领取前校验，失败保持任务待确认状态。
- 执行 API 与 SSE 使用稳定错误码区分状态冲突、输入前置条件和上游故障；Web 客户端保留错误码。
- Express 应用构建与端口监听解耦，测试可注入确定性编排器；报告回放比较格式升级为 `1.1`。
- 测试文件改为串行执行，消除共享 PostgreSQL 日志写入对工具并发探针造成的非确定性。
- `npm run quality` 门前置 `typecheck`(root + web 两个 tsconfig 的 `tsc --noEmit`),从源头拦截类型漂移;并修复 tavily-adapter 测试中 `let` 闭包捕获导致的 `never` 收窄报错,root tsc 全量归零。
