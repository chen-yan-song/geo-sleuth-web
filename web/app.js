const els = {
  apiKey: document.getElementById("apiKey"),
  rememberKey: document.getElementById("rememberKey"),
  prompt: document.getElementById("prompt"),
  file: document.getElementById("file"),
  dropzone: document.getElementById("dropzone"),
  preview: document.getElementById("preview"),
  submit: document.getElementById("submit"),
  warmup: document.getElementById("warmup"),
  cancel: document.getElementById("cancel"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  meta: document.getElementById("meta"),
  result: document.getElementById("result"),
  poolNote: document.getElementById("poolNote"),
};

const KEY_STORAGE = "geo-sleuth-web:api-key";
const TASK_STORAGE = "geo-sleuth-web:last-task";

/** @type {{ base64: string, mimeType: string } | null} */
let selectedImage = null;
/** @type {{ agentId: string, runId: string, agentUrl?: string, kind?: string } | null} */
let currentTask = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

init();

function init() {
  const saved = sessionStorage.getItem(KEY_STORAGE);
  if (saved) {
    els.apiKey.value = saved;
    els.rememberKey.checked = true;
  }

  const last = sessionStorage.getItem(TASK_STORAGE);
  if (last) {
    try {
      currentTask = JSON.parse(last);
      if (currentTask?.agentId && currentTask?.runId && els.apiKey.value) {
        showMeta(currentTask);
        setStatus("running", "恢复上次任务轮询…");
        startPolling();
      }
    } catch {
      sessionStorage.removeItem(TASK_STORAGE);
    }
  }

  els.dropzone.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", () => {
    const f = els.file.files?.[0];
    if (f) void loadFile(f);
  });

  ["dragenter", "dragover"].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });

  els.apiKey.addEventListener("input", () => {
    syncSubmit();
    void refreshPoolNote();
  });
  els.submit.addEventListener("click", () => void onSubmit());
  els.warmup.addEventListener("click", () => void onWarmup());
  els.cancel.addEventListener("click", () => void onCancel());
  els.rememberKey.addEventListener("change", () => {
    if (!els.rememberKey.checked) sessionStorage.removeItem(KEY_STORAGE);
    else if (els.apiKey.value.trim()) {
      sessionStorage.setItem(KEY_STORAGE, els.apiKey.value.trim());
    }
  });

  syncSubmit();
  void refreshPoolNote();
}

function syncSubmit() {
  const hasKey = Boolean(els.apiKey.value.trim());
  els.submit.disabled = !(hasKey && selectedImage);
  els.warmup.disabled = !hasKey;
}

async function loadFile(file) {
  if (!file.type.startsWith("image/")) {
    setStatus("error", "请选择图片文件");
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    setStatus("error", "图片过大，请压缩到约 10MB 以内");
    return;
  }

  const dataUrl = await readAsDataURL(file);
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mimeType = mimeMatch?.[1] || file.type;

  selectedImage = { base64, mimeType };
  els.preview.src = dataUrl;
  els.preview.hidden = false;
  setStatus("idle", `已选择：${file.name}`);
  syncSubmit();
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function onSubmit() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey || !selectedImage) return;

  if (els.rememberKey.checked) {
    sessionStorage.setItem(KEY_STORAGE, apiKey);
  } else {
    sessionStorage.removeItem(KEY_STORAGE);
  }

  stopPolling();
  els.submit.disabled = true;
  els.warmup.disabled = true;
  els.cancel.disabled = false;
  setStatus("running", "正在创建 / 复用 Cloud Agent…");
  els.result.classList.remove("empty");
  els.result.textContent = "任务已提交，等待 Cursor Cloud Agent 回复…";

  try {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cursor-Api-Key": apiKey,
      },
      body: JSON.stringify({
        prompt: els.prompt.value.trim() || undefined,
        imageBase64: selectedImage.base64,
        mimeType: selectedImage.mimeType,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(formatError(data));
    }

    currentTask = {
      agentId: data.agentId,
      runId: data.runId,
      agentUrl: data.agentUrl,
      kind: "analyze",
      reused: Boolean(data.reused),
      warm: Boolean(data.warm),
    };
    sessionStorage.setItem(TASK_STORAGE, JSON.stringify(currentTask));
    showMeta(currentTask);
    const reuseHint = data.reused
      ? data.warm
        ? "（复用暖机 Agent）"
        : "（复用 sticky Agent）"
      : "（新建 Agent）";
    setStatus("running", `运行中：${data.runStatus || "CREATING"} ${reuseHint}`);
    startPolling();
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
    els.result.textContent = "创建失败，请检查 API Key、网络或 Cursor 配额。";
    els.cancel.disabled = true;
    syncSubmit();
  }
}

async function onWarmup() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) return;

  if (els.rememberKey.checked) {
    sessionStorage.setItem(KEY_STORAGE, apiKey);
  }

  stopPolling();
  els.submit.disabled = true;
  els.warmup.disabled = true;
  els.cancel.disabled = false;
  setStatus("running", "正在预热环境…");
  els.result.classList.remove("empty");
  els.result.textContent =
    "预热：拉取 skill.tgz、安装 pillow / playwright / RapidOCR（不做照片分析）…";

  try {
    const res = await fetch("/api/warmup", {
      method: "POST",
      headers: { "X-Cursor-Api-Key": apiKey },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(formatError(data));
    }

    if (data.alreadyWarm) {
      setStatus("done", "环境已预热，可直接开始分析");
      els.result.textContent = `已暖机 Agent：${data.agentId}\n后续分析任务将复用此 Agent（完整 geo-sleuth 流程，不砍步骤）。`;
      showMeta({
        agentId: data.agentId,
        runId: "(already warm)",
        agentUrl: data.agentUrl,
        kind: "warmup",
        reused: true,
        warm: true,
      });
      els.cancel.disabled = true;
      syncSubmit();
      void refreshPoolNote();
      return;
    }

    currentTask = {
      agentId: data.agentId,
      runId: data.runId,
      agentUrl: data.agentUrl,
      kind: "warmup",
      reused: Boolean(data.reused),
    };
    sessionStorage.setItem(TASK_STORAGE, JSON.stringify(currentTask));
    showMeta(currentTask);
    setStatus(
      "running",
      `预热运行中：${data.runStatus || "CREATING"}${data.reused ? "（复用 Agent）" : "（新建 Agent）"}`,
    );
    startPolling();
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
    els.result.textContent = "预热失败。若提示未配置 KV，需先部署 AGENT_POOL 绑定。";
    els.cancel.disabled = true;
    syncSubmit();
  }
}

function startPolling() {
  stopPolling();
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), 4000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce() {
  if (!currentTask || currentTask.runId === "(already warm)") return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("error", "轮询需要 API Key");
    stopPolling();
    return;
  }

  try {
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(currentTask.agentId)}/${encodeURIComponent(currentTask.runId)}`,
      { headers: { "X-Cursor-Api-Key": apiKey } },
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(formatError(data));
    }

    const isWarmup = currentTask.kind === "warmup";
    setStatus(
      data.done
        ? data.status === "FINISHED"
          ? "done"
          : "error"
        : "running",
      isWarmup ? `预热状态：${data.status}` : `状态：${data.status}`,
    );

    if (data.result) {
      els.result.classList.remove("empty");
      els.result.textContent = data.result;
    } else if (!data.done) {
      els.result.textContent = isWarmup
        ? "正在预装依赖（可能需数分钟）。完成后即可用同一 Agent 做完整分析。"
        : "Cloud Agent 仍在分析中（可能较久）。可在 Cursor Agents 页面查看实时进度。";
    }

    if (data.done) {
      stopPolling();
      els.cancel.disabled = true;
      syncSubmit();
      void refreshPoolNote();
      if (data.status === "FINISHED" && isWarmup && !data.result) {
        els.result.textContent =
          "预热完成。后续「开始分析」将复用此暖机 Agent（完整技能流程）。";
      }
      if (data.status !== "FINISHED" && !data.result) {
        els.result.textContent = `任务结束：${data.status}`;
      }
    }
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  }
}

async function onCancel() {
  if (!currentTask || currentTask.runId === "(already warm)") return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) return;

  els.cancel.disabled = true;
  try {
    await fetch(
      `/api/tasks/${encodeURIComponent(currentTask.agentId)}/${encodeURIComponent(currentTask.runId)}/cancel`,
      {
        method: "POST",
        headers: { "X-Cursor-Api-Key": apiKey },
      },
    );
    setStatus("error", "已请求取消");
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  } finally {
    stopPolling();
    syncSubmit();
    void refreshPoolNote();
  }
}

async function refreshPoolNote() {
  if (!els.poolNote) return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    els.poolNote.dataset.state = "";
    els.poolNote.textContent =
      "可选：先点「预热环境」安装 skill + pillow/playwright/RapidOCR；之后分析任务会跟进到同一 Agent。";
    return;
  }
  try {
    const res = await fetch("/api/pool", {
      headers: { "X-Cursor-Api-Key": apiKey },
    });
    const data = await res.json();
    if (!data.kvConfigured) {
      els.poolNote.dataset.state = "cold";
      els.poolNote.textContent =
        "当前部署未绑定 AGENT_POOL KV：每次任务仍会新建 Agent。部署 KV 后即可暖机复用。";
      return;
    }
    if (!data.sticky) {
      els.poolNote.dataset.state = "cold";
      els.poolNote.textContent =
        "尚无 sticky Agent。可先「预热环境」，或直接分析（首次会创建并记住 Agent）。";
      return;
    }
    const s = data.sticky;
    els.poolNote.dataset.state = s.status || "cold";
    if (s.status === "ready" && s.warmedAt) {
      els.poolNote.textContent = `暖机就绪 · ${s.agentId} · 后续分析将复用此 Agent（完整流程）。`;
    } else if (s.status === "warming") {
      els.poolNote.textContent = `正在预热 · ${s.agentId} …`;
    } else {
      els.poolNote.textContent = `已绑定 sticky Agent · ${s.agentId}（尚未完成预热；首次分析也会在该机上安装依赖）。`;
    }
  } catch {
    // ignore — pool is best-effort UX
  }
}

function showMeta(task) {
  els.meta.hidden = false;
  const link = task.agentUrl
    ? `<a href="${escapeHtml(task.agentUrl)}" target="_blank" rel="noreferrer">在 Cursor 打开 Agent</a>`
    : "";
  const flags = [];
  if (task.kind === "warmup") flags.push("预热");
  if (task.reused) flags.push("复用");
  if (task.warm) flags.push("已暖机");
  const flagLine = flags.length
    ? `<br />标记：${flags.map((f) => escapeHtml(f)).join(" · ")}`
    : "";
  els.meta.innerHTML = `
    agentId: <code>${escapeHtml(task.agentId)}</code><br />
    runId: <code>${escapeHtml(task.runId)}</code>
    ${flagLine}
    ${link ? `<br />${link}` : ""}
  `;
}

function setStatus(state, text) {
  els.statusDot.dataset.state = state;
  els.statusText.textContent = text;
}

function formatError(data) {
  if (!data) return "未知错误";
  const parts = [];
  if (typeof data.error === "string") parts.push(data.error);
  if (typeof data.hint === "string" && data.hint) parts.push(data.hint);
  if (data.detail && typeof data.detail === "object") {
    parts.push(JSON.stringify(data.detail).slice(0, 280));
  }
  if (parts.length) return parts.join(" · ");
  return JSON.stringify(data).slice(0, 280);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
