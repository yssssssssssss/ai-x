# aesthetic-quant-lab

独立运行的美学量化分析项目。输入设计图、ROI、前景图和背景图，输出整图视觉统计、ROI 量化、前景/背景配色关系、注意力启发式结果、建议和边界说明。

## 启动

```bash
npm install
npm run dev:server
npm run dev:web
```

默认地址：

- Server: `http://127.0.0.1:8801`
- Web: `http://127.0.0.1:5801`

## API

### `GET /api/health`

健康检查。

### `GET /api/profiles`

返回分析 profile。

### `POST /api/uploads`

上传图片，字段名为 `file`。

### `POST /api/analyze`

```json
{
  "designImage": {
    "path": "tmp/uploads/example.png"
  },
  "rois": [
    { "id": "hero", "label": "主视觉", "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.4 }
  ],
  "profileId": "balanced",
  "depth": "standard"
}
```

## 验证

```bash
npm run smoke
```

## 能力边界

- 结果是启发式视觉量化，不是专业审美裁决。
- 注意力结果不是眼动实验，也不代表真实用户注意力数据。
- 当前 MVP 使用本地图像统计，不依赖原 `users-research-all` 服务。
