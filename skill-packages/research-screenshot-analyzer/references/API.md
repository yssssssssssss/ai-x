# Research Screenshot Analyzer API 说明

本文描述 Research Screenshot Analyzer 当前基于 DesignPeek 提供的 HTTP API，以及后续作为通用工具时建议稳定下来的调用协议。

默认本地服务地址：

```text
http://localhost:8765
```

## 当前可用接口

### 上传截图

```http
POST /api/upload/image
```

用途：上传一张图片，适合 iPhone 快捷指令、脚本或其他工具直接调用。

请求方式：

- 请求体为图片二进制。
- 可通过 query 或 header 传入 App 名。

示例：

```bash
curl -X POST "http://localhost:8765/api/upload/image?app=微信" \
  --data-binary "@screenshot.png"
```

响应示例：

```json
{
  "ok": true,
  "filename": "微信_20260714_103000.png"
}
```

### 上传 multipart 文件

```http
POST /api/upload
```

用途：浏览器或表单上传。

示例：

```bash
curl -X POST "http://localhost:8765/api/upload" \
  -F "file=@screenshot.png"
```

### 上传 base64 JSON

```http
POST /api/upload/base64
```

用途：不方便传二进制时使用。

请求示例：

```json
{
  "filename": "screenshot.png",
  "image": "base64 encoded image"
}
```

### 获取截图列表

```http
GET /api/screenshots?limit=200
```

用途：获取本地截图及其分析状态。

响应字段：

- `id`：截图 ID，通常为文件名去掉扩展名。
- `path`：相对 `screenshots/` 的路径。
- `status`：`inbox` 或 `organized`。
- `app`：App 名。
- `page_type`：页面类型或模块。
- `analysis`：已有 AI 分析结果。
- `mtime`：修改时间。

### 分类截图

```http
POST /api/classify
```

用途：把待整理截图移动到指定 App / 页面类型目录。

请求示例：

```json
{
  "ids": ["20260714_103000_ab12cd"],
  "app": "微信",
  "page_type": "首页"
}
```

### 单图分析

```http
POST /api/analyze
```

用途：对一张或多张截图执行 AI 视觉分析。

请求示例：

```json
{
  "ids": ["微信_首页_20260714_103000"]
}
```

响应示例：

```json
{
  "ok": true,
  "results": {
    "微信_首页_20260714_103000": {
      "app_name": "微信",
      "page_type": "首页",
      "tags": {
        "components": ["导航栏", "卡片列表"],
        "visual_style": ["留白设计"],
        "layout": ["单列Feed"]
      },
      "summary": "该页面以消息列表为核心，信息层级清晰。"
    }
  }
}
```

### 创建项目

```http
POST /api/projects
```

请求示例：

```json
{
  "name": "公益频道竞品分析",
  "description": "对比多个 App 公益频道的入口、内容组织和转化链路。"
}
```

### 获取项目列表

```http
GET /api/projects
```

### 更新项目

```http
PUT /api/projects/{pid}
```

用途：添加截图、移除截图、修改项目名、更新模块。

请求示例：

```json
{
  "add_screenshots": [
    {
      "id": "微信_首页_20260714_103000",
      "module": "首页与入口"
    }
  ]
}
```

### 项目级分析

```http
POST /api/projects/{pid}/analyze
```

用途：对项目中的所有截图进行跨平台竞品分析。

输出包括：

- `screenshot_tags`：截图到模块的映射。
- `overview`：整体策略概览。
- `platform_comparison`：平台对比。
- `touchpoint_analysis`：模块分析。
- `design_highlights`：设计亮点。
- `recommendations`：综合建议。

### 导出项目报告

```http
GET /api/projects/{pid}/export
```

用途：导出自包含 HTML 报告。

## 后续规划（当前未实现）

以下接口和结果结构均未在 V0.1 中实现。为了让其他工具更容易调用，建议后续补充。

### 健康检查

```http
GET /api/health
```

建议响应：

```json
{
  "ok": true,
  "version": "1.0.0",
  "ai_provider": "openai",
  "ocr_available": true
}
```

### 获取 schema

```http
GET /api/schema
```

用途：返回接口 schema、分析结果 schema 和工具能力清单。

### JSON / Markdown 导出

```http
GET /api/projects/{pid}/export?format=json
GET /api/projects/{pid}/export?format=markdown
GET /api/projects/{pid}/export?format=html
```

用途：让 design wiki、AI 助手和其他系统直接消费分析结果。

### 异步任务

```http
POST /api/jobs/analyze-project
GET /api/jobs/{job_id}
```

用途：项目截图较多时，避免请求长时间阻塞。

## 推荐统一结果结构

项目级分析建议稳定为：

```json
{
  "version": "1.0",
  "project": {
    "id": "proj_xxx",
    "name": "公益频道竞品分析",
    "description": ""
  },
  "screenshots": [],
  "modules": [],
  "platform_comparison": [],
  "design_highlights": [],
  "recommendations": "",
  "generated_at": "2026-07-14T10:30:00+08:00"
}
```

这样后续可以同时服务：

- Web UI。
- design wiki。
- AI 助手。
- 自动化脚本。
- 设计评审报告。
