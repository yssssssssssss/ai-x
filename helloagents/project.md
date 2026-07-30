# 项目技术约定

## 技术栈

- **运行时:** Node.js 20+、TypeScript、`tsx`。
- **后端:** Express 5、PostgreSQL、AJV、JWT。
- **前端:** React、Vite、TypeScript。
- **运行时配置:** YAML registry、JSON Schema、Markdown 知识库与任务级 `run-workspaces`。

## 开发约定

- 编排和能力选择优先由 `orchestrator/*.yaml`、tool manifest、skill manifest 驱动，避免按业务类型写散落的条件分支。
- 用户输入、工具输出和 LLM 结果必须经过 schema 或受控投影后进入下游；工具事实、知识库、用户材料与 LLM 推断必须保留来源语义。
- 任务生命周期的权威状态存于数据库；大对象、中间产物和媒体存于任务工作区，数据库只保存引用和审计元数据。
- 执行必须先完成无副作用的输入校验，再以数据库条件更新领取；`execution_log` 唯一键只做审计，不能作为互斥锁。
- 代码改动必须保持 KISS：除非解决明确复杂度或重复问题，不新增共享包、队列、缓存层或抽象框架。

## 错误与日志

- HTTP 入口负责认证、归属校验、请求解析和错误码映射；领域判断放入编排器或 repository。
- 不记录密钥、完整用户材料、原始图片 Base64、完整提示词或未经脱敏的上游错误。
- 工具/Skill/报告调用需要记录可追溯的产物引用、schema 校验结果和模型元数据；日志不是执行互斥锁。

## 测试与流程

- 本地统一质量门为 `npm run quality`，依次执行 TypeScript、离线测试、registry lint、知识库 lint 与 Web 生产构建；集成测试共享 PostgreSQL，因此测试文件串行执行。CI 使用临时 PostgreSQL 先执行迁移，再运行同一命令。
- 确定性测试不得依赖真实网关、浏览器登录态或外部实验室；真实能力验证必须使用显式 smoke 命令和无敏感输入。
- 任何状态机、恢复、并发、权限或报告证据语义改动，都要有对应回归测试。
