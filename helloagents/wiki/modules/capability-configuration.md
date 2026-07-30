# 能力配置与实验室

## 目的

以 YAML registry、Tool manifest、Skill manifest 和独立 Lab 服务声明可用能力及其输入输出契约。

## 模块概述

- **职责:** 决策图、Skill/Tool 注册、JSON Schema、adapter 类型、风险等级和外部实验室启动。
- **状态:** ✅稳定。
- **最后更新:** 2026-07-22

## 规范

### 需求: 配置驱动路由
**模块:** registry 与 loader

任务类型与能力匹配应通过 `domain`、`task_types`、`required_tools` 和 manifest 驱动，避免硬编码业务场景。

#### 场景: 新增 Skill
- 仅声明 active、领域、输入输出契约和依赖工具。
- registry lint 必须验证路径、状态和风险字段。

### 需求: 外部实验室保持边界
**模块:** external-tools

每个 `*-lab` 是独立运行单元，通过受控 REST adapter 或独立 UI 接入。

#### 场景: 实验室不可用
- 工具调用返回可识别失败或降级状态。
- 主编排器保留失败记录和报告限制，不将实验室源码或依赖并入核心运行时。
