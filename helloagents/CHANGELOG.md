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
- 新增金标批次真实闭环验证机制 `gold:run`:对金标场景连跑三次全真运行(强制 `LLM_PROVIDER=gateway` + `TOOL_ADAPTER=real`,不改 `.env`),按 ADR-0001 断言无审批步才自动确认、命中审批步即停,按 ADR-0002 固定全真边界;infra 失败可重试不占名额且透明留痕,能力失败计入批次。
- 新增批次审计包:`audit/gold-runs/<batch_id>/run-*/` 落裁剪后的报告 md/json、执行日志、模型元数据、来源核验矩阵与评审表单,批次根 `batch.md` 机器填客观计数、P0 通过结论留独立研究员;评审表单判定字段不可由模型代填。
- 增加金标机制离线自测:评审表单预填与留空、批次计数(infra 不占名额)、失败分类(网关 5xx/超时/限流 vs schema 不过)、审批闸门放行与拦停、审计包裁剪落盘。
- CONTEXT.md 增补验收术语(金标真实运行 / 批次审计包 / 基础设施失败 / 评审表单),并新增 ADR-0001(gold:run 自动确认闸门)、ADR-0002(坚持全真闭环边界)。
- 新增 Clean Cutover gate:机器校验 #29–#35 冻结、维护窗口停写、DB/workspace/audit 备份 SHA-256 inventory + restore check、migration 演练、只读 app smoke、non-gold workflow smoke、拒绝探针、go/no-go、首写前 rollback 与首写后 roll-forward lock,并封存 cutover checklist 防篡改。
- 新增 Cutover operator CLI:`pnpm cutover:prepare` 从 operator input 和本地备份文件生成 sealed cutover checklist,`pnpm cutover:verify` 校验 checklist hash 与嵌入证据,支持 staging 先演练再进入生产维护窗口。
- 新增本地专用 `cutover:rehearse` / `cutover:verify-rehearsal`:实际执行 loopback PostgreSQL dump/restore、workspace/audit archive restore 与 HTTP smoke,封存 `cutover-rehearsal-v1`;固定标记为 local、不可 go-live、非生产证据、非 Gold slot。

### 变更
- 任务执行、恢复和终止改为 PostgreSQL 条件更新；未领取的请求不会调用外部能力。
- 媒体角色、数量、类型和任务归属在执行领取前校验，失败保持任务待确认状态。
- 执行 API 与 SSE 使用稳定错误码区分状态冲突、输入前置条件和上游故障；Web 客户端保留错误码。
- Express 应用构建与端口监听解耦，测试可注入确定性编排器；报告回放比较格式升级为 `1.1`。
- Agent API 暴露 `createAgentApiApp()` composition root factory,端口监听仅在直接启动 `server.ts` 时发生,支持 cutover read-only smoke 验证旧 mutation=410 与旧 routes 不存在。
- 测试文件改为串行执行，消除共享 PostgreSQL 日志写入对工具并发探针造成的非确定性。
- `npm run quality` 门前置 `typecheck`(root + web 两个 tsconfig 的 `tsc --noEmit`),从源头拦截类型漂移;并修复 tavily-adapter 测试中 `let` 闭包捕获导致的 `never` 收窄报错,root tsc 全量归零。
