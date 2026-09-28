/**
 * 将 .agents/skills/geo-sleuth 打包为 Worker 内嵌 base64（gzip tar）
 * 运行：node scripts/pack-skill.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(root, ".agents/skills/geo-sleuth");
const outDir = join(root, "worker/src/generated");
const outFile = join(outDir, "skill-archive.ts");
const tmpTar = join(root, ".wrangler/geo-sleuth-skill.tgz");

if (!existsSync(skillDir)) {
  console.error("缺少技能目录：", skillDir);
  process.exit(1);
}

mkdirSync(dirname(tmpTar), { recursive: true });
mkdirSync(outDir, { recursive: true });

execFileSync(
  "tar",
  ["-czf", tmpTar, "-C", join(root, ".agents/skills"), "geo-sleuth"],
  { stdio: "inherit" },
);

const buf = readFileSync(tmpTar);
const b64 = buf.toString("base64");
const bytes = buf.length;

const source = `/* eslint-disable */
// 由 scripts/pack-skill.mjs 自动生成，请勿手改
export const SKILL_ARCHIVE_BASE64 = ${JSON.stringify(b64)};
export const SKILL_ARCHIVE_BYTES = ${bytes};
export const SKILL_ROOT_REL = ".agents/skills/geo-sleuth";
`;

writeFileSync(outFile, source, "utf8");
console.info(
  `已生成 ${outFile}（tar.gz ${bytes} 字节，base64 ${b64.length} 字符）`,
);
