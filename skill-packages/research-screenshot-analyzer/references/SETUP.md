# 安装与启动

本文面向设计师和协助安装的 AI 助手。Research Screenshot Analyzer 当前通过本地工具 DesignPeek 运行。

## 第零步：获取 DesignPeek

[下载 DesignPeek V0.1 安装包](../downloads/designpeek-v0.1.zip)

下载后解压，进入解压得到的 `designpeek-v0.1` 文件夹。确认文件夹中至少包含：

- `setup.sh`
- `start.sh`
- `requirements.txt`
- `.env.example`
- `server.py`
- `analyzer.py`
- `exporter.py`
- `config.py`
- `static/`

安装包采用白名单方式生成，不包含真实 `.env`、API Key、用户截图或个人分析数据。

## 环境要求

- macOS 优先。
- Python 3。
- 可用的视觉模型 API Key，支持 Gemini、Claude 或 OpenAI 兼容接口。

## 第一步：安装依赖

进入 DesignPeek 项目目录，执行：

```bash
./setup.sh
```

如果提示权限问题，先执行：

```bash
chmod +x setup.sh start.sh
```

然后重新运行：

```bash
./setup.sh
```

## 第二步：配置 AI Key

安装脚本会生成 `.env`。根据团队实际情况选择一种 provider。

### 方案 A：Gemini

```text
AI_PROVIDER=gemini
GEMINI_API_KEY=你的 Key
```

### 方案 B：Claude

```text
AI_PROVIDER=claude
ANTHROPIC_API_KEY=你的 Key
ANTHROPIC_BASE_URL=公司网关地址，可选
```

### 方案 C：OpenAI 或公司 GPT 网关

```text
AI_PROVIDER=openai
OPENAI_API_KEY=你的 Key
OPENAI_BASE_URL=公司网关地址，可选
```

注意：`.env` 只保存在本地，不要提交到仓库，不要发到聊天里。

## 第三步：启动服务

```bash
./start.sh
```

启动后浏览器访问：

```text
http://localhost:8765
```

## 第四步：验证

1. 打开管理页面。
2. 上传一张截图。
3. 选择该截图并执行 AI 分析。
4. 如果能看到页面类型、组件、视觉风格等分析结果，说明安装成功。

## iPhone 快捷指令上传

适合手机上浏览竞品 App 时随手截图并上传到 Mac。

推荐流程：

1. iPhone 打开个人热点，Mac 连接该热点。
2. 在 Mac 系统设置中查看当前 Wi-Fi IP 地址，例如 `172.20.10.2`。
3. iPhone 安装快捷指令模板。
4. 将快捷指令中的上传地址改成：

```text
http://你的MacIP:8765/api/upload/image
```

5. 截图后触发快捷指令，Mac 管理页应能看到新截图。

## 常见问题

### 页面打不开

确认 `./start.sh` 是否仍在运行。终端窗口关闭后，本地服务也会停止。

### AI 分析失败

检查 `.env` 中的 `AI_PROVIDER` 和对应 API Key 是否填写正确。

### 手机传不过来

检查三件事：

- iPhone 和 Mac 是否在同一网络。
- 快捷指令里的 IP 是否是 Mac 当前 IP。
- Mac 上的 DesignPeek 服务是否运行中。
