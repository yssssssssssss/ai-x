# Industry Market Analysis Runtime Method

> 状态：approved
> 来源：对 Source Sync 中 `industry-market-analysis` draft 的运行时收敛；本文件是执行方法，不是业务事实源。

## 十维覆盖

A 宏观背景、B 用户洞察、C 供给侧、D 竞品与参考、E 京东内部诊断、F 机会与策略、G 设计落地、H 可衡量指标、I 方法与来源、J 商业与经营逻辑。

每个维度必须标记 `supported`、`partial` 或 `unavailable`。资料缺失进入 Data Gap，不能用常识或模型记忆补齐。

## 执行阶段

1. 确认品类、子类、排除范围、轻中重档、聚焦、读者、决策和时间范围。
2. 盘点用户提交材料、公开证据、Knowledge 和缺口。
3. 分析市场、用户、供给和竞品。
4. 使用截图与 Dataset 诊断京东现状；没有内部数据时只保留未知项。
5. 交叉验证事实、冲突和证据等级。
6. 形成 Gap、排他定位、机会和优先级。
7. 从平台继承与品类增量推导设计语言和品类差异资产。
8. 为 P0／重点短期机会形成“目标→现状→竞品→设计动作→资产→衡量”的策略纵深链。
9. 输出 typed draft，由 Runtime 确定性生成 Canonical 并 Final Review。

## 品类差异资产

核心家族：心智锚点、视觉基因、文案语气、玩法／交互基因、动效性格。允许加入证据支持的品类专属家族。每项记录适配度、理由、标杆证据、采集时间、复盘状态、平台继承和品类增量。

## 证据纪律

- `public_source`、`screenshot`、`dataset` 可以支持事实，但必须解析到 SEALED Artifact。
- `knowledge` 只支持方法和背景约束。
- `user_input` 未经证实时保持其用户声明身份。
- `simulation` 只支持假设。
- 所有未知基线和目标保持 null 或 unavailable。
