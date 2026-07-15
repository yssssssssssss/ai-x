---
title: 数据标准化与跨维度对比
type: analysis
domain:
  - 通用
research_type:
  - 定量
tags:
  - 数据标准化
  - 归一化
  - Z-score
  - 双重标准化
  - 卡方
  - 正态变换
  - 基准值
  - 赋分
status: draft
sensitivity: internal
owner: 王仰龙
updated: 2026-06-24
related:
  - methods/toolbox/analysis/tgi-index.md
  - methods/toolbox/analysis/key-driver-analysis.md
  - methods/toolbox/collection/scale-development.md
id: toolbox_analysis_data_standardization
source: xingyun_wiki
source_path: methods/toolbox/analysis/data-standardization.md
content_hash: sha256:8553f5f2555261cfbe5614e02d0f1d5784c5cb6ae7219ea5244e3314285e1424
guide_tags: []
guide_stage:
  - method-selection
---

# 数据标准化与跨维度对比

> 来源：神灯圈子·王仰龙《数据标准化处理与分析》 原文 http://xingyun.jd.com/shendeng/article/detail/59072
> 来源：神灯圈子·费婧文《正态分布在客观指标度量模型中的应用》 原文 http://xingyun.jd.com/shendeng/article/detail/46564
>
> 后一篇原作者野驴大石、YYH，写于 2023.12.05。

> 一句话：把不同量纲、不同评价方式、受主观偏好与结构差异影响的数据放到同一标尺上，做跨人群、跨指标、跨平台的公平比较。
> 落点：`methods/toolbox/analysis/`。标准化是一组可脱离任一具体研究单独复用的数据处理手段（归一化 / Z-score / 双重标准化 / 列联表卡方 / 正态变换赋分）。

## 何时用
- 适合的问题类型：
  - 多个产品采用了不同的满意度评价方式，需要横向比较差异。
  - 用户评价容易受到不同对象（多平台）、特征（价格 vs. 售后）差异的影响，直观表现出「强者恒强」，需要剥离这种偏差再比较。
  - 跨人群、跨指标的二维数据，既有维度差异又有品牌/对象差异，需要同时消除。
  - 客观指标（如时长类数据）呈偏态分布，需要变换为近似正态后测定基准值、给指标赋分。
- 与近似技术的区别：标准化处理的是「主观或尺度的偏差」——消除用户/品牌等维度因主观偏好、结构等因素造成的分布不均衡；它本身只为比较服务，标准化后的比例**仅用于比较，不代表实际意义**。

### 为什么要标准化（混杂因素示例）
除了饮食、气候等因素外，心血管疾病的发病率还会随着年龄的增长而增长，而东北地区老龄化程度也超过了全国的平均水平，所以东北地区发病率最高，**混杂了「年龄」这个重要的因素**。

🌰：A 城市年轻人和老年人发病率都低于 B 城市，但 A 城市的整体发病率高于 B 城市。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-14OcqQ8Dcwa0n49VDg.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-146zwZkJfCr49gGxP1.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-15Q6wKvRQ22xLlbBpn.png)

**标准化思路**：设定标准目标 —— 计算预期值 —— 标准化后比例（**仅用于比较，不代表实际意义**）。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-15XBHgAHFSrXJWzwu.png)

## 输入数据要求
- 连续型变量（如满意度评分、时长）可用归一化 / Z-score；分类变量（如各平台在各特征上的频数）可走列联表卡方思路。
- 双重标准化要求二维数据（如「品牌 × 维度」评分矩阵）。
- 正态变换赋分要求同一指标的两组数据：待评价的当期数据组，以及作为比较基准的固定时段数据组（过往 90 天或 180 天）。
- 样本量提示：TGI 在样本量过小时容易失真；正态分布检验中，样本数量低于 200 可能无法通过，400 以上时较容易通过。

## 分析步骤

标准化方法分为两大类——**归一化 / Normalization**（缩放到固定区间）与**标准化 / Standardization**（按比例缩放落入小区间，最常用 Z-score）。

### 归一化 / Normalization
简单来说，就是把原始数据缩放到同一个量纲下进行比较，把数据缩放到固定区间，如 [0, 1] 或 [-1, +1]。

🌰：多个产品采用了不同的满意度评价方式，如何横向比较差异？

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-16DeP1RoHvBxAuO0W.png)

#### Min-Max Scaler
对于原始数据按最大、最小值进行转化，得到的结果落入固定区间，且无量纲。

- 优点：简单易懂，线性变化保留原始数据的比例关系；适合在单次、排名的场景使用。
- 风险：每次新加入数据，可能会调整原始数据的 Max 和 Min 值；对异常值敏感度高。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-141wNovwg1LHIKeDD.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-16QwxTrPA12NsqUyjx.png)

#### RobustScaler 稳健标准化
为了减少异常值对归一化的结果影响，也可以采用中位数、四分位数的方式缩放（基于原始数据的中位数与第 1、第 3 四分位点）。

- 优点：适合存在极端值的数据。
- 风险：结果范围不固定，影响后续分析的可解释性。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-14nEqmWFI9mUy30Y14Y.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-16aT8ke9716KMK8VQ8.png)

#### TGI 指数
目标人群指数 $TGI = \dfrac{目标群体中具有某一特征的群体所占比例}{总体中相同特征群体的比例} \times 100$。

TGI 反映的是不同特征在平均水平的差异情况，一般认为 TGI ≥ 110 会显著高于平均水平。

- 优点：衡量相对偏好强度，用户占比高（看市场规模）≠ 用户偏好高（高价值群体，看潜力）。
- 风险：样本量过小时 TGI 容易失真。

> 详见 `methods/toolbox/analysis/tgi-index.md`。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-14v918K4949iQFq12sZv.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-20FT1RImOk9pjBJpl.png)

### 标准化 / Standardization —— Z-score
把原始数据进行一定比例缩放，落入小的区间内，其中最常用的是 Z-score 标准化。对于原始数据进行正态分布转化，得到的均值为 0 且方差 = 1，无量纲。

- 优点：适用于最大最小值未知、不固定的场景，对异常值相对不敏感。
- 风险：丢失原始数据的实际意义，小样本或分布未知时结果不准。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-1412FFc30xJSbfKofof.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-17grIFePGNIwKszWB.png)

### 双重标准化
单一标准化只消除一个维度，双重标准化针对二维数据，适合更复杂的场景，如跨人群、跨指标的比较。

#### 两步标准化
对同一组数据连续使用两种标准化方法，或不同维度下分别进行标准化，以消除多重偏差，提升可比性。

- Step1：先处理组内的差异，如不同用户的期望差异、量纲差异，如采用 Z-score 消除内部波动。
- Step2：解决全局可比的问题，如跨指标、跨时间的差异，如采用 Min-Max 将不同组映射统一区间。

🌰：比较用户对各品牌在每个维度下满意度评价，消除维度和品牌的差异。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-21lv7hApUWCbtDc21B.png)

1️⃣ 先对行（维度）进行 Z-score 标准化，消除不同品牌在同一维度的评分差异；

2️⃣ 再对列（品牌）进行 Z-score 标准化，消除同一品牌在不同维度下的评分差异。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-21O7m09uFpVyoJdVR.png)

#### 列联表分析（卡方检验与期望频数）
Z-score 适用于连续变量，实际项目中也会遇到分类变量，借助卡方检验的思路，也可以对原始数据标准化。

🌰：用户的评价容易受到不同的对象（多平台）、特征（价格 vs. 售后）差异的影响，直观表现出「强者恒强」。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-13-38V25Y8JhxW38tHz0vA.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-14t1b76olMgPWPyNt.png)

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-12-14Vae30nqGerdK7JjB.png)

先分别计算行列的总和，再计算每个单元格的期望频数，用实际值 − 期望频数，其矩阵的标准差 = 3.8%。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-13-38XLhHoPO301YAWooS.png)

## 专题：用正态分布变换做客观指标的基准值测定与赋分

> 本节并入自《正态分布在客观指标度量模型中的应用》（费婧文 / 野驴大石、YYH）。客观指标监测是用户体验度量模型中的重要部分，而客观指标分布变换和指标基准值测定则是客观指标度量最重要的环节。正态分布函数的特性可以有效地辅助指标变换和基准值测定。

客观指标度量模型中的指标数据很多都是非正态分布。如去掉用户行为影响的响应时长类数据和传统的系统性能时长数据分布类似，都属于偏态分布。此类数据的核心特点是出现非常明显的拖尾，均值落在图形的某一侧，偏离了主要数据集中的位置，导致均值对于群体而言已经没有代表性。对于此类指标以及更复杂的分段分布形式，可以通过多种变换工具将其转化为便于分析的正态分布或近似正态分布的形式。

### 1. 指标的正态分布变换
原始数据呈非正态分布时，在坚持正态性假设前提下，可选择数据转换函数将非正态数据转换为正态数据。常用方法包括对数变换、平方根变换、倒数变换、平方根反正弦变换和 Box-Cox 变换（又称幂变换）。设原始数据为 $x$，转换后数据为 $y$。

**① 对数变换**：将原始数据的对数作为新的分析数据，一般取自然对数（LN）或以 10 为底的对数（LOG10）。
- 数据全部大于 0：$y=\ln(x)$ 或 $y=\lg(x)$；
- 数据中有等于 0：$y=\ln(x+1)$ 或 $y=\lg(x+1)$；
- 数据中有负值：$y=\ln(x+k)$ 或 $y=\lg(x+1)$，其中 $x+k>0$；或 $y=\ln(k-x)$ 或 $y=\lg(k-x)$，其中 $k-x>0$。
- 适用范围：可用 Excel 函数计算原始数据的标准差（STDEV.S）、偏度（KURT）和峰度（SKEW）；如果数据高度偏态（|偏度|>1）或呈现明显指数分布、长尾分布，通常采用对数变换。

**② 平方根变换**：将原始数据的平方根作为新的分析数据。
- 数据全部大于等于 0：$y=\sqrt{x}$；
- 数据中有负值：$y=\sqrt{x+k}$（$x+k\ge0$）或 $y=\sqrt{k-x}$（$k-x\ge0$）。
- 适用范围：数据满足泊松分布（方差与均数近似相等）或轻度偏态（0<|偏度|<0.5），通常采用平方根变换（SQRT）。

**③ 倒数变换**：将原始数据的倒数作为新的分析数据。
- 数据全部大于 0：$y=1/x$；
- 数据中有等于 0：$y=1/(x+1)$；
- 数据中有负值：$y=1/(x+k)$（$x+k>0$）或 $y=1/(k-x)$（$k-x>0$）。
- 适用范围：常用于两端波动较大的情况，可使极端值的影响减小。

**④ 平方根反正弦变换**：先计算平方根，再取反正弦，$y=\arcsin[\sqrt{x}]$，其中 $0\le x\le1$。
- 适用范围：常用于服从二项分布的比例或百分比、中度偏态（0.5<|偏度|<1）的数据。一般认为总体率较小（如 <30%）或较大（如 >70%）时偏离正态较明显，通过样本率的平方根反正弦变换可使资料接近正态、达到方差齐性。注意进行反正弦变换的数字必须在 0 到 1 范围内，百分比需先转化为小数。

**⑤ Box-Cox 变换**：引入一个参数 $\lambda$，通过数据本身估计该参数进而确定应采取的数据变换形式，本质上是上述 4 种变换的综合处理方式。

![](https://img10.360buyimg.com/ling/jfs/t1/168103/13/24344/6976/652fa0e4F33b5a01e/369831eada9665f8.png)

其中 $y(\lambda)$ 为变换后新变量，$y$ 是原始数据，$\lambda$ 是变换参数。原始数据 $y$ 必须为正数，含 0 或负数时需增加常数 $k$ 使 $(y+k)>0$。当 $\lambda=0$ 为对数变换，$\lambda=-1$ 为倒数变换，$\lambda=0.5$ 为平方根变换，其他常用取值如下图。

![](https://img13.360buyimg.com/ling/jfs/t1/9124/19/24176/16211/652fa150F76b3699c/bdc44056f541dc23.png)

一般可通过最大似然估计法估计 $\lambda$ 值，也可借助 Python 实现（先求最佳 $\lambda$，再据此做变换）：

```python
import pandas as pd
from scipy import stats
import sympy as sp

# 读取Excel文件
input_file = 'input.xlsx'
output_file = 'output.xlsx'
data = pd.read_excel(input_file)

# 判断是否需要增加常数K
min_value = data['Value'].min()
if min_value <= 0:
    constant_k = abs(min_value) + 1
    data['Value'] += constant_k
else:
    constant_k = 0

# 计算最佳Box-Cox的lambda值
transformed_data, best_lambda = stats.boxcox(data['Value'])

# 创建符号变量
x = sp.symbols('x')
y = sp.symbols('y')

# 定义Box-Cox转换公式
if best_lambda == 0:
    boxcox_formula = "y = log(x)"
else:
    boxcox_formula = f"y = (x^{best_lambda} - 1) / {best_lambda}"

# 输出Box-Cox转换公式和lambda值
print("使用的Box-Cox转换公式：")
print(boxcox_formula)

print("使用的Box-Cox转换函数：")
print(f"λ = {best_lambda}")

print("K值为：")
print(constant_k)

# 将转换后的数据写入新的Excel文件
data['Transformed_Value'] = transformed_data
data.to_excel(output_file, index=False)
```

### 2. 优化算数平均值的计算（二次均化）
对指标的评价需要同一指标的两组数据：待评价的当期数据组，与作为比较基准的固定时段数据组（过往 90 天或 180 天）。两组都符合正态分布；待评价数据组计算算数平均值 $\bar{x}$，基准数据组计算算数平均值 $\mu$ 和标准差 $\sigma$。

埋点获取的初始数据会有各种异常，直接计算平均值会失真，因此用**二次均化**处理（以响应时长指标为例）：
- 去掉样本数据中的负值；
- 去掉样本数据后 5% 的时长超长异常数据；
- 应用上述变换方法，将样本数据转化为近似正态分布；

![](https://img14.360buyimg.com/ling/jfs/t1/192296/25/29895/6623/652fa356F7b58f34c/637a128a3ddc187a.png)

- 样本数据中去掉一个最小值、去掉一个最大值；
- 对待评价数据组计算 $\bar{x}$，对基准数据组计算 $\mu$；
- 将 $\bar{x}$ 和 $\mu$ 重新置入转换后的正态分布中考察其位置：偏左则与分布的 60% 分位处数据加和求平均，偏右则与分布的 40% 分位处数据加和求平均，得二次均化后的 $\bar{x}$ 和 $\mu$；
- 计算基准数据组的标准差 $\sigma$。

### 3. 基准数据组与总体分布之间的偏差处理
指标的总体分布无法完全测量，需用基准数据组去拟合总体，其 $\mu$、$\sigma$ 与总体存在偏差，可通过抽样平均误差和标准误两个指标衡量。简而言之，可通过增加抽样次数及单次抽样样本量来降低样本与总体的偏差。实际操作中，样本数量低于 200 可能无法通过正态分布检验，400 以上时较容易通过。

### 4. 正态分布累积概率到基准值的转换
变换得到的正态分布都不是标准正态分布，二者需做转换。标准正态分布原值 $z$ 与普通正态分布值 $x$ 的关系为：

![](https://img20.360buyimg.com/ling/jfs/t1/92313/31/29589/5752/652fac8cFb40eb6be/96a1abfde68f6d0a.png)

进一步将正态分布的累积分布函数（误差形式）写出：

![](https://img12.360buyimg.com/ling/jfs/t1/206108/24/37128/2300/652fa499F653fa2e3/46aaa3095c6d4f7a.png)

通过以上两个公式可获得原值 $x$ 和其对应累积概率 $\Phi(x)$ 之间的关系。由于已知累积概率求原值较困难，可查阅标准正态分布 $z$ 值表：

![](https://img13.360buyimg.com/ling/jfs/t1/133124/40/40416/70849/652fa4aeF839506e5/0d1a29554a5c20cd.png)

左单侧对照表：

![](https://img12.360buyimg.com/ling/jfs/t1/195134/1/37944/1592730/652fa4f1Fd91ba48a/c6f9347cc1ba0b61.png)

右单侧对照表：

![](https://img13.360buyimg.com/ling/jfs/t1/177558/32/39559/1582020/652fa504F93f0926b/5478b814a83d9a6c.png)

**举例**：某提交按钮的响应时长数据已处理为近似正态分布，算数平均值 $\mu=5.378$，标准差 $\sigma=1.023$，希望计算累积概率为 40% 时对应的指标值 $x$。查表可知 $\Phi(z)=0.4$ 时 $z=-0.25$：

![](https://img20.360buyimg.com/ling/jfs/t1/185283/18/40253/41964/652fa586Fdb3f688f/68fd8bbc2b6af035.png)

变换指标值 $x$ 与原值 $z$ 的关系：

![](https://img11.360buyimg.com/ling/jfs/t1/93176/11/28507/8532/652fa5bfF2f20a4b0/27e10d7ae9d3c91c.png)

代入各参数值，可得指标值 $x$ 为 5.122。

对于加载时长，其值越短越好。解释为：如果待评价的当期指标均值小于 5.122 秒，则当期指标表现在指标整体表现中处于前 40% 的位置，即超过了整体 60% 的情况；按百分制，已超过及格线（60 分）。通过此方法得出的指标值 $x$ 即可作为指标的基准值；代入不同累积概率值，可计算不同分位的指标基准值。

### 5. 评价分值（赋分）方法
核心都是以指标正态分布为基础，对其波动范围进行划分进而赋分，主要为**分箱法**和**区间映射法**。

**分箱法**：通常以标准差 $\sigma$ 为刻度划分指标分布范围。以加载时长为例：$\mu-3\sigma$ 以下为 5 分，$\mu-3\sigma$ 到 $\mu-\sigma$ 之间为 4 分，$\mu-\sigma$ 到 $\mu$ 之间为 3 分，$\mu$ 到 $\mu+\sigma$ 之间为 2 分，$\mu+\sigma$ 到 $\mu+3\sigma$ 之间为 1 分，$\mu+3\sigma$ 以上为 0 分。前述测定基准值的方法本质上也是一种分箱（低于基准值是好，高于基准值就是差）。优势是简洁直观，缺点是分箱通常比较粗犷、分值不敏感，难以定量分析。

![](https://img12.360buyimg.com/ling/jfs/t1/40515/28/27405/22643/652fa61bFda718459/d037da6307be9960.jpg)

**区间映射法**：本质是将指标波动范围和分值区间进行映射。某 C 端小程序体验度量模型的赋分区间如下：

![](https://img20.360buyimg.com/ling/jfs/t1/210249/9/32347/74420/652fa68fF76184bea/8d5d964b00155631.png)

实际应用中由于样本与总体分布偏差，特殊情况下会有实际度量值超过目标值或低于门槛值，导致分数极值、失去度量意义，通常后续会增加限制条件处理。该方式适合之前已有度量工作、后续增加客观指标的情况，可设定底分保证模型平稳过渡。

前文「通过特定累积概率求对应指标值」的方法也可转化为一种区间映射赋分：通过 $z$ 值表获得累积概率 0%～100% 区间对应的指标值 $x$ 范围，设累积概率 0% 时为 100 分、100% 时为 0 分，用当期指标均值 $\bar{x}$ 与范围比较直接转化为分数。优点是永远不会超出指标范围，缺点是范围较大可能导致分值不敏感、分数波动小、初始分数偏低，只适用于最初就使用此种赋分的情况。（原文注：此法在项目中尚未实际投入度量模型检验，属探索性想法，源文未实际验证，⚠️待补充(缺源)）

## 结果解读
- **归一化/标准化**：标准化后的比例仅用于比较，不代表实际意义；需结合数据的实际含义解读。
- **TGI**：以 100 为基准线，高于 100 表示相对偏好强于整体水平。
- **双重标准化/列联表**：消除维度与对象（品牌/平台）双重偏差后，再读各单元格相对强弱，破除「强者恒强」的表面印象。
- **正态变换赋分**：基准值用于区分「好/差」（如时长越短越好则低于基准值为好）；累积概率分位对应该指标在整体中的相对位置。

## 可视化 / 出图
- 双重标准化常以「品牌 × 维度」热力矩阵呈现行/列标准化后的相对强弱。
- 正态变换后可用分布图标注 $\mu$、$\sigma$ 刻度与分箱/分位区间。
- 列联表卡方以「实际值 − 期望频数」的偏差矩阵呈现各格相对优势。

## 工具 / 实现
- 归一化、Z-score、TGI、列联表期望频数均可在 Excel / 任意统计工具中计算。
- 正态变换的偏度（KURT）、峰度（SKEW）、标准差（STDEV.S）可用 Excel 函数；Box-Cox 最佳 $\lambda$ 与变换可用 Python（`scipy.stats.boxcox`，见上方代码）。
- 标准正态分布 $z$ 值（单侧）可查 $z$ 值对照表反推指标值。

## 局限与误用
- **标准化核心思路：设定标准 —— 计算期望值 —— 与实际值比较 —— 解读差异。**
  - 优势：用于处理主观或尺度的偏差，消除用户/品牌等维度因主观偏好、结构等因素造成的分布不均衡。
  - 局限：丢失了数据的直观性，需要结合数据的实际意义做解读。

![](https://s3.cn-north-1.jdcloud-oss.com/shendengbucket1/2026-01-30-13-39BNAGlg397FmfPEDz.png)

- Min-Max 对异常值敏感，且新数据加入会改变 Max/Min；RobustScaler 范围不固定影响可解释性；Z-score 在小样本或分布未知时结果不准。
- TGI 在样本量过小时容易失真。
- 正态变换并非万能：离散型随机变量分布、多峰分布等变换后未必服从正态；本文方法更适用于时长类指标，对率值类指标（成功率、失败率）存在局限。
- 若变换后仍无法转为正态，可考虑**分段分析**（数据呈明显多段特征时切分处理；如失败率经平方根变换后仍呈二段，将率为 0 与非 0 分别归集处理，需取多段基准值时按数据集占比加权求子基准值的加权平均，再结合专家经验修正）或**非参数检验**（如 Wilcoxon 检验、Mann-Whitney U 检验）。

![](https://img14.360buyimg.com/ling/jfs/t1/196226/21/40395/107952/652fada0F9bac7170/e10014f6b341044b.jpg)

## 关联
- 理论根源（model）：⚠️待补充(缺源)
- 常配合的分析技术：`methods/toolbox/analysis/tgi-index.md`、`methods/toolbox/analysis/key-driver-analysis.md`
- 常配合的采集方法：`methods/toolbox/collection/scale-development.md`（量表评分是标准化的常见输入）

## 来源与参考
- 神灯圈子·王仰龙《数据标准化处理与分析》：http://xingyun.jd.com/shendeng/article/detail/59072
- 神灯圈子·费婧文《正态分布在客观指标度量模型中的应用》（原作者野驴大石、YYH）：http://xingyun.jd.com/shendeng/article/detail/46564
- 正态分布变换参考：http://www.biostathandbook.com/transformation.html
- 正态分布变换参考：https://wenku.baidu.com/view/96140c8376a20029bd642de3.html?_wkts_=1695650860214
