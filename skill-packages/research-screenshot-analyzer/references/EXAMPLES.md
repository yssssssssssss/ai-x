# 调用示例

以下示例假设 Research Screenshot Analyzer 对应的本地 DesignPeek 服务已启动：

```text
http://localhost:8765
```

## 示例 1：上传一张截图

```bash
curl -X POST "http://localhost:8765/api/upload/image?app=微信" \
  --data-binary "@screenshot.png"
```

返回：

```json
{
  "ok": true,
  "filename": "微信_20260714_103000.png"
}
```

## 示例 2：获取截图列表

```bash
curl "http://localhost:8765/api/screenshots?limit=20"
```

返回：

```json
[
  {
    "id": "微信_20260714_103000",
    "path": "微信/微信_20260714_103000.png",
    "status": "organized",
    "app": "微信",
    "page_type": null,
    "analysis": null,
    "mtime": 1784005800.0
  }
]
```

## 示例 3：分析一张截图

```bash
curl -X POST "http://localhost:8765/api/analyze" \
  -H "Content-Type: application/json" \
  -d '{"ids":["微信_20260714_103000"]}'
```

可能返回：

```json
{
  "ok": true,
  "results": {
    "微信_20260714_103000": {
      "app_name": "微信",
      "page_type": "首页",
      "tags": {
        "components": ["导航栏", "卡片列表"],
        "visual_style": ["留白设计"],
        "layout": ["单列Feed"]
      },
      "visual": {
        "primary_colors": ["#FFFFFF", "#F5F5F5"],
        "color_scheme": "浅色背景，低饱和分隔",
        "typography": "系统字体，字号层级清晰",
        "icon_style": "线性图标",
        "spacing": "列表项间距稳定"
      },
      "summary": "该页面以消息列表为核心，信息组织清晰。"
    }
  }
}
```

## 示例 4：创建研究项目

```bash
curl -X POST "http://localhost:8765/api/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"公益频道竞品分析",
    "description":"对比主流 App 公益频道入口、内容组织和转化链路。"
  }'
```

返回：

```json
{
  "ok": true,
  "project": {
    "id": "proj_ab12cd34",
    "name": "公益频道竞品分析",
    "description": "对比主流 App 公益频道入口、内容组织和转化链路。",
    "screenshots": {},
    "analysis": null,
    "created_at": "2026-07-14T10:30:00"
  }
}
```

## 示例 5：把截图加入项目

```bash
curl -X PUT "http://localhost:8765/api/projects/proj_ab12cd34" \
  -H "Content-Type: application/json" \
  -d '{
    "add_screenshots": [
      {
        "id": "微信_20260714_103000",
        "module": "首页与入口"
      }
    ]
  }'
```

## 示例 6：执行项目级分析

```bash
curl -X POST "http://localhost:8765/api/projects/proj_ab12cd34/analyze"
```

返回中会包含：

- `screenshot_tags`
- `overview`
- `platform_comparison`
- `touchpoint_analysis`
- `design_highlights`
- `recommendations`

## 示例 7：导出 HTML 报告

```bash
curl -o report.html "http://localhost:8765/api/projects/proj_ab12cd34/export"
```

导出的 `report.html` 是自包含文件，适合离线查看和评审分享。

## AI 助手推荐调用顺序

当 AI 助手需要辅助完成一次竞品分析时，推荐顺序是：

1. 检查本地 DesignPeek 服务是否启动。
2. 上传或确认截图已经存在。
3. 获取截图列表。
4. 创建项目。
5. 添加截图到项目。
6. 触发项目分析。
7. 导出报告。
8. 根据报告生成 wiki 摘要或评审材料。
