import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const sort = (value) => {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
};

export const stableJson = (value) => JSON.stringify(sort(value));
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map((entry) => {
      const [key, ...rest] = entry.replace(/^--/, "").split("=");
      return [key, rest.length ? rest.join("=") : true];
    }),
  );
}

export function writeBytesDurable(path, bytes, flag = "w") {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, flag);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeBytesDurable(temporary, `${stableJson(value)}\n`);
  renameSync(temporary, path);
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const fileSha256 = (path) => sha256(readFileSync(path));
export const fileBytes = (path) => statSync(path).size;

export async function waitForFile(path, timeoutMs, label = path) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return path;
    await sleep(25);
  }
  throw new Error(`TIMEOUT_WAITING_FOR:${label}`);
}

export const MARKER_PROTOCOL = "darwin.dbos-recovery-marker/v1";
export const RESULT_PROTOCOL = "darwin.dbos-durable-recovery-bakeoff-result/v1";
export const CLAIM_CEILING =
  "LOCAL_DISPOSABLE_DBOS_VS_SQLITE_CRASH_REPLAY_CANARY_ONLY_NOT_PRODUCTION_DURABILITY_NOT_EXACTLY_ONCE_NOT_ADOPTION_NOT_BENEFIT_NOT_AUTONOMY";

