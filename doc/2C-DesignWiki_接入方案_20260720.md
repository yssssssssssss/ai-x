# 2C-DesignWiki 接入方案(2026-07-20)

> **前提结论**:本次接入不是从零开始。项目实际接入进度远超预期——**A 类 KB 已完全同源导入、B 类 18 skill 已全部登记到 skill-registry**。真正的差距在「让接入生效跑起来」的最后一公里。
> 本方案基于对现状的实测,只做**必要的补齐 + 打通同步 + 端到端验证**,不做重复工作,不重构已跑通的通路。

---

## 0. 现状对齐(先算清楚接入到哪一步了)

### 0.1 已经做完的(勿重复)

| 层 | 现状 | 证据 |
|---|---|---|
| **A 类 KB 同源导入** | ✅ 全部完成 | `knowledge-base/methods=88 篇` vs 2C 源 88 篇一致;`models=22/22`、`assets=27/27` |
| **B 类 18 skill 目录导入** | ✅ 全部完成 | `knowledge-base/skills/<id>/SKILL.md` 与 2C 源 diff 一致(journey-map/generate-persona/synthesize/structure 抽样验证) |
| **skill-registry 登记 18 条** | ✅ 全部完成 | grep 计数 18/18 均 registry=1 |
| **每条 registry 有基础字段** | ✅ | `id / name / path / entry / when_to_use / owner / risk_level / task_types / status` 齐 |

### 0.2 真实缺口(本方案要补的)

| # | 差距 | 影响 | 优先级 |
|---|---|---|---|
| **G1** | 18 skill 全部**缺 `domain` 字段** | `planPhase` 段2c 按 domain 预筛能力池,缺失=用户研究 task_type 时无法命中激活,只能靠 task_types 兜底 | 🔴 P0 |
| **G2** | 18 skill 大多数**缺 `required_tools`** | LLM 编排步骤时无法知道要激活哪些 tool(尤其 `journey-map` 需 HTML 渲染、`generate-survey` 可能要接问卷平台) | 🔴 P0 |
| **G3** | `task_types` 覆盖窄 | 只挂 `user_research_planning` / `design_audit` 两个;真实 query(如"做一次转化漏斗分析"→conversion-funnel-analysis)可能不在这两类,被过滤 | 🟡 P1 |
| **G4** | KB 与 2C 源**无同步机制** | 2C 那边更新(status: draft → reviewed、新增方法、修 skill)时,项目 KB 是死副本会漂移 | 🟡 P1 |
| **G5** | **未做端到端验证** | 18 skill 从未在 orchestrator 里被真跑过(交接文档 4 份报告都是竞品/设计走查,非用研 skill) | 🔴 P0 |
| **G6** | `runStep` skill 分支 context 是否喂 A 类正典未知 | 若没喂,skill 运行时读不到 methods/models 正典→退化成 LLM 自由发挥,失去 wiki 编排价值 | 🔴 P0 |
| **G7** | 敏感级/授权护栏未落 | 全库 `sensitivity: internal` + `status: draft`,含京东真实业务样例(京喜流失等);运行时无检查 | 🟢 P2 |

---

## 1. Phase 1:补齐硬缺口(P0)

### 1.1 给 18 skill 加 `domain` 字段(G1)

**做什么**:每条 registry 条目补 `domain: [user_research]`(或更细分)。planPhase 段2c 的预筛逻辑:
```ts
const relevantSkills = allSkills.filter((s) => (s.domain ?? []).includes(task.task_type) || (s.domain ?? []).includes('cross_cutting'));
```
—— domain 字段能让用研 task_type 下这批 skill **默认命中**,不用等 task_types 兜底。

**具体映射**(直接抄进 registry):
```yaml
# 通用用研全领域(15 个)
domain: [user_research, cross_cutting]
# accessibility-review / design-audit 相关(3 个)
domain: [design_audit, user_research]
```

细分表:

| skill id | domain |
|---|---|
| generate-research-plan / generate-interview-guide / generate-survey / generate-usability-test / generate-persona | `[user_research, cross_cutting]` |
| synthesize-qualitative-insights / structure-interview-transcript / code-open-feedback | `[user_research]` |
| journey-map / jobs-to-be-done / competitive-analysis | `[user_research, cross_cutting]` |
| analyze-satisfaction / build-experience-metrics / conversion-funnel-analysis / feature-adoption-analysis / issue-prioritization | `[user_research]` |
| accessibility-review / run-heuristic-evaluation | `[design_audit, user_research]` |

### 1.2 补 `required_tools`(G2)

skill 是"编排不重造"的—— 大多数用研 skill **不需要外部 tool**,产出直接是文本交付物(访谈提纲/问卷/persona/洞察)。只有少数需要 tool 支撑:

| skill | required_tools | 原因 |
|---|---|---|
| `journey-map` | 无(自带 `scripts/render_journey_map.py`,当前项目不跑 python,产 HTML 由 LLM 生成) | 若要接 python 渲染需新增 `script` adapter |
| `competitive-analysis` | `[tavily-web-search, jd-product-search, joyspace-search]` | 竞品资料要网络采集 |
| `generate-survey` | 无(生成问卷题目,不投放) | — |
| **其他 15 个** | 无 | 纯 LLM+KB 编排 |

**决策**:P0 阶段只给 `competitive-analysis` 加 required_tools(现成三个已可用 tool);`journey-map` 的 HTML 渲染让 LLM 直出(不搞 python adapter,YAGNI)。

### 1.3 端到端跑一个 skill 验证(G5)

**选 `generate-interview-guide` 作为首验**:
- 输入门槛低(研究目的+目标用户)
- 无 tool 依赖(纯 KB 编排)
- 产出可肉眼判定质量
- 现有 registry 已登记

**验证脚本**:仿 `scripts/test-competitive-tavily.ts` 写一个 `scripts/test-user-research-interview.ts`:
```
1. POST /api/tasks/plan  query="给数字人竞品调研做一份用户访谈提纲,目标用户=直播运营/带货主播,3 个研究问题"
2. select depth 方案
3. POST /api/tasks/<id>/execute
4. 轮询 report.json,断言:
   - findings 引用 knowledge-base/methods/toolbox/collection/deep-interview*.md
   - 输出结构含"访谈提纲+题目+破冰+主问+追问+收尾"
   - 100% tool_result / skill_result 溯源(非纯 LLM 幻觉)
```

### 1.4 检查 `runStep` skill 分支的 KB 上下文注入(G6)

**先查**:orchestrator.ts 的 `runStep` skill 分支目前给 skill LLM 喂了什么 context。
- 若已包含 SKILL.md 全文 + user_materials → ✅ 够,skill 内部再靠 body 里的路径引导 LLM 读方法
- 若没包含 methods/models 目录索引 → skill LLM 不知有哪些方法可用,是最大隐患

**结论待验**(见 Phase 3):跑首验时用 execution_log 反查 skill 步骤 LLM 收到的实际 prompt,证据说话。

---

## 2. Phase 2:打通 KB 与 2C 源的同步(P1,G4)

### 2.1 现在是什么关系

`knowledge-base/` 是 2C 源的**深拷贝**(内容 diff 一致但独立存放),没有软链、没有同步脚本。2C 更新→项目死副本漂移。

### 2.2 三种方案对比

| 方案 | 复杂度 | 优点 | 缺点 |
|---|---|---|---|
| **A. 保持现状(纯拷贝)** | ⭐ | 简单,当前已可用 | 2C 更新要手动 rsync,长期漂移 |
| **B. `scripts/sync-2c-kb.mjs` 单向同步脚本** | ⭐⭐ | 明确、可回滚(git diff)、可加白名单过滤 | 需人工触发 |
| **C. symlink**(knowledge-base/ → references/2C-DesignWiki/.../user-research/) | ⭐ | 零复制、自动最新 | 打破当前目录结构、可能影响 test 的 fixture 路径、跨平台不友好 |

**建议**:方案 B。写一个 `scripts/sync-2c-kb.mjs`(约 40 行,rsync + git diff),按需运行。首次同步时用 `git diff --stat` 展示差异让人工确认。

### 2.3 sync 脚本契约

```
输入:无参
行为:rsync references/2C-DesignWiki/jd-design-system-md-v16/horizontal/user-research/{methods,models,assets,skills}/ → knowledge-base/{methods,models,assets,skills}/
后置:git diff --stat knowledge-base/ 输出到 stdout
不做:自动 commit(留给人肉判断)
```

---

## 3. Phase 3:验证与护栏(P0-P2)

### 3.1 首验产出物

- `scripts/test-user-research-interview.ts` 端到端脚本
- `doc/端到端真实评估报告_用研访谈提纲_20260720.md`(仿现有 4 份评估报告格式)

### 3.2 若首验暴露 G6(KB 上下文缺失),修法

在 `orchestrator.ts` 的 runStep skill 分支加一段"KB 索引注入":
```ts
// user_research 域 skill 运行时,自动附上 methods/models 索引给 LLM 参考
if (skill.domain?.includes('user_research')) {
  ctx.skillContext.kb_index = {
    methods: readFileSync('knowledge-base/methods/index.md', 'utf8'),
    models: readFileSync('knowledge-base/models/index.md', 'utf8'),
    assets: readFileSync('knowledge-base/assets/index.md', 'utf8'),
  };
}
```
这是**导航式召回**,不建向量库,符合 2C 那边的原始设计意图。

### 3.3 敏感级护栏(G7,P2 可后置)

`SKILL.md` 的 frontmatter 里已有 `sensitivity: internal`。运行时护栏:
- 报告标注"依据来源:知识库 status=draft,未评审,内部使用"
- `generate-persona`/`structure-interview-transcript` 的输入声明为 PII → 不落 DB artifacts,仅 in-memory 处理(SKILL.md 里已有该纪律,orchestrator 需尊重)

---

## 4. 落地清单(按顺序做)

| # | 动作 | 文件 | 预估 |
|---|---|---|---|
| 1 | 18 skill 补 `domain` 字段(§1.1) | `orchestrator/skill-registry.yaml` | 20 min |
| 2 | `competitive-analysis` 补 required_tools(§1.2) | 同上 | 5 min |
| 3 | 首验脚本 + KB 上下文调查 | `scripts/test-user-research-interview.ts` + 读 `orchestrator.ts` runStep | 45 min |
| 4 | 若 G6 暴露 → runStep 加 KB 索引注入(§3.2) | `apps/orchestrator-runtime/src/orchestrator.ts` | 30 min |
| 5 | 首验跑通 + 出评估报告 | `doc/端到端真实评估报告_用研访谈提纲_20260720.md` | 60 min(含 LLM 网关等待) |
| 6 | sync 脚本(§2.3) | `scripts/sync-2c-kb.mjs` | 15 min |
| 7 | commit + 更新交接文档 | — | 10 min |

**总预估**:~3 小时。首验成功即 18 个用研 skill 可对外声称"真实可用"。

---

## 5. 不做的事(YAGNI 边界)

| 不做 | 理由 |
|---|---|
| 建向量库/检索服务 | 导航式召回够用,2C 原设计意图也是导航;真需要时再上 |
| 为 journey-map 装 python renderer | LLM 直出 HTML 够用,加 script adapter 是额外通道 |
| 全面 evals 门禁 | M1.5 再做(交接文档已列),首验先证明能跑 |
| 把 v15 旧库 / 商详大脑 design-kb 也接进来 | 探查报告明确「不接」,避免与 v16 冲突 |
| 把整个 2C 仓的 24 个非用研 skill 挂进来 | 与用研 AI 无关,污染 registry |

---

## 6. 完成度对齐(方案落地后)

| 指标 | 现在 | 方案完成后 |
|---|---|---|
| A 类 KB 覆盖 | 137 篇已导 | 137 篇 + 同步机制 |
| B 类 skill 登记 | 18/18 | 18/18 + domain/required_tools 齐 |
| 真实可用 skill(端到端验证过) | 4 个(digital-human/design-review 等) | **≥ 5 个**(+ generate-interview-guide) |
| B 轴真实能力(交接文档口径) | ~88% | ~92% |

---

**下一步**:等你 confirm 本方案,我按落地清单 #1~#7 顺序做。全程直接执行、不再问回(persistence 生效)。
