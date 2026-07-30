# 数据模型

## 概述

数据库保存任务、会话、审批状态、执行审计、产物引用和用户反馈；任务工作区保存计划、媒体、上下文清单、工具输出和报告文件。

## 核心表

| 表 | 作用 | 关键字段 |
|---|---|---|
| `users` | 平台用户 | `id`、`email`、`password_hash`、`role` |
| `conversations` | 用户会话 | `owner_user_id`、`title`、`status` |
| `research_tasks` | 任务生命周期真相源 | `owner_user_id`、`structured_task`、`status`、`approval_state`、`run_workspace_uri` |
| `task_decision_states` | 决策节点判定 | `task_id`、`node_key`、`state`、`reason` |
| `execution_log` | 步骤审计 | `task_id`、`step_no`、`status`、`output_ref`、模型与 manifest 元数据 |
| `artifacts` | 计划、报告和文件引用 | `task_id`、`artifact_type`、`storage_uri` |
| `user_feedback` | 用户评分与采纳记录 | `task_id`、`user_id`、`rating`、`adopted`、`comment` |

## 反馈聚合边界

反馈汇总不新增表。repository 通过 `user_feedback.task_id -> research_tasks.id` 按 `research_tasks.owner_user_id` 聚合评分、采纳和评论数量。评论正文仅保存在 `user_feedback`，聚合 API 和报告回放均不读取或返回该文本。

## 任务工作区

每个任务在 `run-workspaces/<task-id>/` 下拥有隔离目录：

- `plan_candidates.json` 与 `plan.json`：候选和最终执行计划。
- `media/`：带 hash 的任务媒体与资产索引。
- `tool_outputs/`：单步结构化输出。
- `context_manifests/`：每次模型调用的受控上下文清单。
- `artifacts/`：`evidence-ledger.json`、`report.json`、`report.html`。
- `run_state.json` 与 `failures.jsonl`：暂停恢复和失败诊断。

## 状态约定

任务的 `status` 与 `approval_state` 共同描述生命周期。`execution_log` 的唯一键防止同一步出现多行，但不能替代任务领取互斥；执行入口通过条件更新保证只有一个实际执行者。

| 当前状态 / 审批状态 | 操作 | 目标状态 / 审批状态 |
|---|---|---|
| `planned / awaiting_confirmation` | execute 领取 | `executing / confirmed` |
| `executing / confirmed` | 步骤失败 | `paused / confirmed` |
| `paused / confirmed` | resume skip 领取 | `executing / confirmed` |
| `paused / confirmed` | resume abort | `failed / confirmed` |
| `executing / confirmed` | 报告完成 | `completed / confirmed` 或 `completed_with_gaps / confirmed` |
