# 用研 AI 编排平台

> 本知识库基于 2026-07-22 的代码扫描建立；运行时行为以代码和 schema 为准。详细模块说明见 `modules/`。

## 1. 项目概述

### 目标与背景

系统将用户研究需求解析为结构化任务，基于决策图、技能与工具 registry 生成可选计划，在用户确认后执行工具和 Skill，并交付带证据边界的研究报告。

### 范围

- **范围内:** 需求理解、任务编排、Tool/Skill 调用、知识检索、媒体输入、断点恢复、证据台账、报告 JSON/HTML、任务历史与反馈。
- **范围外:** 以外部实验室实现替代主编排器；将模拟用户或启发式结论标记为真实事实；无确认地执行高风险外部操作。

## 2. 模块索引

| 模块 | 职责 | 状态 | 文档 |
|---|---|---|---|
| 编排运行时 | 计划、执行、恢复、报告合成 | ✅稳定 | [orchestration-runtime](modules/orchestration-runtime.md) |
| Agent API | JWT、任务与媒体 HTTP/SSE 入口 | 🚧开发中 | [agent-api](modules/agent-api.md) |
| Web 工作台 | 计划选择、执行进度、报告与任务历史 | ✅稳定 | [web](modules/web.md) |
| 持久化与工作区 | PostgreSQL 审计、任务媒体和产物 | ✅稳定 | [persistence-and-workspace](modules/persistence-and-workspace.md) |
| 能力配置与实验室 | registry、manifest、独立 Labs | ✅稳定 | [capability-configuration](modules/capability-configuration.md) |
| 知识与报告质量 | 知识索引、证据台账、报告回放与反馈 | 🚧开发中 | [knowledge-and-reporting](modules/knowledge-and-reporting.md) |

## 3. 快速链接

- [技术约定](../project.md)
- [架构设计](arch.md)
- [API 手册](api.md)
- [数据模型](data.md)
- [当前状态机加固方案](../plan/202607222226_execution-state-hardening/why.md)
