# attention-analysis-lab

独立运行的用户注意力分析项目。输入页面截图和 ROI，输出启发式注意力热力图、热点、ROI 注意力排序和分散风险。

## 启动

```bash
npm install
npm run dev:server
npm run dev:web
```

默认地址：

- Server: `http://127.0.0.1:8802`
- Web: `http://127.0.0.1:5802`

## API

- `GET /api/health`
- `POST /api/uploads`
- `POST /api/analyze`

示例：

```json
{
  "image": { "path": "tmp/uploads/example.png" },
  "mode": "heuristic",
  "rois": [
    { "id": "hero", "label": "主视觉", "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.4 }
  ]
}
```

## 验证

```bash
npm run smoke
```

## 能力边界

- 当前 MVP 是启发式注意力估计，不是眼动实验。
- 输出不能代表真实用户注意力数据。
- 项目不依赖原 `users-research-all` 服务。
