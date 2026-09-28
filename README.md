# Geo Sleuth Web

公网页最小可上线骨架：用户**自填 Cursor API Key（BYOK）**，上传照片后，后端代理调用 **Cursor Cloud Agents API**，用**后端内嵌的 geo-sleuth 技能**做拍摄地点分析，并尽量推荐近同机位网络照片。

## 架构（当前实现）

```
浏览器 UI ──► Cloudflare Worker ──► Cursor Cloud Agent
                 │                      │
                 ├─ 不存用户 Key         ├─ 默认无仓库（AGENT_REPO_URL=none）
                 └─ 内嵌 skill 归档 ──► 写入工作区 .agents/skills/geo-sleuth
                                        （禁止 git clone / npx skills 装技能）
```

| 部件 | 说明 |
|---|---|
| `web/` | 静态页：Key、上传、轮询、结果 |
| `worker/` | Hono API：创建/查询/取消 Cloud Agent |
| `.agents/skills/geo-sleuth/` | 技能源码（vendoring） |
| `worker/src/generated/skill-archive.ts` | 由 `pack:skill` 生成的内嵌 gzip 归档 |

**不会**再把 Cloud Agent 绑到 `Oldcircle/geo-sleuth` 远程仓；技能只从后端包注入。

## 内置技能怎么更新

1. 改 `.agents/skills/geo-sleuth/`（或从上游同步后再改）  
2. 执行 `npm run pack:skill`（`npm run dev` / `deploy` 前会自动跑）  
3. 重新部署或重启本地 `wrangler dev`

创建任务时，Worker 把归档写进 prompt，要求 Agent 解压到 `.agents/skills/geo-sleuth`，并禁止远程下载/安装该技能。  
（脚本运行所需的 Python/`uv` 依赖仍可按 SKILL 正常安装；禁止的是再去拉 skill 源码。）

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
2. 粘贴到页面 → 上传照片 → 开始分析  
3. 可用「在 Cursor 打开 Agent」看云端进度  

健康检查：`GET /api/health` 应含 `skillBundled: true`。

## 部署到 Cloudflare

```bash
npm run deploy
```

可选环境变量（`wrangler.toml` 或 Dashboard）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_REPO_URL` | `none` | `none`/空 = 无仓库 Agent；也可填**你自己**已连接 Cursor 的 GitHub 仓 |
| `AGENT_REPO_REF` | `main` | 仅当绑定了仓库时有效 |
| `AGENT_MODEL_ID` | （账号默认） | 可选，如 `composer-2` |

技能**不依赖** `AGENT_REPO_URL`；绑自己的仓只是给 Agent 一个 git 工作区，不是为了下载 skill。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/tasks` | 创建任务；头 `X-Cursor-Api-Key`；体：`imageBase64`、`mimeType`、可选 `prompt` |
| `GET` | `/api/tasks/:agentId/:runId` | 轮询状态与结果；需带同一 Key |
| `POST` | `/api/tasks/:agentId/:runId/cancel` | 取消 run |
| `GET` | `/api/health` | 健康检查（含 `skillBundled`） |

Key 仅经请求头透传，服务端不落库。

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
