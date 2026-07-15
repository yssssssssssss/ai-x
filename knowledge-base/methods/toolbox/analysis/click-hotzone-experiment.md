---
title: 控件热区点击实验
type: analysis
domain:
  - 通用
research_type:
  - 定量
  - 评估
tags:
  - 点击准确率
  - 控件热区
  - 费茨定律
  - 实验
  - 触控尺寸
status: draft
sensitivity: internal
owner: 吴佳毅
updated: 2026-06-24
related:
  - methods/toolbox/collection/usability-testing.md
  - methods/toolbox/collection/eye-tracking.md
id: toolbox_analysis_click_hotzone_experiment
source: xingyun_wiki
source_path: methods/toolbox/analysis/click-hotzone-experiment.md
content_hash: sha256:42fa3bb9051edeb21fc19b6da0f87f7be4c4b996fc40669929804cda04726a6c
guide_tags: []
guide_stage:
  - method-selection
---

# 控件热区点击实验

> 来源：神灯圈子·吴佳毅《控件热区怎样设计点击准确率最高？》 原文 http://xingyun.jd.com/shendeng/article/detail/45605

> 一句话：用点击行为心理学实验，确定移动端控件「点击热区（可点击区域）」的最佳尺寸与位置，使小尺寸控件的点击准确率最高。
> 落点：`methods/toolbox/analysis/`。判据——这套「设置自变量→线上点击实验→提炼尺寸/位置设计原则」的手段可脱离单次研究复用于任何触控控件的热区评估。

## 何时用
- 适合的问题类型：
  - 用户反馈某控件「点不准 / 点不中」，需量化判断热区是否过小。
  - 需要为某类控件给出可落地的最短边长/位置设计建议（如关键按钮、信息录入、导航、引导提示关闭按钮等）。
  - 需评估同一控件在不同屏幕尺寸（小/中/大屏）上的点击体验差异。
- 与近似技术的区别：
  - 区别于可用性测试（任务级、定性为主）——本实验聚焦单一交互维度（点击命中），用大样本线上实验量化「热区大小 / 屏幕位置」两个自变量对准确率与舒适度的影响。
  - 理论根源 ⚠️待补充(缺源)：原文未点名理论依据；实验结论方向与费茨定律一致，可考证后链 `models/fitts-law.md`。

## 输入数据要求
- 实验自变量（原文设置 2 个）：
  1. 热区大小（如 17dp×17dp、24dp×24dp、36dp×36dp、40dp×40dp、44dp×44dp 等多档方块）；
  2. 热区在屏幕上的位置（按 9 宫格布点）。
- 每次点击的因变量记录：成功 / 失败（用于算点击准确率）、点击用时、主观点击舒适度（7 分制评分）。
- 设备分层：覆盖小屏（6.1 英寸）、中屏（6.5 英寸）、大屏（6.7 英寸）三类手机。
- 样本量：本次线上实验共 1200 名用户完成。
- 任务形态：屏幕上随机出现不同大小的热区色块（每次仅出现 1 个），用户依次点击。

## 分析步骤
1. **提出假设**：
   - 假设1：热区越大，点击准确率越高、点击用时越短；
   - 假设2：热区出现位置影响点击效率，同一大小热区在屏幕不同区域准确率会有差异。
2. **设计自变量与因变量**：设定「热区大小」「热区屏幕位置」两个自变量，逐次单色块呈现，记录成功/失败、用时、舒适度。
3. **分屏幕尺寸统计点击准确率与舒适度**：分别在 6.1 / 6.5 / 6.7 英寸设备上汇总各尺寸热区的准确率与舒适度。
4. **拟合尺寸—准确率趋势**：观察准确率随热区增大的变化形态（先快后慢）。
5. **做差异显著性检验**：对热区大小与舒适度、屏幕分区准确率、不同屏幕尺寸舒适度等做显著性检验（原文报告 P 值，见结果解读）。
6. **9 宫格 → 三分区位置分析**：将 9 宫格按左/中/右均匀合并为 3 块区域，比较各区准确率，并结合用户利手分布解释成因。
7. **提炼设计原则并落到控件类型**：把统计结论转写为可执行的最短边长 / 位置 / 屏幕缩放建议。

## 结果解读
- **尺寸—准确率（原则1 支撑数据，综合小/中/大屏）**：热区越大准确率越高，呈「先快后慢」趋势。
  - 24dp×24dp 时，点击准确率接近 80%；
  - 36dp×36dp 时，点击准确率高于 90%；
  - 44dp×44dp 时，点击准确率大于 95%。
- **尺寸—舒适度**：热区大小显著影响点击舒适度（*P<0.01*）；随热区增大舒适度显著提升，36dp×36dp 时舒适度升至 6 分（满分 7 分）。
- **位置**：6.1 / 6.5 / 6.7 英寸设备上点击准确率基本呈「自左向右递增」；将屏幕三分后，区域3（右）准确率显著高于区域1（左）（*P<0.05*）。成因推测：实验中超 7 成用户为右利手，屏幕右侧距右手更近，故右侧热区点击错误率更低。
- **屏幕尺寸**：6.1 英寸手机点击舒适度显著高于 6.5/6.7 英寸（*p<0.05*）。当热区 ≤36dp×36dp 时，中大屏舒适度明显低于小屏且差异较大；当热区 ≥40dp×40dp 后，三种屏幕舒适度基本无差异。成因推测：同一热区在不同屏幕物理尺寸相近，但热区较小（如 17dp×17dp）时在大屏上显得格外小，导致大屏点击困难、舒适度更低。

### 三条核心设计原则（实验结论）

**原则1：页面空间充足时，小尺寸控件热区最短边长应至少 36dp。**
36dp×36dp 在兼顾点击准确率（>90%）与舒适度（6/7 分）的同时，比 ≥44dp 更省页面空间，适合信息密度高的 App 页面。按控件类型细化：

| 控件类型 | 举例 | 热区最短边长建议 |
|---|---|---|
| 购买链路关键操作按钮 | 购物车-去结算、结算页-提交订单 | ≥36dp；空间充足可扩至 44dp（避免点击失败影响购买转化） |
| 信息录入控件 | 购物车商品「+/-」、商品勾选 | ≥36dp（保证高效录入） |
| 导航类控件 | 结算/支付页返回、首页底部导航栏 | ≥36dp（点击频繁，避免切换场域时点错） |
| 引导提示组件的关闭按钮 | 不影响主流程/未严重遮挡（如购物车底部凑单条） | ≥24dp |
| 引导提示组件的关闭按钮 | 影响主流程/严重遮挡（如弹窗广告关闭） | ≥36dp |
| 特殊操作控件 | 购物车-地址隐藏、订单页-到手价说明 | ≥24dp（点击不频繁、转化价值低，可保约 80% 准确率） |

**原则2：重要操作的控件尽量放在屏幕右侧；若需放在左侧，其热区应略大于右侧。**
因屏幕左侧热区比右侧更难点中（区域3 准确率显著高于区域1，*P<0.05*），右利手用户占多数所致。

**原则3：针对中大屏手机（≥6.4 英寸），需等比放大控件的设计大小与热区大小。**
可参考 375dp 宽度手机做等比放大，以提升中大屏用户的主观点击舒适度。

## 可视化 / 出图
- 准确率随热区尺寸变化曲线（分小/中/大屏，呈先快后慢）。
- 9 宫格各格点击准确率热力分布；左/中/右三分区准确率对比。
- 不同屏幕尺寸下舒适度随热区尺寸变化曲线。
- 用户利手分布占比图。
- 控件类型 × 推荐热区尺寸对照示意。

> 原文配图（360buyimg 远程图，原样保留）：
>
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-14-40BbjtkDwrrg7IXUQ.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-25-17-4242z52RGrXcoad7krG.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-24-20-00XhpSK6HZyYID0zR.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-20-06oK7DY58NHo58s6kNs.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-20-07yj4TGA78bpKhsUt.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-18uVWOk4mgWPXwcOu.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-25-17-33bWyogNNP7KZdndj.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-3535pdeljZ8kdTBj835.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-40bI9Sdo40VAqygyd6.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-43xVxAmV79u0mQyfH.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-55knel7qeqX09MYci.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-558ScHDb99KydTAi0.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-58e9Nm58iLDcuU3OLj.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-15-58NJ7U0ACwO739I8GA.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-16-25Il4h8k7BtcwFmGW.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-16-02zWiSD00a7EwrG6M.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-16-01MxnNKP57N7rsv4aP.png)
> ![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2025-04-08-16-04yoHY9r0txGsyyXu.png)

## 工具 / 实现
- 线上点击实验程序（随机呈现单色块、记录命中/用时/舒适度评分）。<!-- ⚠️待补充(缺源)：原文未说明实验平台与统计软件 -->
- 显著性检验（两组/多组比较，报告 P 值）。

## 局限与误用
- 单位为 dp，落地需按设备像素密度换算，且建议以 375dp 宽度为基准等比放大到中大屏。
- 准确率阈值（80%/90%/95%）来自本次 1200 人、三档屏幕的实验，迁移到其他人群/设备/控件形态时应重新校验。
- 位置结论依赖利手分布（本实验超 7 成右利手），左利手为主或横屏等场景下「右侧更易点」未必成立。
- 「先快后慢」意味着盲目放大到 44dp 以上收益递减却挤占页面空间，需在准确率、舒适度、空间之间权衡。
- 成因（利手、物理尺寸相近）多为推测性解释，非实验直接证明，不应当作定论。

## 关联
- 理论根源（model）：费茨定律 `models/fitts-law.md` ⚠️待补充(缺源)
- 常配合的采集方法：
  - `methods/toolbox/collection/usability-testing.md`
  - `methods/toolbox/collection/eye-tracking.md`

## 来源与参考
- 吴佳毅《控件热区怎样设计点击准确率最高？》原文：http://xingyun.jd.com/shendeng/article/detail/45605
- 配套视频课程：https://pc-elive.jd.com/#/8C4BF015261623A6CD1AEDBB583D539A/0
- 实验数据沟通 / 项目合作联系：吴佳毅（wujiayi29）
