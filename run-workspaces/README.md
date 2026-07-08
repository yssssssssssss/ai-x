# Run Workspace 约定

每个任务运行时都有一个逻辑工作区 `run-workspaces/{task_id}/`,是本次运行的中间文件真相源。
大对象与中间文件**不进 PostgreSQL**,只在此落盘;DB 的 `research_tasks.run_workspace_uri` 只存路径引用。

生产可映射到对象存储;本目录被 .gitignore 排除(仅保留本 README)。

## 结构

```
run-workspaces/{task_id}/
├── plan.json               # 段2 产出、用户确认过的执行计划(过 execution-plan.schema)
├── decision_states.json    # 本次激活的决策节点与状态
├── context_manifest.json   # 每次 LLM 调用的上下文清单与来源(可回放"为什么这条信息在上下文里")
├── tool_outputs/           # tool 原始输出或脱敏摘要
├── artifacts/              # 中间产物与最终产物(如 report.md)
└── failures.jsonl          # 失败记录,每行一条,用于回放与规则补强
```

## 关键约定

- **plan.json 是 HITL 闸门凭证**:段2 生成后停,`spike:execute` 读它才执行段3-4。
- **context_manifest.json 可回放**:记录 loaded_sources(每条含 type/ref/hash/reason)、model_name、prompt_hash。
- **failures.jsonl 不只留日志**:每条含 task_id/stage/selected_skill/selected_tool/input_ref/output_ref/error_type/context_manifest_ref。
