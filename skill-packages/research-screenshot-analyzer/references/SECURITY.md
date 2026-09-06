# 安全与隐私边界

Research Screenshot Analyzer 当前基于 DesignPeek 运行，面向竞品截图和用研材料管理，默认采用本地优先策略。上传到 design wiki 或分发给同事前，需要明确以下安全边界。

## 本地存储

默认情况下，DesignPeek 会在本地保存：

- `screenshots/`：截图素材。
- `data/analysis.json`：单图 AI 分析结果。
- `data/projects.json`：项目和项目级分析结果。
- `.env`：AI provider 和 API Key。

这些文件默认不应进入公开仓库或团队 wiki 附件。

## 禁止分发的内容

以下内容禁止打包、上传或提交：

- `.env`
- `screenshots/`
- `data/analysis.json`
- `data/projects.json`
- `data/capture_paths.json`
- 未脱敏的业务截图
- 含用户个人信息、订单信息、账号信息、聊天内容的截图

## 可以分发的内容

以下内容可以作为工具包分发：

- Python 源码。
- 静态前端文件。
- 安装脚本。
- `.env.example`
- 使用说明。
- API 说明。
- skill 文档。
- 不含真实截图和真实 Key 的示例数据。

## AI Key 管理

- API Key 只写入本地 `.env`。
- 不要写进 `README.md`、`SKILL.md`、截图、报告或聊天消息。
- 如果需要团队统一网关，文档里只写配置项，不写真实地址和真实 Key。
- 分发包中只保留 `.env.example`。

## 截图数据处理

竞品截图通常风险较低，但仍需注意：

- 不要包含自己的登录态、账号头像、手机号、地址、订单等个人信息。
- 不要上传内部业务页面截图，除非已经脱敏并确认可用于研究。
- 不要把用户访谈、可用性测试录屏中的个人信息截图直接交给外部模型。
- 报告进入 design wiki 前，建议人工检查截图内容。

## 模型调用说明

DesignPeek 的截图分析会调用配置的视觉模型 provider。虽然工具本身本地运行，但当执行 AI 分析时，图片内容可能会被发送给对应 provider 或公司网关。

因此：

- 使用公司 Key 时，优先走公司批准的模型网关。
- 使用个人 Gemini / OpenAI / Claude Key 时，不应分析敏感业务截图。
- 对外部模型的使用应遵守团队和公司的数据安全规范。

## 打包校验建议

分发前应确认包内没有：

```text
.env
screenshots/
data/analysis.json
data/projects.json
data/capture_paths.json
__pycache__/
.DS_Store
```

当前项目已有 `make_package.sh`，采用白名单方式打包，这是推荐方式。
