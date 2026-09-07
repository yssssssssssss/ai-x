# 真实 LLM 功能开发与校准流程

> 来源：2026-09-01 双报告集与 Editorial Summary 开发复盘
> 适用范围：调用真实 LLM、生成长文本／HTML、包含 Fidelity Review 或模型修订环节的功能
> 目标：把真实模型调用用于最终校准，而不是代替本地合同设计和自动化测试

## 1. 本次经验结论

本轮开发持续约 4 小时，其中真实模型调用累计 121.1 分钟，是最大的耗时来源。

```text
真实模型调用：84 次
模型累计等待：121.1 分钟
```

调用分布：

| 阶段 | 调用数 | 累计耗时 | 平均耗时 |
|---|---:|---:|---:|
| Editorial Plan 成功 | 28 | 29.1 分钟 | 62.4 秒 |
| Editorial Plan 失败 | 2 | 0.5 分钟 | 15.9 秒 |
| Full HTML 成功 | 24 | 51.5 分钟 | 128.6 秒 |
| Full HTML 失败 | 2 | 5.1 分钟 | 152.3 秒 |
| Targeted Repair 成功 | 11 | 28.3 分钟 | 154.5 秒 |
| Fidelity Review 成功 | 17 | 6.6 分钟 | 23.3 秒 |

主要教训：

> 应先在本地冻结输入、输出、诊断、缓存和失败合同，再使用真实 LLM 校准内容质量。

真实模型调用不能替代：

- 公共 Interface 设计。
- Schema 和 Source Binding。
- 确定性安全检查。
- Fixture 测试。
- 错误分类。
- 缓存身份设计。

## 2. 本轮最耗时的原因

### 2.1 真实冒烟开始过早

在以下合同尚未稳定时就开始了真实生成：

- Atom ID 与 Unit ID 的引用规则。
- `data-source-ids` 的分隔格式。
- requested artifact 的语义覆盖范围。
- HTML 安全边界。
- Fidelity Issue 的 Section ID 规则。
- Model Pool 与单模型固定策略。
- 失败候选的诊断信息。

结果是每修正一个本地合同，就需要重新生成完整 HTML。

### 2.2 错误信息最初过于粗糙

初期只返回：

```text
SUMMARY_HTML_INVALID
```

无法区分：

```text
doctype_missing
language_mismatch
source_binding_unknown
requested_artifact_missing
priority_zero_missing
source_external_url
remote_or_unsafe_runtime
```

为了确认失败方向，不得不再次调用真实模型。

### 2.3 Prompt 和 Request Key 多次变化

每次 Prompt、Source 或模型路由发生变化，正确行为都是生成新的 Request Key，旧缓存不能复用。

本轮在校准期间多次修改：

- Plan Prompt。
- HTML Prompt。
- Repair Prompt。
- Source Coverage。
- 模型路由身份。

这些修改是正确的缓存隔离行为，但发生得过于零散，导致重复生成。

### 2.4 错把模型输出习惯当成内容错误

真实模型自然使用 Semantic Atom ID，而第一版 Validator 只接受底层 Unit ID；模型也可能使用：

- 逗号分隔 ID。
- 重复前缀，如 `esa_esa_...`。
- HTML Section ID 而不是 Plan Section ID。

这些属于可安全规范化的展示元数据，不应该触发完整报告重跑。

### 2.5 模型路由策略中途改变

曾尝试让所有阶段固定使用 GPT-5.5，以保持编辑一致性，但这放大了 429 限流和单点失败。

最终采用项目已有 Model Pool：

- 每次调用仍校验实际模型身份。
- 每次调用保存独立 Receipt。
- 单个模型限流时允许 Gateway 选择已声明的备用路由。
- Publication Manifest 记录每个阶段的实际模型。

模型路由策略应在第一次真实调用前确定，不能在校准中反复切换。

### 2.6 开发服务器自动触发生成

浏览器保持打开时，热重载会重新挂载 Summary View，并可能自动发起新的生成请求。API 进程重启还可能中断正在进行的模型调用，留下请求锁。

最终增加了：

- Request Key 幂等。
- 浏览器侧 Promise 缓存。
- owner PID 锁记录。
- 孤儿锁回收。

## 3. 标准开发顺序

以后涉及真实 LLM 的功能，默认采用以下顺序。

```text
需求与真相源确认
→ Public Interface 与测试 Seam
→ Fixture Red／Green
→ 诊断合同
→ 缓存与版本合同
→ 本地全量测试
→ 一次真实单路径冒烟
→ 一次问题归因与批量修正
→ 一次真实第二路径冒烟
→ 全量质量门禁
```

不得跳过前四步直接反复调整 Prompt。

## 4. Phase 0：确认目标和真相源

开始编码前必须回答：

1. 哪个 Artifact 是唯一事实源？
2. LLM 可以概括什么？
3. LLM 不能改变什么？
4. 失败是否影响主交付物？
5. 输出是正式交付、派生展示还是实验产物？
6. 当前需求是否允许模型直接生成 HTML／代码？

对于双报告集：

```text
Canonical Deliverable：唯一事实源
Detail Report：完整投影
Summary Report：可概括的派生展示
```

摘要失败不得损坏或替代完整报告。

## 5. Phase 1：先冻结 Public Interface 和测试 Seam

在调用真实模型之前，先确定测试 Seam。

推荐至少包含：

- Source Builder：Reviewed Canonical → Model Source。
- Generator：Source → Plan／HTML／Fidelity。
- Pipeline：Task ID → Immutable Publication。
- Store：Publish／Read／Tamper Rejection。
- Owner-bound HTTP Route。
- Web Summary／Detail 双视图。

测试应通过这些 Interface 验证行为，不检查内部私有函数。

## 6. Phase 2：Fixture 先行

真实调用前，Fixture 必须覆盖：

### 6.1 Source

- 全部 active Deliverable 可以建立 Source。
- 每个 Canonical Unit 都能追溯到 Semantic Atom。
- 完全重复内容可以合并，但来源 ID 不能丢失。
- Requirement、Evidence、Review 和语言正确冻结。
- PII／confidential 输入不能进入模型路径。

### 6.2 HTML

- 完整 HTML 文档。
- 正确语言。
- Source ID 与 Detail Anchor 合法。
- required question、requested artifact、P0 和 Risk 覆盖。
- 不新增 Evidence 之外的 URL。
- 不允许远程资源、表单、iframe、危险 URL 或内联事件属性。

### 6.3 Fidelity

- `pass` 必须没有 Issue。
- `revise` 必须有可执行 Issue。
- Issue 的 Source ID 可以安全规范化。
- 最多一次定向修订。
- 修订失败不得追加兜底式完整底稿。

### 6.4 Store

- 原子发布。
- `0700／0600` 权限。
- Request Key 幂等。
- 读取时重新执行确定性 HTML 校验。
- 拒绝新增文件、hash 篡改和 binding 漂移。
- 能回收已退出进程留下的孤儿锁。

## 7. Phase 3：诊断优先

第一次真实调用前，所有可预见错误必须有稳定原因码。

错误至少区分：

```text
模型／网络失败
Schema 失败
HTML 结构失败
Source Binding 失败
Coverage 失败
Fidelity 失败
Store Integrity 失败
Source Current Fence 失败
```

原则：

- 错误原因必须足以决定下一步动作。
- 不把敏感内容放入错误消息。
- 可以记录缺失 ID 或 Issue Code。
- 不仅返回笼统的 `generation_failed` 给内部诊断。
- 面向用户的 HTTP 响应仍保持简洁和脱敏。

如果连续两次真实运行出现同一个模糊错误，停止重跑，先补诊断。

## 8. Phase 4：冻结 Prompt、Source 和缓存身份

第一次真实调用前完成：

- Prompt 文本审查。
- Prompt Injection 边界。
- Source Bundle 字节上限。
- 模型路由策略。
- Request Key 输入。
- Prompt Version。
- Store Version。

每次 Prompt 语义改变必须更新 Prompt Version。

不要在以下情况下更新版本：

- 只修改测试。
- 只修改注释。
- 只增加不改变最终字节的诊断。

真实调用前集中完成一批 Prompt 修改，避免每个小调整都使缓存失效。

## 9. Phase 5：第一次真实冒烟

第一次只选择一个已完成、证据充分、问题结构清楚的任务。

运行前检查：

- Fixture 测试通过。
- Typecheck 通过。
- 没有打开会自动触发同一 Summary 的浏览器页面。
- 没有残留请求锁。
- Prompt Version 已冻结。
- 当前运行只有一个明确验证假设。

记录：

- Task／Plan／Attempt。
- Request Key。
- Publication ID。
- 每阶段模型和 Trace ID。
- 调用耗时。
- Coverage。
- Fidelity。
- HTML Hash。
- 1440px 渲染指标。

## 10. 一次失败后的处理顺序

### 10.1 Provider 失败

包括：

- 429。
- 网络失败。
- Gateway 5xx。
- Timeout。

处理：

- 不修改业务代码。
- 确认 Receipt 和 retryable 状态。
- 使用既定 Model Pool 或等待后重试。
- 不因为基础设施失败放宽内容或 Fidelity 门禁。

### 10.2 合同失败

包括：

- 无效 ID。
- 缺失字段。
- HTML 非完整文档。
- 未知 URL。
- 覆盖缺口。

处理：

1. 判断能否确定性规范化元数据。
2. 能规范化时只处理 ID 分隔、重复前缀等不改变内容的表示问题。
3. 需要内容变更时使用一次定向修订。
4. 不追加通用兜底附件。

### 10.3 Fidelity 失败

处理：

- 保留详细报告。
- 仅修订被指出的章节。
- 修订后重新 Review。
- 第二次仍未通过则 Summary 失败。
- 不通过降低 Reviewer 标准制造成功。

## 11. 真实调用纪律

每次真实调用前必须写明：

```text
本次调用要验证什么？
与上一次相比，Source／Prompt／代码改变了什么？
如果失败，哪个诊断结果会指导下一步？
```

如果三项都回答不了，不应发起调用。

同一个 Candidate 不因“也许下一次更好”而连续盲目重跑。只有以下情况允许重试：

- 明确的 retryable Provider 失败。
- Source／Prompt／Validator 已发生有依据的改变。
- Reviewer Issue 已转化为定向修订输入。

## 12. 浏览器与开发进程纪律

真实校准时：

- 关闭会自动加载目标 Task 的浏览器页面，或切换到其他 Task。
- 避免在模型调用期间修改会触发 API 热重载的文件。
- QA 截图保存到独立 QA 目录，不能写入不可变 Publication 目录。
- 生成结束后检查请求锁是否释放。
- 缓存重读必须不再产生模型调用。

## 13. 推荐验收矩阵

### 本地自动化

```text
6 active Deliverable × 2 Orchestration Mode
```

Fixture 负责验证合同和通用性，不声称模型质量。

### 真实验收

至少：

- 一个真实单 Skill Task。
- 一个真实多 Skill Task。
- 两者均使用真实 Gateway。
- 两者均有真实 Evidence。
- 多 Skill Task 保留 Contribution 和 Review Sidecar。

真实验收通过后再运行全量 Quality，避免每个小修改后重复跑全仓门禁。

## 14. 推荐时间预算

对于已有基础设施上的同类能力：

| 阶段 | 推荐预算 |
|---|---:|
| Codebase 定位与 Interface 确认 | 15～25 分钟 |
| Fixture Red／Green | 40～60 分钟 |
| API／Web 集成 | 20～30 分钟 |
| 真实单 Skill + 多 Skill | 15～30 分钟 |
| 全量门禁与文档 | 15～25 分钟 |

合理目标：

```text
总开发时间：约 2～2.5 小时
单份稳定 Summary：约 3～8 分钟
```

若真实模型等待超过总时间的一半，应暂停并检查是否在用真实调用代替本地诊断。

## 15. 完成检查单

- [ ] 真相源和派生关系已明确。
- [ ] Public Interface 和测试 Seam 已确认。
- [ ] Fixture 已覆盖成功、失败和修订路径。
- [ ] 错误原因可以直接指导下一步。
- [ ] Prompt／Source／Model Routing 已冻结。
- [ ] Request Key 包含所有生成身份。
- [ ] 第一次真实运行只验证一个假设。
- [ ] 未在每个小修改后重跑真实任务。
- [ ] Provider 失败和内容失败没有混淆。
- [ ] Summary 失败不影响 Detail。
- [ ] 单／多 Skill 真实任务均通过。
- [ ] 1440×900 无横向溢出。
- [ ] QA 产物没有写入不可变 Publication 目录。
- [ ] 缓存重读不产生新模型调用。
- [ ] 全量 Quality 最后统一运行。
- [ ] 未经授权未 stage、commit、merge、push 或部署。
