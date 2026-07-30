# 持久化与任务工作区

## 目的

将跨请求的任务状态、审计和产物引用保存在 PostgreSQL，并将大对象和媒体隔离在任务工作区。

## 模块概述

- **职责:** repository、迁移、CheckpointStore、RunWorkspace、媒体校验、产物落盘和恢复状态。
- **状态:** ✅稳定，执行领取由数据库条件更新约束。
- **最后更新:** 2026-07-22

## 规范

### 需求: 媒体任务隔离
**模块:** RunWorkspace

媒体必须属于当前任务，使用白名单 MIME、文件签名、最大体积和 SHA-256 验证。

#### 场景: 伪造 MIME 或跨任务 assetId
- 文件魔数与 Content-Type 不一致时拒绝。
- asset 不属于当前任务时拒绝，且不读取任意路径。

### 需求: 任务状态是单一真相源
**模块:** PostgreSQL

任务状态转换必须由条件更新约束，而不是由单个 API 进程的内存状态推断。

#### 场景: 多个请求同时启动任务
- 仅一个 `planned/awaiting_confirmation -> executing/confirmed` 条件更新命中。
- 未命中的请求不得写步骤日志、工具输出或报告文件。

#### 场景: 暂停任务恢复或终止
- `skip` 仅在 `paused/confirmed` 时条件迁移到 `executing/confirmed`。
- `abort` 仅在 `paused/confirmed` 时条件迁移到 `failed/confirmed`。

## 注意事项

`execution_log(task_id, step_no)` 的唯一约束用于审计去重，不能防止外部调用已经发生后的重复写入。
