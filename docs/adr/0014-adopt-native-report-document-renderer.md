# ADR-0014：采用结构化 Native ReportDocument 与确定性 Renderer

- 状态：Accepted，实施中
- 日期：2026-09-07
- 开发方案：`docs/plans/2026-09-07-reusable-native-report-renderer-and-unified-intake-development.md`
- 调整范围：ADR-0013 中由模型直接生成 Skill-defined HTML 的部分

## 背景

ADR-0013 已将新任务切换到原版 Skill Package Runtime，但 Skill-defined HTML 仍由模型同时生成内容、DOM、CSS 和图片引用。该方式会造成结构漂移、长输出截断、图片 Base64 膨胀，以及脚本清理后交互失效。

当前输入链同时存在普通字段、CSV 与图片，Markdown/TXT 尚无一等 Artifact；图片仍由 Web 先转换为 data URL 再提交确认。用户也可能在不同阶段反复补充相关材料。

## 决策

### 1. 保持单一 Native v1 路径

当前 Native 合同尚未形成需要兼容的独立发布面，因此直接调整现有 `native-skill-*-v1` 合同，不新建 v2 双轨，不迁移历史任务，也不增加 fallback。

### 2. 统一材料输入

Skill 输入支持：

```text
value
document
visual
dataset
```

Markdown/TXT、CSV 和图片先以 multipart 上传并封存为 Task/Plan 绑定的 Artifact；确认请求只提交 Artifact 引用。Base64 只允许在一次模型调用的内存对象中短暂存在。

### 3. 结构化报告

要求 HTML 报告的 Skill 返回 `native-report-document-v1`，由平台 Renderer 生成 HTML。首版只支持七类 Block：

```text
markdown
table
metric-group
image
quadrant
timeline
wireframe
```

Renderer 不理解行业知识，不调用模型，不补写结论，也不执行任意 HTML 或 JavaScript。

### 4. 输出方式

- 在线：HTML 引用 owner-bound Asset API；
- 浏览器展示：先经授权下载图片，再使用临时 Blob URL；
- 离线：从已封存 ReportDocument 和图片即时生成 ZIP；
- ZIP 不作为第二份内容真相源；
- Markdown Skill 继续走现有单页 Renderer。

### 5. 单一校验边界

- 上传边界验证文件类型、大小和内容编码；
- Artifact Store 验证状态、绑定和 Hash；
- ReportDocument Parser 验证结构以及 Source/Asset 引用；
- Renderer 信任已解析输入，只负责转义和呈现；
- 下载 API 只验证 owner。

不增加报告 Reviewer、模型自评、循环 Repair 或重复跨层校验。

## 结果

### 收益

- 用户在一个中文表单中提交普通字段和全部材料；
- 模型不再生成 CSS、JavaScript 或 Base64 图片；
- 同一 ReportDocument 可以稳定生成在线 HTML 和离线 ZIP；
- Renderer 失败时不重跑 Tool 或 Skill；
- 其他 Skill 可复用同一输入与报告能力；
- Industry 报告可以稳定呈现当前五个业务 Tab。

### 成本

- 需要新增 Document Artifact、ReportDocument Parser 和 Renderer；
- Skill-defined HTML 输出改为结构化输出；
- 当前本地旧 Native 任务不提供迁移或恢复兼容。

## 不变量

- 原版 Skill Package 保持只读；
- 业务内容和 PII 不被改写或阻断；
- 凭据继续隐藏；
- 报告只使用已提供材料和已验证来源；
- 图片不以本地路径或持久 Base64 存储；
- Renderer 中不得出现 Skill ID 特判；
- 新任务只有一个权威执行路径。

## 回滚

在合并前可回退本分支提交。合并后若出现阻断，停止创建新任务并修复当前 Native 路径；不重新启用模型直出 HTML 或 v1/v2 双轨。
