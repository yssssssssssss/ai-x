# 金标批次审计包(gold-runs)

`pnpm gold:run [batch_id]` 的输出目录。每个批次一个子目录 `<batch_id>/`,内含:

- `run-{1,2,3}/` —— 每次能力样本的裁剪审计包:
  - `report.json` / `report.md` —— 研究报告(若产出;paused 无报告则缺)
  - `plan.json` —— 选定的执行计划
  - `exec-log.json` —— 步骤执行日志(含 skipped 缺口步)
  - `model-meta.json` —— 模型名/版本/trace_id
  - `source-refs.json` —— 报告证据的来源清单(供逐条核验)
  - `review-form.md` —— 结构化评审表单(机器只填客观计数,判定留空)
- `batch.md` —— 批次汇总;P0 通过结论**由独立研究员填写**(AI 不得自评)。

## 为什么不入库

审计包是运行生成物(消耗真实 gateway token + Tavily 配额产生),与 `run-workspaces/` 同理不进 git。
独立研究员在本地完成人工评审(逐条来源核验 + P0 判定)后,按团队约定另行归档留档。

## infra 失败不占名额

网关 5xx/429/超时、网络故障、`core` 检索工具 fetch failed 等基础设施故障会重试、不消耗批次名额;
`optional`(增强)工具(如截图库 `ai-spider-search`)缺失则自动跳过成缺口,报告仍产出(见 tool-registry 的 `tier` 字段)。
