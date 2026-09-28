import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  SKILL_ARCHIVE_BASE64,
  SKILL_ARCHIVE_BYTES,
  SKILL_ROOT_REL,
} from "./generated/skill-archive";

type Env = {
  ASSETS: Fetcher;
  AGENT_REPO_URL: string;
  AGENT_REPO_REF: string;
  AGENT_MODEL_ID?: string;
};

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
    skillRoot: SKILL_ROOT_REL,
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
  const text = buildTaskPrompt(userPrompt);

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

/** 组装任务提示：内嵌技能包写入工作区，禁止远程下载/安装技能 */
function buildTaskPrompt(userPrompt?: string): string {
  const parts = [
    "你是照片地理定位助手。",
    "",
    "## 硬性约束",
    "- **禁止** `git clone` / `npx skills` / curl/wget 下载 geo-sleuth 或任何技能包。",
    "- **禁止** 访问 GitHub/npm 去安装本技能。技能只能来自下方后端内嵌归档。",
    "- 依赖库（如 uv 按脚本头部声明安装）可以按 SKILL 正常安装；但技能源码本身不得远程获取。",
    "",
    "## 第一步：把内嵌技能写入工作区",
    "在仓库根目录执行（一次性）：",
    "",
    "```bash",
    "python3 <<'PY'",
    "import base64, io, tarfile, pathlib",
    `blob = base64.b64decode('${SKILL_ARCHIVE_BASE64}')`,
    "root = pathlib.Path('.agents/skills')",
    "root.mkdir(parents=True, exist_ok=True)",
    "with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as tf:",
    "    tf.extractall(path=root)",
    "print('skill ready:', (root / 'geo-sleuth' / 'SKILL.md').resolve())",
    "PY",
    `export CLAUDE_SKILL_DIR="$PWD/${SKILL_ROOT_REL}"`,
    "test -f \"$CLAUDE_SKILL_DIR/SKILL.md\"",
    "```",
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
