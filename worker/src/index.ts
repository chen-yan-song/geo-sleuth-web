import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  SKILL_ARCHIVE_BASE64,
  SKILL_ARCHIVE_BYTES,
  SKILL_ARCHIVE_SHA256,
  SKILL_ROOT_REL,
} from "./generated/skill-archive";

type Env = {
  ASSETS: Fetcher;
  AGENT_REPO_URL: string;
  AGENT_REPO_REF: string;
  AGENT_MODEL_ID?: string;
  /** 云端 Agent 能访问到的本服务公网地址；本地开发时须指向线上地址 */
  PUBLIC_BASE_URL?: string;
};

let skillArchiveBytes: Uint8Array | null = null;

function getSkillArchive(): Uint8Array {
  if (!skillArchiveBytes) {
    const bin = atob(SKILL_ARCHIVE_BASE64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    skillArchiveBytes = out;
  }
  return skillArchiveBytes;
}

type CreateTaskBody = {
  /** 用户自然语言问题；可为空，走默认模板 */
  prompt?: string;
  /** 图片 base64（不含 data: 前缀） */
  imageBase64: string;
  /** 如 image/jpeg */
  mimeType: string;
};

const CURSOR_API = "https://api.cursor.com/v1";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "geo-sleuth-web",
    repo: c.env.AGENT_REPO_URL || "none",
    skillBundled: true,
    skillArchiveBytes: SKILL_ARCHIVE_BYTES,
    skillArchiveSha256: SKILL_ARCHIVE_SHA256,
    skillRoot: SKILL_ROOT_REL,
  }),
);

/** 内嵌技能包：云端 Agent 用一条短命令拉取并解压，避免把整包塞进 prompt */
app.get("/skill.tgz", () =>
  new Response(getSkillArchive(), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(SKILL_ARCHIVE_BYTES),
      "Cache-Control": "public, max-age=300",
      "X-Skill-Sha256": SKILL_ARCHIVE_SHA256,
    },
  }),
);

/** 创建 Cloud Agent 任务（用户自带 Cursor API Key） */
app.post("/api/tasks", async (c) => {
  const apiKey = readUserApiKey(c.req.header("x-cursor-api-key"));
  if (!apiKey) {
    return c.json({ error: "请提供 Cursor API Key（请求头 X-Cursor-Api-Key）" }, 401);
  }

  let body: CreateTaskBody;
  try {
    body = await c.req.json<CreateTaskBody>();
  } catch {
    return c.json({ error: "请求体必须是 JSON" }, 400);
  }

  if (!body?.imageBase64 || !body?.mimeType) {
    return c.json({ error: "缺少 imageBase64 或 mimeType" }, 400);
  }

  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  if (!allowed.has(body.mimeType)) {
    return c.json({ error: "仅支持 jpeg/png/gif/webp" }, 400);
  }

  // 粗略限制：约 12MB base64，避免打满 Cursor 15MB 上限
  if (body.imageBase64.length > 16_000_000) {
    return c.json({ error: "图片过大，请压缩到约 10MB 以内" }, 413);
  }

  const userPrompt = body.prompt && body.prompt.trim();
  const baseUrl = (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, "");
  const text = buildTaskPrompt(`${baseUrl}/skill.tgz`, userPrompt);

  const payload: Record<string, unknown> = {
    name: "geo-sleuth-web",
    prompt: {
      text,
      images: [
        {
          data: body.imageBase64,
          mimeType: body.mimeType,
        },
      ],
    },
    autoCreatePR: false,
  };

  // 可选：绑定你自己的 GitHub 仓；技能不依赖远程安装，已由后端内嵌包注入
  const repoUrl = (c.env.AGENT_REPO_URL || "").trim();
  if (repoUrl && repoUrl.toLowerCase() !== "none") {
    payload.repos = [
      {
        url: repoUrl,
        startingRef: c.env.AGENT_REPO_REF || "main",
      },
    ];
  }

  if (c.env.AGENT_MODEL_ID) {
    payload.model = { id: c.env.AGENT_MODEL_ID };
  }

  const res = await fetch(`${CURSOR_API}/agents`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await safeJson(res);
  if (!res.ok) {
    return c.json(
      {
        error: "创建 Cloud Agent 失败",
        status: res.status,
        detail: redactDetail(data),
        hint: buildCreateHint(data, repoUrl),
      },
      res.status === 401 || res.status === 403 ? 401 : 502,
    );
  }

  const agent = (data as { agent?: { id?: string; url?: string; status?: string } })
    .agent;
  const run = (data as { run?: { id?: string; status?: string } }).run;

  if (!agent?.id || !run?.id) {
    return c.json({ error: "Cursor 返回缺少 agent/run id", detail: data }, 502);
  }

  return c.json({
    agentId: agent.id,
    runId: run.id,
    agentStatus: agent.status,
    runStatus: run.status,
    agentUrl: agent.url,
  });
});

/** 查询任务状态（需再次携带用户 Key；服务端不存 Key） */
app.get("/api/tasks/:agentId/:runId", async (c) => {
  const apiKey = readUserApiKey(c.req.header("x-cursor-api-key"));
  if (!apiKey) {
    return c.json({ error: "请提供 Cursor API Key（请求头 X-Cursor-Api-Key）" }, 401);
  }

  const { agentId, runId } = c.req.param();
  if (!agentId.startsWith("bc-") || !runId.startsWith("run-")) {
    return c.json({ error: "agentId 或 runId 格式不正确" }, 400);
  }

  const res = await fetch(
    `${CURSOR_API}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    {
      headers: { Authorization: basicAuth(apiKey) },
    },
  );

  const data = await safeJson(res);
  if (!res.ok) {
    return c.json(
      {
        error: "查询任务失败",
        status: res.status,
        detail: redactDetail(data),
      },
      res.status === 401 || res.status === 403 ? 401 : 502,
    );
  }

  const run = data as {
    id?: string;
    agentId?: string;
    status?: string;
    result?: string;
    durationMs?: number;
    updatedAt?: string;
  };

  return c.json({
    agentId: run.agentId || agentId,
    runId: run.id || runId,
    status: run.status,
    result: run.result ?? null,
    durationMs: run.durationMs ?? null,
    updatedAt: run.updatedAt ?? null,
    done: isTerminal(run.status),
  });
});

/** 取消进行中的 run */
app.post("/api/tasks/:agentId/:runId/cancel", async (c) => {
  const apiKey = readUserApiKey(c.req.header("x-cursor-api-key"));
  if (!apiKey) {
    return c.json({ error: "请提供 Cursor API Key（请求头 X-Cursor-Api-Key）" }, 401);
  }

  const { agentId, runId } = c.req.param();
  const res = await fetch(
    `${CURSOR_API}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { Authorization: basicAuth(apiKey) },
    },
  );

  const data = await safeJson(res);
  if (!res.ok) {
    return c.json(
      { error: "取消失败", status: res.status, detail: redactDetail(data) },
      502,
    );
  }

  return c.json({ ok: true, detail: data });
});

app.all("*", async (c) => {
  // 静态资源由 Assets 绑定处理
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

/** 组装任务提示：技能包只从本服务后端拉取（内嵌于 Worker），禁止从 GitHub/npm 安装 */
function buildTaskPrompt(skillUrl: string, userPrompt?: string): string {
  const parts = [
    "你是照片地理定位助手。",
    "",
    "## 硬性约束",
    "- **禁止** `git clone` / `npx skills` / 从 GitHub、npm 等第三方来源获取 geo-sleuth 或任何技能包。",
    "- 技能只能来自下方本服务后端提供的内嵌归档，并且必须通过 sha256 校验。",
    "- 依赖库（如 uv 按脚本头部声明安装）可以按 SKILL 正常安装。",
    "",
    "## 第一步：把内嵌技能写入工作区",
    "在工作目录执行下面这段命令（原样执行，一次即可）：",
    "",
    "```bash",
    "mkdir -p .agents/skills",
    `curl -fsSL "${skillUrl}" -o /tmp/geo-sleuth.tgz`,
    `echo "${SKILL_ARCHIVE_SHA256}  /tmp/geo-sleuth.tgz" | sha256sum -c -`,
    "tar -xzf /tmp/geo-sleuth.tgz -C .agents/skills",
    `export CLAUDE_SKILL_DIR="$PWD/${SKILL_ROOT_REL}"`,
    "test -f \"$CLAUDE_SKILL_DIR/SKILL.md\" && echo skill ready",
    "```",
    "",
    "若校验失败或下载失败，直接报告错误并停止，不要改用其他来源。",
    "",
    "## 云端环境说明（避免在自检上浪费时间）",
    "- 这是 Linux 容器，已有 google-chrome；**不要单独手动测试 Chrome**，直接跑 `intake.py` / `revimg.py`，失败再看报错。",
    "- Chrome 输出的 `dbus` / `Failed to connect to the bus` 报错是容器里的正常噪音，可以忽略。",
    "- 任何可能挂起的命令（浏览器、网络请求、模型下载）一律加 `timeout 120` 前缀，超时就换下一步，不要反复重试同一条。",
    "- `ocr.py` 在 Linux 会自动改用 RapidOCR；`match.py`、`sat_scan.py` 首次需要装 torch 和下载模型，很慢，只在前面的线索不够时才用。",
    "- 云端机器在海外，技能里标注「走代理」的来源（谷歌卫星图/街景、Yandex、HuggingFace）通常可以直连，不需要设置 `GEO_PROXY`；百度系来源若不通，在结论里注明即可。",
    "",
    "## 第二步：按技能分析附图",
    `1. 阅读 \`${SKILL_ROOT_REL}/SKILL.md\`，严格按其流程调用 \`scripts/\`（Python 3.10+、uv run）。`,
    "2. 找出拍摄地点（坐标 ± 误差半径、镜头朝向、置信度），说明关键证据与实际命令/产物。",
    "3. 推荐网上「几乎同一机位」同类照片：可打开链接、相似理由、相似程度。",
    "4. 无法精确定位时给候选区域与下一步，禁止编造坐标。",
    "",
    "请用简体中文回复，结构清晰。",
  ];

  if (userPrompt) {
    parts.push("", "## 用户补充说明", userPrompt);
  }

  return parts.join("\n");
}

function readUserApiKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim();
  if (!key || key.length < 10) return null;
  return key;
}

function basicAuth(apiKey: string): string {
  // Cursor Cloud Agents API：Basic，用户名为 API Key，密码为空
  const token = btoa(`${apiKey}:`);
  return `Basic ${token}`;
}

function isTerminal(status?: string): boolean {
  return ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(
    status || "",
  );
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** 避免把上游可能夹带的敏感字段原样回传 */
function redactDetail(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const copy = { ...(data as Record<string, unknown>) };
  for (const k of Object.keys(copy)) {
    if (/key|token|secret|authorization/i.test(k)) {
      copy[k] = "[已脱敏]";
    }
  }
  return copy;
}

/** 针对常见 Cloud Agent 创建失败给出可执行提示 */
function buildCreateHint(data: unknown, repoUrl: string): string | undefined {
  const raw = JSON.stringify(data || {});
  if (/Failed to verify existence of branch|validation_error/i.test(raw)) {
    if (repoUrl) {
      return "Cursor 无法校验该仓库分支。请把 AGENT_REPO_URL 改成你自己 GitHub 上、且已连接 Cursor 的仓库（需包含 .agents/skills/geo-sleuth），或设为 none 使用无仓库模式。";
    }
    return "仓库分支校验失败。请确认 Cursor 已连接 GitHub，或将 AGENT_REPO_URL 设为 none。";
  }
  if (/401|unauthorized|invalid.*key/i.test(raw)) {
    return "API Key 无效或无 Cloud Agent 权限，请到 Cursor Dashboard 重新创建 Key。";
  }
  return undefined;
}
