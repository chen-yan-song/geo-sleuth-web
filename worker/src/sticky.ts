/** Per-API-key sticky Cloud Agent records in KV (never store raw keys). */

export type StickyStatus = "cold" | "warming" | "ready";

export type StickyAgent = {
  agentId: string;
  /** ISO time when env warmup finished successfully */
  warmedAt: string | null;
  /** ISO time of last analysis or warmup run start */
  lastRunAt: string | null;
  status: StickyStatus;
  /** Skill archive sha that was installed during warmup (if any) */
  skillSha256?: string | null;
  /** In-flight warmup run id while status === warming */
  warmupRunId?: string | null;
};

export type AgentPoolKv = {
  get(key: string, type: "json"): Promise<StickyAgent | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

const KV_PREFIX = "sticky:v1:";

export function stickyKey(keyHash: string): string {
  return `${KV_PREFIX}${keyHash}`;
}

/** SHA-256 hex of the API key — used as KV key material only. */
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function readSticky(
  kv: AgentPoolKv | undefined,
  keyHash: string,
): Promise<StickyAgent | null> {
  if (!kv) return null;
  try {
    return await kv.get(stickyKey(keyHash), "json");
  } catch {
    return null;
  }
}

export async function writeSticky(
  kv: AgentPoolKv | undefined,
  keyHash: string,
  record: StickyAgent,
): Promise<void> {
  if (!kv) return;
  await kv.put(stickyKey(keyHash), JSON.stringify(record));
}

export async function clearSticky(
  kv: AgentPoolKv | undefined,
  keyHash: string,
): Promise<void> {
  if (!kv) return;
  await kv.delete(stickyKey(keyHash));
}

export function agentUrl(agentId: string): string {
  return `https://cursor.com/agents/${agentId}`;
}
