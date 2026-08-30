import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { fileBytes, fileSha256, readJson, sha256, stableJson } from "./common.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const label = "heldout-f3-postrepair";
const resultPath = join(root, `${label}-result.json`);
const decisionPath = join(root, `${label}-decision.json`);
const indexPath = join(root, `${label}-evidence-index.json`);
const runsRoot = join(root, `${label}-runs`);
const result = readJson(resultPath);
const decision = readJson(decisionPath);
const index = readJson(indexPath);
const require = (condition, code) => {
  if (!condition) throw new Error(code);
};

const ceiling =
  "LOCAL_HELDOUT_F3_POSTREPAIR_DBOS_INCREMENTAL_CAPABILITY_DECISION_ONLY_NOT_PRODUCTION_DURABILITY_NOT_EXACTLY_ONCE_NOT_ADOPTION_NOT_BENEFIT_NOT_AUTONOMY";
require(result.claim_ceiling === ceiling && decision.claim_ceiling === ceiling, "CEILING_MISMATCH");
require(result.input.darwin_revision === "40f90b8f437a47c180323d65dfa023d312860b23", "REVISION_MISMATCH");
require(result.input.darwin_tree === "5753c0f982e5e9cb8d45002f296ea292bcd8fe4c", "TREE_MISMATCH");
require(result.input.dbos_version === "4.27.6", "DBOS_VERSION_MISMATCH");
require(result.input.faults.length === 1 && result.input.faults[0] === "F3", "FAULT_SET_MISMATCH");
require(result.input.reps === 5 && result.runs.length === 10, "RUN_COUNT_MISMATCH");
require(new Set(result.runs.map((row) => row.run_id)).size === 10, "RUN_ID_DUPLICATE");

for (const arm of ["incumbent", "dbos"]) {
  const rows = result.runs.filter((row) => row.arm === arm);
  require(rows.length === 5, `ARM_COUNT:${arm}`);
  require(new Set(rows.map((row) => row.rep)).size === 5, `REP_COUNT:${arm}`);
  require(rows.every((row) => row.fault === "F3" && row.status === "COMPLETED"), `COMPLETION:${arm}`);
  require(rows.every((row) => row.hard_veto === false), `HARD_VETO:${arm}`);
  require(rows.every((row) => row.worker_errors.length === 0), `WORKER_ERROR:${arm}`);
  require(rows.every((row) => row.marker_matches === true), `MARKER_MATCH:${arm}`);
  require(rows.every((row) => row.provider?.created_count === 1), `PROVIDER_CREATE_COUNT:${arm}`);
  require(
    rows.every(
      (row) => sha256(Buffer.from(row.provider.marker_base64, "base64")) === row.provider.marker_sha256,
    ),
    `PROVIDER_MARKER_HASH:${arm}`,
  );
  require(result.summary[arm].runs === 5, `SUMMARY_RUNS:${arm}`);
  require(result.summary[arm].completed === 5, `SUMMARY_COMPLETED:${arm}`);
  require(result.summary[arm].hard_vetoes === 0, `SUMMARY_VETO:${arm}`);
  require(result.summary[arm].duplicate_markers === 0, `SUMMARY_DUPLICATE:${arm}`);
  require(result.summary[arm].worker_errors === 0, `SUMMARY_WORKER:${arm}`);
}
require(
  result.disposition === "REJECT_NO_INCREMENTAL_CAPABILITY_SECOND_OWNER",
  "RESULT_DISPOSITION",
);
require(decision.decision.disposition === result.disposition, "DECISION_DISPOSITION");
require(decision.decision.adoption_status === "NOT_ADOPTED", "ADOPTION_STATUS");
require(decision.evidence.result_sha256 === fileSha256(resultPath), "DECISION_RESULT_HASH");
require(decision.evidence.result_path.endsWith(`${label}-result.json`), "DECISION_RESULT_PATH");
require(result.cleanup?.removed === true, "CLEANUP_RECEIPT");

function files(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
const expectedPaths = [
  runsRoot,
  resultPath,
  decisionPath,
  ...[
    "common.mjs",
    "provider.mjs",
    "worker.mjs",
    "supervisor.mjs",
    "heldout-f3-postrepair-check.mjs",
    "package.json",
    "package-lock.json",
  ].map((name) => join(root, name)),
]
  .flatMap(files)
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .sort();
require(
  stableJson(index.entries.map((entry) => entry.path)) === stableJson(expectedPaths),
  "INDEX_PATH_SET",
);
require(index.total_files === index.entries.length, "INDEX_COUNT");
require(index.root_sha256 === sha256(stableJson(index.entries)), "INDEX_ROOT");
let totalBytes = 0;
for (const entry of index.entries) {
  const path = join(root, ...entry.path.split("/"));
  require(existsSync(path), `INDEX_MISSING:${entry.path}`);
  require(fileBytes(path) === entry.bytes && fileSha256(path) === entry.sha256, `INDEX_HASH:${entry.path}`);
  totalBytes += entry.bytes;
}
require(totalBytes === index.total_bytes, "INDEX_BYTES");

const remaining = execFileSync(
  "docker",
  ["ps", "-a", "--filter", `name=^/${result.cleanup.container}$`, "--format", "{{.Names}}"],
  { encoding: "utf8", timeout: 10_000 },
).trim();
require(remaining === "", "CANARY_CONTAINER_REMAINS");

console.log(
  JSON.stringify({
    status: "PASS",
    disposition: result.disposition,
    result_sha256: fileSha256(resultPath),
    decision_sha256: fileSha256(decisionPath),
    index_sha256: fileSha256(indexPath),
    evidence_root_sha256: index.root_sha256,
    runs: result.runs.length,
  }),
);
