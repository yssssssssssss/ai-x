# virtual-user-lab

独立运行的虚拟用户用研项目。输入产品场景和方案描述，输出模拟 Persona、模拟反馈、痛点、亮点、分歧和行动建议。

## 启动

```bash
npm install
npm run dev:server
npm run dev:web
```

默认地址：

- Server: `http://127.0.0.1:8804`
- Web: `http://127.0.0.1:5804`

## API

- `GET /api/health`
- `GET /api/personas`
- `POST /api/simulate`

## 验证

```bash
npm run smoke
```

## 能力边界

- 输出是模拟用户反馈，不是真实用户访谈、问卷或实验结果。
- 所有 review 都带 `isSimulated: true`。
- 结论只能用于方案初筛和研究假设生成。
