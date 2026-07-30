# API 手册

## 概述

Agent API 以 `/api` 为前缀。除健康检查与拓扑接口外，业务路由使用 Bearer JWT，并依据任务 `owner_user_id` 做资源隔离。

## 认证方式

使用 `Authorization: Bearer <token>`。认证失败返回 `401`；不属于当前用户的任务统一返回 `404`。

## 任务接口

### POST /api/tasks/plan
**描述:** 将用户输入转为候选计划，不执行 Tool 或 Skill。

**请求:** `{ "originalInput": "...", "conversationId": "optional" }`

### POST /api/tasks/:id/select
**描述:** 选择 `depth` 或 `speed` 候选，生成确认前计划和媒体需求。

### POST /api/tasks/:id/media
**描述:** 上传 JPEG、PNG、WebP 或 GIF 媒体资产。图片不经 JSON Base64 传输，落入对应任务工作区。

### POST /api/tasks/:id/execute
**描述:** 执行已确认任务并返回执行日志与报告。仅 `planned/awaiting_confirmation` 任务可被领取；媒体前置条件返回 `422`，任务冲突返回 `409`，外部依赖失败返回 `502/504`。

错误响应同时包含兼容字段 `error` 与稳定字段 `code`、`message`。`code` 可为 `TASK_STATE_CONFLICT`、`MISSING_REQUIRED_MEDIA`、`INVALID_MEDIA_REFERENCE`、`INVALID_MEDIA_INPUT`、`UPSTREAM_EXECUTION_FAILURE` 或 `UPSTREAM_EXECUTION_TIMEOUT`。

### POST /api/tasks/:id/execute/stream
**描述:** 以 SSE 推送步骤进度与最终执行结果。响应开始后的失败通过 `error` 事件发送与非流式接口等价的 `code`、`message` 和 `error`。

### POST /api/tasks/:id/resume
**描述:** 仅对 `paused/confirmed` 任务执行 `skip` 或 `abort`；其他状态返回 `409`。

### GET /api/tasks/:id/report.html
**描述:** 下载自包含 HTML 报告；旧任务只有 JSON 时实时渲染。

## 报告与反馈

### POST /api/tasks/:id/feedback
**描述:** 记录评分、是否采纳和可选评论。写入后不自动修改模型、prompt、Skill 或调度配置。

### GET /api/tasks/feedback/summary
**描述:** 返回当前认证用户拥有任务的反馈聚合。不会返回评论文本、其他用户任务或原始报告内容。

**响应:**
```json
{
  "feedback": {
    "feedbackCount": 12,
    "ratedCount": 10,
    "averageRating": 4.2,
    "adoptionResponseCount": 9,
    "adoptedCount": 7,
    "adoptionRate": 0.7777777777777778,
    "commentCount": 4,
    "commentsRedacted": true
  }
}
```

当没有评分或采纳回答时，对应平均值或采纳率为 `null`。`commentCount` 只表示存在评论的记录数，`commentsRedacted` 固定为 `true`。
