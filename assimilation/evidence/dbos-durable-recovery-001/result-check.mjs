import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAIM_CEILING, RESULT_PROTOCOL, fileBytes, fileSha256, readJson, sha256, stableJson } from "./common.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const resultPath = join(root, "result.json");
const indexPath = join(root, "evidence-index.json");
const decisionPath = resolve(join(root, "..", "..", "dbos-durable-recovery-001.json"));
const result = readJson(resultPath);
const index = readJson(indexPath);
const decision = readJson(decisionPath);
const require = (condition, code) => {
  if (!condition) throw new Error(code);
};

require(result.protocol === RESULT_PROTOCOL, "RESULT_PROTOCOL_MISMATCH");
require(result.claim_ceiling === CLAIM_CEILING, "RESULT_CEILING_MISMATCH");
require(result.runs.length === 50, "RUN_COUNT_MISMATCH");
require(new Set(result.runs.map((row) => row.run_id)).size === 50, "RUN_ID_DUPLICATE");
require(result.input.darwin_tree === "2eaba3e1ca85919c9fcc02cdbdcbbb625215b1ae", "DARWIN_TREE_MISMATCH");
require(result.input.dbos_version === "4.27.6", "DBOS_VERSION_MISMATCH");
require(
  result.input.dbos_integrity ===
    "sha512-mr5CEllYovAHPh/TpQcvxTYM+4t4tgV7CjkZGe7hzNxw9Nzf6l7ggxJKDbewLFwgwx8NaWcWw21ESHXNE1UwrA==",
  "DBOS_INTEGRITY_MISMATCH",
);
require(
  result.input.postgres_image ===
    "postgres:16.11@sha256:ed5a1fad193768f89265c7c297999bab9aa116e82142f6e38bc33b8587b2f2da",
  "POSTGRES_IMAGE_MISMATCH",
);
require(result.summary.incumbent.runs === 25 && result.summary.dbos.runs === 25, "ARM_BALANCE_MISMATCH");
require(result.summary.dbos.hard_vetoes === 0, "DBOS_VETO_PRESENT");
require(result.summary.incumbent.hard_vetoes === 1, "INCUMBENT_VETO_COUNT_MISMATCH");
require(result.summary.incumbent.duplicate_markers === 0, "FALSE_DUPLICATE_MARKER_SUMMARY");
require(result.summary.dbos.duplicate_markers === 0, "DBOS_DUPLICATE_MARKER");
require(result.by_fault.F3.incumbent.hard_vetoes === 1, "F3_RESULT_MISSING");
require(result.by_fault.F3.dbos.hard_vetoes === 0, "DBOS_F3_VETO");
require(result.disposition === "CANARY_QUALIFIED_SHADOW_ONLY", "DISPOSITION_MISMATCH");
require(result.cleanup?.removed === true, "CONTAINER_CLEANUP_MISSING");

for (const row of result.runs) {
  require(row.provider?.created_count === 1, `PROVIDER_CREATE_COUNT:${row.run_id}`);
  require(row.provider?.marker_sha256, `PROVIDER_MARKER_MISSING:${row.run_id}`);
  require(
    sha256(Buffer.from(row.provider.marker_base64, "base64")) === row.provider.marker_sha256,
    `PROVIDER_MARKER_HASH:${row.run_id}`,
  );
  require(row.duplicate_marker === false, `DUPLICATE_MARKER:${row.run_id}`);
  if (row.status === "COMPLETED") require(row.marker_matches === true, `MARKER_MISMATCH:${row.run_id}`);
}
for (const fault of ["N", "F0", "F1", "F2", "F3"]) {
  for (let rep = 0; rep < 5; rep += 1) {
    const pair = result.runs.filter((row) => row.fault === fault && row.rep === rep);
    require(pair.length === 2, `PAIR_CARDINALITY:${fault}:${rep}`);
    require(new Set(pair.map((row) => row.arm)).size === 2, `PAIR_ARMS:${fault}:${rep}`);
    require(pair[0].pair_id === pair[1].pair_id, `PAIR_ID:${fault}:${rep}`);
    require(pair[0].provider.key === pair[1].provider.key, `PAIR_PROVIDER_KEY:${fault}:${rep}`);
    require(pair[0].provider.marker_sha256 === pair[1].provider.marker_sha256, `PAIR_MARKER:${fault}:${rep}`);
  }
}

require(index.protocol === "darwin.dbos-durable-recovery-evidence-index/v1", "INDEX_PROTOCOL");
require(index.entries.length === index.total_files, "INDEX_COUNT");
require(index.root_sha256 === sha256(stableJson(index.entries)), "INDEX_ROOT_HASH");
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const full = join(path, entry.name);
    if (entry.isDirectory()) return files(full);
    if ([resultPath, indexPath].includes(full)) return [];
    return [relative(root, full).replaceAll("\\", "/")];
  });
}
require(
  stableJson(index.entries.map((entry) => entry.path)) === stableJson(files(root).sort()),
  "INDEX_INCOMPLETE_OR_EXTRA",
);
let total = 0;
for (const entry of index.entries) {
  require(!entry.path.includes("..") && !entry.path.includes("node_modules"), `INDEX_PATH:${entry.path}`);
  const path = join(root, ...entry.path.split("/"));
  require(existsSync(path), `INDEX_MISSING:${entry.path}`);
  require(fileBytes(path) === entry.bytes && fileSha256(path) === entry.sha256, `INDEX_HASH:${entry.path}`);
  total += entry.bytes;
}
require(total === index.total_bytes, "INDEX_TOTAL_BYTES");
require(result.evidence_index.sha256 === fileSha256(indexPath), "RESULT_INDEX_HASH");
require(decision.evidence.result_sha256 === fileSha256(resultPath), "DECISION_RESULT_HASH");
require(decision.evidence.evidence_index_sha256 === fileSha256(indexPath), "DECISION_INDEX_HASH");
require(decision.decision.disposition === result.disposition, "DECISION_DISPOSITION");
require(decision.decision.adoption_status === "NOT_ADOPTED", "ADOPTION_STATUS");

const container = result.cleanup.container;
const remaining = execFileSync("docker", ["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"], {
  encoding: "utf8",
  timeout: 10_000,
}).trim();
require(remaining === "", "CANARY_CONTAINER_REMAINS");

console.log(
  JSON.stringify({
    status: "PASS",
    disposition: result.disposition,
    result_sha256: fileSha256(resultPath),
    index_sha256: fileSha256(indexPath),
    decision_sha256: fileSha256(decisionPath),
    runs: result.runs.length,
  }),
);
