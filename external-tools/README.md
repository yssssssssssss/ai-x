# external-tools — 集中管理的独立工具项目

这里放**各团队独立工具项目的完整源码**(前端 + 后端),集中在主仓库统一管理。

## 与 `tools/` 的区别(重要)

| 目录 | 放什么 | 作用 |
|---|---|---|
| `external-tools/{tool}/` | 工具**整个项目源码** | 集中管理、独立运行 |
| `tools/{tool-id}/` | 工具的**接入声明**(manifest/schema/adapter/examples) | 让编排系统能发现、调用这个工具 |

**放源码 ≠ 系统直接 import 它的代码。** 主系统仍通过接口(HTTP API / 前端地址)与工具通信——源码放这里只是为了统一版本管理和部署,不改变"工具是独立服务"的架构。

## 放一个工具进来

```bash
cp -R /path/to/你的工具项目  external-tools/{tool-name}/
# 或 git clone / 手动拷贝
```

每个子目录保留工具自己的 `package.json` / `requirements.txt` / 启动脚本,独立安装、独立运行,不与主系统 pnpm 依赖混。

## 放进来之后,还需两步才能"接入"(放源码不等于自动可用)

1. **能跑起来**:进入该工具目录,按它自己的方式装依赖、启动服务(它有自己的端口)。
2. **写接入声明**,二选一或都做:
   - **编排自动调用(A)**:在 `tools/{id}/` 写 manifest + schema + adapter.md + examples,登记 `orchestrator/tool-registry.yaml`,让 skill 的 `required_tools` 引用它。前提是工具有可调用的后端 API。参考 `tools/ai-spider-search/`。
   - **门户前端直接使用(B)**:在门户里加入口(iframe 嵌入 / 跳转 / 微前端),指向工具启动后的前端地址。

## git 约定

- 只提交**源码**;各工具的 `node_modules` / `.venv` / `dist` / `build` / `.next` / `.env` / `*.log` 已在根 `.gitignore` 排除。
- 工具的密钥放各自 `.env`(不提交),不要硬编码。

## 已接入工具参考

- `ai-spider-app`(竞品分析平台,FastAPI):**未放源码在此**,作为纯外部服务运行;接入声明见 `tools/ai-spider-search/`。是"只放接入声明"路线的范例——如果你的工具也已在别处稳定运行,其实可以不放源码进来。

### 5 个能力实验室(源码在此 + 已双通道接入)

均为 Fastify + Vite、无鉴权;编排走新增的 `rest_json` adapter(见 `apps/orchestrator-runtime/src/runtime/tool-adapter.ts` 的 `RestJsonAdapter`)。

| 目录 | 后端 | 前端 | 编排声明 | base_url 环境变量 |
|---|---|---|---|---|
| aesthetic-quant-lab | :8801 | :5801 | `tools/aesthetic-quant-lab/` | `AESTHETIC_QUANT_BASE_URL` |
| attention-analysis-lab | :8802 | :5802 | `tools/attention-analysis-lab/` | `ATTENTION_ANALYSIS_BASE_URL` |
| experience-model-lab | :8803 | :5803 | `tools/experience-model-lab/` | `EXPERIENCE_MODEL_BASE_URL` |
| virtual-user-lab | :8804 | :5804 | `tools/virtual-user-lab/` | `VIRTUAL_USER_BASE_URL` |
| vision-brand-lab | :8805 | :5805 | `tools/vision-brand-lab/` | `VISION_BRAND_BASE_URL` |

**一键启动**(源码放进来后先装依赖):

```bash
npm run labs:install     # 遍历 5 个工具目录 npm install
npm run labs:dev         # 并发拉起 5 后端 + 5 前端(Ctrl-C 全退)
# 只起后端:node scripts/start-labs.mjs --server
```

- **通道 B(Web 单独调用)**:门户 `apps/web` 侧栏「工具箱」内嵌各工具前端;也可直接访问 5801-5805。
- **通道 A(编排自动调用)**:已登记 `orchestrator/tool-registry.yaml`;skill 需用时在其 `required_tools` 引用对应 id 即可(当前未默认挂到任何 skill)。
