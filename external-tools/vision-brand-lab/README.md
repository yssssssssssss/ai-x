# vision-brand-lab

独立运行的视觉与品牌分析项目。输入设计稿和可选品牌参考图，输出视觉评审、品牌联想度、共识、冲突和优先动作。

## 启动

```bash
npm install
npm run dev:server
npm run dev:web
```

默认地址：

- Server: `http://127.0.0.1:8805`
- Web: `http://127.0.0.1:5805`

## API

- `GET /api/health`
- `POST /api/uploads`
- `POST /api/analyze`

## 验证

```bash
npm run smoke
```

### VLM 图片链路

在 `vision-brand-lab/.env` 配置 `VLM_USE_TEXT_GATEWAY=true`、网关地址和密钥，以及视觉候选模型后，启动服务并执行：

```bash
npm run dev:server
VLM_E2E_SMOKE=1 npm --workspace @vision-brand-lab/server run smoke:vlm
```

该冒烟会先验证健康接口中的独立视觉候选顺序，再发送内置 PNG 到 `/api/analyze`；只有响应为 `engine: "vlm"` 且未降级才会通过。

## 能力边界

- 当前 MVP 使用本地图像统计和启发式规则，不替代专业设计评审。
- 品牌联想度是风格近似分，不是严格 DINOv2-L embedding 结果。
- 结论应结合人工品牌规范和真实用户测试复核。
