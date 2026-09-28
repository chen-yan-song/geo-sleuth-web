# Geo Sleuth Web

公网页最小可上线骨架：用户**自填 Cursor API Key（BYOK）**，上传照片后，后端代理调用 **Cursor Cloud Agents API**，用**后端内嵌的 geo-sleuth 技能**做拍摄地点分析，并尽量推荐近同机位网络照片。

- 仓库：https://github.com/chen-yan-song/geo-sleuth-web
- 线上：https://geo-sleuth-web.yifan2848.workers.dev

## 架构（当前实现）

```
浏览器 UI ──► Cloudflare Worker ──► Cursor Cloud Agent（按 API Key 复用 sticky / 暖机）
                 │                      │
                 ├─ Key 不落库；KV 只存 sha256(key)→agentId
                 ├─ POST /api/warmup 预装 skill+依赖（不做分析）
                 └─ 内嵌 skill 归档（/skill.tgz）──► Agent 拉取校验后解压
                                        （禁止 git clone / npx skills 装技能）
```

| 部件 | 说明 |
|---|---|
| `web/` | 静态页：Key、预热、上传、轮询、结果 |
| `worker/` | Hono API：创建/复用/查询/取消 Cloud Agent + warmup |
| `.agents/skills/geo-sleuth/` | 技能源码（vendoring） |
| `worker/src/generated/skill-archive.ts` | 由 `pack:skill` 生成的内嵌 gzip 归档 |
| `AGENT_POOL` KV | 可选；绑定后同一 Key 复用暖机 Agent |

**不会**再把 Cloud Agent 绑到 `Oldcircle/geo-sleuth` 远程仓；技能只从后端包注入。  
**不会**为提速砍掉 sat/OCR 等技能步骤；暖机只预装环境。

## 内置技能怎么更新

1. 改 `.agents/skills/geo-sleuth/`（或从上游同步后再改）  
2. 执行 `npm run pack:skill`（`npm run dev` / `deploy` 前会自动跑）  
3. 重新部署或重启本地 `wrangler dev`

归档内嵌在 Worker 代码里，由本服务的 `GET /skill.tgz` 直接输出。创建任务时，prompt 只带一段短命令：Agent 从本服务拉取归档，用 sha256 校验后解压到 `.agents/skills/geo-sleuth`。禁止从 GitHub/npm 等第三方来源获取技能。  
（不再把整包 base64 塞进 prompt：约 400KB 的内容需要模型原样复述进命令，会导致 Agent 卡死。）  
（脚本运行所需的 Python/`uv` 依赖仍可按 SKILL 正常安装。）

## 本地运行

需要 Node 20+（见 `.nvmrc`）。

```bash
cd "/Users/chenyan/Documents/pro/cursor pro/geo-sleuth-web"
source ~/.nvm/nvm.sh && nvm use
npm install
npm run dev
```

浏览器打开终端提示地址（通常 `http://127.0.0.1:8787`）。

1. 在 [Cursor Dashboard → API Keys](https://cursor.com/dashboard?tab=integrations) 创建 Key  
2. 粘贴到页面 →（可选）点「预热环境」→ 上传照片 → 开始分析  
3. 可用「在 Cursor 打开 Agent」看云端进度；同一 Key 的后续任务会跟进到同一 sticky Agent  

健康检查：`GET /api/health` 应含 `skillBundled: true`；绑定 KV 后还有 `agentPoolKv: true`。

## 部署到 Cloudflare

先创建（或复用）KV，把 id 写入 `wrangler.toml` 的 `AGENT_POOL`：

```bash
npx wrangler login   # 或设置 CLOUDFLARE_API_TOKEN
npx wrangler kv namespace create AGENT_POOL
npx wrangler kv namespace create AGENT_POOL --preview
# 将输出的 id / preview_id 填进 wrangler.toml
npm run deploy
```

未绑定 KV 时服务仍可部署运行，但每次任务都会新建 Agent（无暖机复用）。

可选环境变量（`wrangler.toml` 或 Dashboard）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | 线上地址 | 云端 Agent 拉取 `/skill.tgz` 的地址；本地开发也须指向公网可访问的部署 |
| `AGENT_REPO_URL` | `none` | `none`/空 = 无仓库 Agent；也可填**你自己**已连接 Cursor 的 GitHub 仓 |
| `AGENT_REPO_REF` | `main` | 仅当绑定了仓库时有效 |
| `AGENT_MODEL_ID` | （账号默认） | 可选，如 `composer-2` |

技能**不依赖** `AGENT_REPO_URL`；绑自己的仓只是给 Agent 一个 git 工作区，不是为了下载 skill。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/tasks` | 创建或**复用** sticky Agent 跑完整分析；头 `X-Cursor-Api-Key`；体：`imageBase64`、`mimeType`、可选 `prompt`。响应含 `reused` / `warm` |
| `POST` | `/api/warmup` | 预热：确保 sticky Agent，只装 skill+依赖，不做照片分析 |
| `GET` | `/api/pool` | 暖池状态。无 Key 只返回是否绑定 KV；有 Key 返回该 Key 的 sticky 摘要 |
| `GET` | `/api/tasks/:agentId/:runId` | 轮询状态与结果；需带同一 Key（预热 run 结束时会把 sticky 标为 ready） |
| `POST` | `/api/tasks/:agentId/:runId/cancel` | 取消 run |
| `GET` | `/api/health` | 健康检查（含 `skillBundled`、`agentPoolKv`） |
| `GET` | `/skill.tgz` | 内嵌技能归档，供云端 Agent 拉取 |

Key 仅经请求头透传；服务端不存原始 Key，KV 只存 `sha256(key)` → `{ agentId, warmedAt, … }`。  
同一 sticky Agent 同时只能跑一个 run（Cursor `409 agent_busy`）；请等结束或取消后再提交。

### 暖机限制

- 复用依赖 Cursor Cloud Agents **follow-up** API：`POST /v1/agents/{id}/runs`（已实现）。Agent 被归档/过期时会清 KV 并新建。
- Cursor 侧 VM 可能休眠；follow-up 仍走同一 agent/workspace，但休眠唤醒可能仍有延迟。
- 未配置 `AGENT_POOL` KV 时暖机接口返回 503，分析仍可走「每次新建」。

## 目录速览

```
geo-sleuth-web/
  web/                 # 前端
  worker/src/          # Worker API
  worker/src/generated/# pack:skill 产物（勿手改）
  .agents/skills/      # geo-sleuth 源码
  .cursor/skills/      # 同上副本（便于本地 Cursor）
  scripts/pack-skill.mjs
  NOTICE.md            # 第三方许可说明
```

## 合规提示

- 仅分析用户有权处理的照片  
- 费用由用户自己的 Cursor Key 承担  
- 内嵌技能来源与许可见 `NOTICE.md`（MIT，源自 Oldcircle/geo-sleuth）
