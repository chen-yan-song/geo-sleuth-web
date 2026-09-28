import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  SKILL_ARCHIVE_BASE64,
  SKILL_ARCHIVE_BYTES,
  SKILL_ARCHIVE_SHA256,
  SKILL_ROOT_REL,
} from "./generated/skill-archive";
import {
  type AgentPoolKv,
  type StickyAgent,
  agentUrl,
  clearSticky,
  hashApiKey,
  readSticky,
  writeSticky,
} from "./sticky";

type Env = {
  ASSETS: Fetcher;
  /** Optional KV for per-key sticky / warm Cloud Agents */
  AGENT_POOL?: AgentPoolKv;
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
    agentPoolKv: Boolean(c.env.AGENT_POOL),
    warmPool: Boolean(c.env.AGENT_POOL),
  }),
);

/**
 * Sticky / warm pool status for the caller's API key.
 * Without a key: only reports whether KV is bound (no agent ids).
 */
app.get("/api/pool", async (c) => {
  const kvConfigured = Boolean(c.env.AGENT_POOL);
  const apiKey = readUserApiKey(c.req.header("x-cursor-api-key"));
  if (!apiKey) {
    return c.json({
      kvConfigured,
      sticky: null,
      hint: kvConfigured
        ? "提供 X-Cursor-Api-Key 可查看你的 sticky agent 状态"
        : "未绑定 AGENT_POOL KV；每次任务仍会新建 Agent",
    });
  }

  if (!kvConfigured) {
    return c.json({
      kvConfigured: false,
      sticky: null,
      hint: "未绑定 AGENT_POOL KV；无法跨请求复用 Agent",
    });
  }

  const keyHash = await hashApiKey(apiKey);
  let sticky = await readSticky(c.env.AGENT_POOL, keyHash);
  if (sticky) {
    sticky = await reconcileSticky(c.env, apiKey, keyHash, sticky);
  }

  return c.json({
    kvConfigured: true,
    sticky: sticky
      ? {
          agentId: sticky.agentId,
          status: sticky.status,
          warmedAt: sticky.warmedAt,
          lastRunAt: sticky.lastRunAt,
          skillSha256: sticky.skillSha256 ?? null,
          agentUrl: agentUrl(sticky.agentId),
        }
      : null,
  });
});

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

/**
 * 预热：确保该 API Key 有 sticky Agent，并跑一次仅安装依赖的短任务（不做照片分析）。
 * 返回 agentId/runId，前端可轮询 /api/tasks/...；结束后再调 GET /api/pool 会把 status 标为 ready。
 */
app.post("/api/warmup", async (c) => {
  const apiKey = readUserApiKey(c.req.header("x-cursor-api-key"));
  if (!apiKey) {
    return c.json({ error: "请提供 Cursor API Key（请求头 X-Cursor-Api-Key）" }, 401);
  }

  if (!c.env.AGENT_POOL) {
    return c.json(
      {
        error: "未配置 AGENT_POOL KV，无法持久化暖机 Agent",
        hint: "请在 wrangler.toml 绑定 KV 后重新部署",
      },
      503,
    );
  }

  const baseUrl = (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(
    /\/+$/,
    "",
  );
  const keyHash = await hashApiKey(apiKey);
  let sticky = await readSticky(c.env.AGENT_POOL, keyHash);
  if (sticky) {
    sticky = await reconcileSticky(c.env, apiKey, keyHash, sticky);
  }

  if (
    sticky?.status === "ready" &&
    sticky.warmedAt &&
    sticky.skillSha256 === SKILL_ARCHIVE_SHA256
  ) {
    return c.json({
      ok: true,
      alreadyWarm: true,
      agentId: sticky.agentId,
      agentUrl: agentUrl(sticky.agentId),
      warmedAt: sticky.warmedAt,
      reused: true,
    });
  }

  const warmupText = buildWarmupPrompt(`${baseUrl}/skill.tgz`);

  // Prefer follow-up on existing sticky agent
  if (sticky?.agentId) {
    const follow = await createFollowUpRun(apiKey, sticky.agentId, {
      text: warmupText,
    });
    if (follow.ok && follow.runId) {
      const now = new Date().toISOString();
      await writeSticky(c.env.AGENT_POOL, keyHash, {
        ...sticky,
        status: "warming",
        lastRunAt: now,
        warmupRunId: follow.runId,
        skillSha256: SKILL_ARCHIVE_SHA256,
      });
      return c.json({
        ok: true,
        alreadyWarm: false,
        agentId: sticky.agentId,
        runId: follow.runId,
        runStatus: follow.runStatus,
        agentUrl: agentUrl(sticky.agentId),
        reused: true,
      });
    }
    if (follow.busy) {
      return c.json(
        {
          error: "sticky Agent 正忙，请等当前任务结束后再预热",
          status: 409,
          agentId: sticky.agentId,
          agentUrl: agentUrl(sticky.agentId),
        },
        409,
      );
    }
    // Agent gone / failed → clear and create fresh
    await clearSticky(c.env.AGENT_POOL, keyHash);
  }

  const created = await createFreshAgent(c.env, apiKey, {
    text: warmupText,
  });
  if (!created.ok) {
    return c.json(
      {
        error: "创建预热 Agent 失败",
        status: created.status,
        detail: created.detail,
        hint: created.hint,
      },
      created.status === 401 || created.status === 403 ? 401 : 502,
    );
  }

  const now = new Date().toISOString();
  await writeSticky(c.env.AGENT_POOL, keyHash, {
    agentId: created.agentId!,
    warmedAt: null,
    lastRunAt: now,
    status: "warming",
    skillSha256: SKILL_ARCHIVE_SHA256,
    warmupRunId: created.runId!,
  });

  return c.json({
    ok: true,
    alreadyWarm: false,
    agentId: created.agentId,
    runId: created.runId,
    runStatus: created.runStatus,
    agentStatus: created.agentStatus,
    agentUrl: created.agentUrl || agentUrl(created.agentId!),
    reused: false,
  });
});

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
  const baseUrl = (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(
    /\/+$/,
    "",
  );
  const text = buildTaskPrompt(`${baseUrl}/skill.tgz`, userPrompt);
  const images = [
    {
      data: body.imageBase64,
      mimeType: body.mimeType,
    },
  ];

  const keyHash = c.env.AGENT_POOL ? await hashApiKey(apiKey) : null;
  let sticky =
    keyHash && c.env.AGENT_POOL
      ? await readSticky(c.env.AGENT_POOL, keyHash)
      : null;
  if (sticky && keyHash) {
    sticky = await reconcileSticky(c.env, apiKey, keyHash, sticky);
  }

  // --- Reuse sticky agent via follow-up run ---
  if (sticky?.agentId && keyHash) {
    const follow = await createFollowUpRun(apiKey, sticky.agentId, {
      text,
      images,
    });
    if (follow.ok && follow.runId) {
      const now = new Date().toISOString();
      await writeSticky(c.env.AGENT_POOL, keyHash, {
        ...sticky,
        lastRunAt: now,
        // keep warmed status; full task also installs deps if cold
        status: sticky.warmedAt ? sticky.status : sticky.status,
      });
      return c.json({
        agentId: sticky.agentId,
        runId: follow.runId,
        agentStatus: sticky.status,
        runStatus: follow.runStatus,
        agentUrl: agentUrl(sticky.agentId),
        reused: true,
        warm: Boolean(sticky.warmedAt),
      });
    }
    if (follow.busy) {
      return c.json(
        {
          error: "你的暖机 Agent 正在执行其他任务，请等待结束后再提交，或取消当前任务",
          status: 409,
          agentId: sticky.agentId,
          agentUrl: agentUrl(sticky.agentId),
          hint: "同一 API Key 复用单个 sticky Agent；并发任务会冲突（agent_busy）",
        },
        409,
      );
    }
    // create-run failed (expired/gone) → clear and fall through to fresh create
    await clearSticky(c.env.AGENT_POOL, keyHash);
    sticky = null;
  }

  // --- Fresh agent ---
  const created = await createFreshAgent(c.env, apiKey, { text, images });
  if (!created.ok) {
    return c.json(
      {
        error: "创建 Cloud Agent 失败",
        status: created.status,
        detail: created.detail,
        hint: created.hint,
      },
      created.status === 401 || created.status === 403 ? 401 : 502,
    );
  }

  if (keyHash && c.env.AGENT_POOL) {
    const now = new Date().toISOString();
    await writeSticky(c.env.AGENT_POOL, keyHash, {
      agentId: created.agentId!,
      warmedAt: null,
      lastRunAt: now,
      status: "cold",
      skillSha256: null,
      warmupRunId: null,
    });
  }

  return c.json({
    agentId: created.agentId,
    runId: created.runId,
    agentStatus: created.agentStatus,
    runStatus: created.runStatus,
    agentUrl: created.agentUrl,
    reused: false,
    warm: false,
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

  // If this run was a warmup and finished, mark sticky ready
  if (c.env.AGENT_POOL && isTerminal(run.status)) {
    const keyHash = await hashApiKey(apiKey);
    const sticky = await readSticky(c.env.AGENT_POOL, keyHash);
    if (
      sticky &&
      sticky.agentId === agentId &&
      sticky.warmupRunId === runId &&
      sticky.status === "warming"
    ) {
      const now = new Date().toISOString();
      if (run.status === "FINISHED") {
        await writeSticky(c.env.AGENT_POOL, keyHash, {
          ...sticky,
          status: "ready",
          warmedAt: now,
          warmupRunId: null,
          skillSha256: SKILL_ARCHIVE_SHA256,
        });
      } else {
        await writeSticky(c.env.AGENT_POOL, keyHash, {
          ...sticky,
          status: sticky.warmedAt ? "ready" : "cold",
          warmupRunId: null,
        });
      }
    }
  }

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

// ---------------------------------------------------------------------------
// Cursor API helpers
// ---------------------------------------------------------------------------

type PromptPayload = {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
};

type CreateResult = {
  ok: boolean;
  status?: number;
  detail?: unknown;
  hint?: string;
  agentId?: string;
  runId?: string;
  agentStatus?: string;
  runStatus?: string;
  agentUrl?: string;
};

async function createFreshAgent(
  env: Env,
  apiKey: string,
  prompt: PromptPayload,
): Promise<CreateResult> {
  const payload: Record<string, unknown> = {
    name: "geo-sleuth-web",
    prompt: {
      text: prompt.text,
      ...(prompt.images ? { images: prompt.images } : {}),
    },
    autoCreatePR: false,
  };

  const repoUrl = (env.AGENT_REPO_URL || "").trim();
  if (repoUrl && repoUrl.toLowerCase() !== "none") {
    payload.repos = [
      {
        url: repoUrl,
        startingRef: env.AGENT_REPO_REF || "main",
      },
    ];
  }

  if (env.AGENT_MODEL_ID) {
    payload.model = { id: env.AGENT_MODEL_ID };
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
    return {
      ok: false,
      status: res.status,
      detail: redactDetail(data),
      hint: buildCreateHint(data, repoUrl),
    };
  }

  const agent = (data as { agent?: { id?: string; url?: string; status?: string } })
    .agent;
  const run = (data as { run?: { id?: string; status?: string } }).run;

  if (!agent?.id || !run?.id) {
    return {
      ok: false,
      status: 502,
      detail: data,
      hint: "Cursor 返回缺少 agent/run id",
    };
  }

  return {
    ok: true,
    agentId: agent.id,
    runId: run.id,
    agentStatus: agent.status,
    runStatus: run.status,
    agentUrl: agent.url || agentUrl(agent.id),
  };
}

type FollowUpResult = {
  ok: boolean;
  busy?: boolean;
  runId?: string;
  runStatus?: string;
  status?: number;
  detail?: unknown;
};

async function createFollowUpRun(
  apiKey: string,
  agentId: string,
  prompt: PromptPayload,
): Promise<FollowUpResult> {
  const res = await fetch(
    `${CURSOR_API}/agents/${encodeURIComponent(agentId)}/runs`,
    {
      method: "POST",
      headers: {
        Authorization: basicAuth(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: {
          text: prompt.text,
          ...(prompt.images ? { images: prompt.images } : {}),
        },
      }),
    },
  );

  const data = await safeJson(res);
  if (res.status === 409) {
    return { ok: false, busy: true, status: 409, detail: redactDetail(data) };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, detail: redactDetail(data) };
  }

  const run = (data as { run?: { id?: string; status?: string } }).run;
  // Some responses may return the run at top level
  const runId = run?.id || (data as { id?: string }).id;
  const runStatus = run?.status || (data as { status?: string }).status;
  if (!runId) {
    return { ok: false, status: 502, detail: data };
  }
  return { ok: true, runId, runStatus };
}

/** Verify sticky agent still accepts runs; clear if archived/gone. */
async function reconcileSticky(
  env: Env,
  apiKey: string,
  keyHash: string,
  sticky: StickyAgent,
): Promise<StickyAgent | null> {
  const res = await fetch(
    `${CURSOR_API}/agents/${encodeURIComponent(sticky.agentId)}`,
    { headers: { Authorization: basicAuth(apiKey) } },
  );
  if (res.status === 404 || res.status === 410) {
    await clearSticky(env.AGENT_POOL, keyHash);
    return null;
  }
  if (!res.ok) {
    // Transient error — keep sticky, don't clear
    return sticky;
  }

  const data = (await safeJson(res)) as { status?: string; id?: string };
  if (data.status === "ARCHIVED") {
    await clearSticky(env.AGENT_POOL, keyHash);
    return null;
  }

  // If warming, check warmup run terminal state
  if (sticky.status === "warming" && sticky.warmupRunId) {
    const runRes = await fetch(
      `${CURSOR_API}/agents/${encodeURIComponent(sticky.agentId)}/runs/${encodeURIComponent(sticky.warmupRunId)}`,
      { headers: { Authorization: basicAuth(apiKey) } },
    );
    if (runRes.ok) {
      const run = (await safeJson(runRes)) as { status?: string };
      if (run.status === "FINISHED") {
        const updated: StickyAgent = {
          ...sticky,
          status: "ready",
          warmedAt: new Date().toISOString(),
          warmupRunId: null,
          skillSha256: SKILL_ARCHIVE_SHA256,
        };
        await writeSticky(env.AGENT_POOL, keyHash, updated);
        return updated;
      }
      if (isTerminal(run.status)) {
        const updated: StickyAgent = {
          ...sticky,
          status: sticky.warmedAt ? "ready" : "cold",
          warmupRunId: null,
        };
        await writeSticky(env.AGENT_POOL, keyHash, updated);
        return updated;
      }
    }
  }

  return sticky;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

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
    "在工作目录执行下面这段命令（原样执行，一次即可；若目录已存在且校验通过可跳过下载）：",
    "",
    "```bash",
    "mkdir -p .agents/skills",
    `if [ ! -f "$PWD/${SKILL_ROOT_REL}/SKILL.md" ]; then`,
    `  curl -fsSL --max-time 60 "${skillUrl}" -o /tmp/geo-sleuth.tgz`,
    `  echo "${SKILL_ARCHIVE_SHA256}  /tmp/geo-sleuth.tgz" | sha256sum -c -`,
    "  tar -xzf /tmp/geo-sleuth.tgz -C .agents/skills",
    "fi",
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
    "- 所有 `curl` 必须带 `--max-time 20`；`wget` 必须带 `--timeout=20`；Python 里的网络请求必须设置 `timeout=20`。",
    "- `ocr.py` 在 Linux 会自动改用 RapidOCR；`match.py`、`sat_scan.py` 首次需要装 torch 和下载模型，很慢，只在前面的线索不够时才用。",
    "- 云端机器在海外，技能里标注「走代理」的来源（谷歌卫星图/街景、Yandex、HuggingFace）通常可以直连，不需要设置 `GEO_PROXY`；百度系来源若不通，在结论里注明即可。",
    "",
    "## 第二步：按技能分析附图",
    `1. 阅读 \`${SKILL_ROOT_REL}/SKILL.md\`，严格按其流程调用 \`scripts/\`（Python 3.10+、uv run）。`,
    "2. 找出拍摄地点（坐标 ± 误差半径、镜头朝向、置信度），说明关键证据与实际命令/产物。",
    "3. 推荐网上「几乎同一机位」同类照片：可打开链接、相似理由、相似程度。",
    "4. 无法精确定位时给候选区域与下一步，禁止编造坐标。",
    "",
    "## 提速规则（优先级高于技能里的可选步骤）",
    "- 目标是 5 分钟内交付结论。先跑 `intake.py`，以图搜图或文字识别已经指向唯一地标时，立即以它为锚点闭环，不再扩大搜索。",
    "- **室内照片**（楼梯、大厅、走廊、展厅等）找到地标后，**不做**卫星图扫描、穹顶/建筑轮廓拟合、地形高程、太阳方位分析；坐标用该地标的地理编码结果，误差半径按建筑尺度给出，镜头朝向写「室内，无法按地理方位确定」或只给画面内的相对朝向。",
    "- 室外照片只在锚点不唯一时才用 `sat_scan.py` / `match.py`；已有唯一锚点时最多做一次几何核对。",
    "- 同机位推荐：从以图搜图结果和网页搜索里挑 3 到 5 条**可打开的链接**，根据缩略图和页面描述判断相似度即可，**不要**逐张下载原图做比对。",
    "- 单个步骤连续两次没有进展就放弃该步骤，在结论里注明「未核实」，继续往下走。",
    "",
    "## 输出格式",
    "1. **拍摄地点**：地名、坐标、误差半径、置信度（高/中/低）",
    "2. **镜头朝向**",
    "3. **关键证据**：每条对应实际运行过的命令或产物",
    "4. **同机位推荐**：链接、相似理由、相似程度",
    "5. **未核实项与下一步**",
    "",
    "请用简体中文回复，结构清晰。",
  ];

  if (userPrompt) {
    parts.push("", "## 用户补充说明", userPrompt);
  }

  return parts.join("\n");
}

/** 仅预装 intake 常用依赖，不做任何照片分析 */
function buildWarmupPrompt(skillUrl: string): string {
  return [
    "这是环境预热任务，不是照片分析。不要分析任何图片，不要调用 sat_scan / match / torch。",
    "",
    "## 目标",
    "把 geo-sleuth 技能解压到工作区，并预装 intake 常用依赖（pillow、playwright、rapidocr-onnxruntime），确认可 import。",
    "",
    "## 步骤（按顺序执行，完成后用简体中文汇报每步结果）",
    "",
    "1. 安装技能：",
    "```bash",
    "mkdir -p .agents/skills",
    `curl -fsSL --max-time 60 "${skillUrl}" -o /tmp/geo-sleuth.tgz`,
    `echo "${SKILL_ARCHIVE_SHA256}  /tmp/geo-sleuth.tgz" | sha256sum -c -`,
    "tar -xzf /tmp/geo-sleuth.tgz -C .agents/skills",
    `export CLAUDE_SKILL_DIR="$PWD/${SKILL_ROOT_REL}"`,
    "test -f \"$CLAUDE_SKILL_DIR/SKILL.md\" && echo skill ready",
    "```",
    "",
    "2. 预装 / 校验依赖（允许联网下载 wheel；单步 timeout 180）：",
    "```bash",
    `export CLAUDE_SKILL_DIR="$PWD/${SKILL_ROOT_REL}"`,
    `timeout 180 uv run --with pillow --with rapidocr-onnxruntime --with playwright python -c "from PIL import Image; import rapidocr_onnxruntime; import playwright; print('imports-ok')"`,
    `timeout 120 uv run --with playwright playwright install chromium || echo 'playwright-install-skip (cloud may already have chrome)'`,
    "```",
    "",
    "3. 用技能脚本做一次无图冒烟（只验证脚本能启动，不要搜图）：",
    "```bash",
    `export CLAUDE_SKILL_DIR="$PWD/${SKILL_ROOT_REL}"`,
    `timeout 60 uv run "$CLAUDE_SKILL_DIR/scripts/intake.py" --help | head -20 || true`,
    "```",
    "",
    "## 输出",
    "简短列出：skill ready / imports-ok / 失败原因。不要扩展成完整定位流程。",
  ].join("\n");
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
