# experience-model-lab

独立运行的体验模型分析项目。输入研究问题和产品场景，输出推荐体验模型、推荐理由、问题模板和可核查的本地模型资料来源。

## 启动

```bash
npm install
npm run dev:server
npm run dev:web
```

默认地址：

- Server: `http://127.0.0.1:8803`
- Web: `http://127.0.0.1:5803`

## API

- `GET /api/health`
- `GET /api/models`
- `POST /api/analyze`

## 验证

```bash
npm run smoke
```

## 能力边界

- 体验模型是方法论参考，不是事实证据。
- 当前 MVP 使用本地规则推荐模型，不伪装成真实调研结论。
- 项目内置 `data/experience-models`，不依赖原主仓目录。
