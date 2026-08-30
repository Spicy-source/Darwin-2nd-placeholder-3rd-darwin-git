import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_CEILING,
  RESULT_PROTOCOL,
  fileBytes,
  fileSha256,
  readJson,
  sha256,
  stableJson,
  writeJsonAtomic,
} from "./common.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const runsRoot = join(root, "runs");
const resultPath = join(root, "result.json");
const provisionalPath = join(root, "result.provisional.json");
const indexPath = join(root, "evidence-index.json");
const decisionPath = join(root, "..", "..", "dbos-durable-recovery-001.json");
const provisional = readJson(provisionalPath);

function providerEvidence(runRoot) {
  const statePath = join(runRoot, "provider", "provider-state.json");
  const markerPath = join(runRoot, "provider", "marker.bin");
  if (!existsSync(statePath)) return null;
  const state = readJson(statePath);
  const marker = existsSync(markerPath) ? readFileSync(markerPath) : null;
  return {
    ...state,
    marker_base64: marker?.toString("base64") ?? null,
    marker_sha256: marker ? sha256(marker) : null,
  };
}

const rows = readdirSync(runsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const runRoot = join(runsRoot, entry.name);
    const row = readJson(join(runRoot, "run.json"));
    const provider = row.provider ?? providerEvidence(runRoot);
    const reasons = [];
    if (row.status !== "COMPLETED") reasons.push("RECOVERY_DID_NOT_COMPLETE");
    if (!provider) reasons.push("PROVIDER_EVIDENCE_MISSING");
    if (provider?.created_count !== 1) reasons.push("PROVIDER_CREATE_COUNT_NOT_ONE");
    if (row.marker_matches === false) reasons.push("MARKER_BYTES_MISMATCH");
    if (row.fault !== "F3" && row.worker_errors.length > 0) reasons.push("UNEXPECTED_WORKER_ERROR");
    return {
      ...row,
      provider,
      duplicate_marker: Boolean(provider && provider.created_count > 1),
      hard_veto: reasons.length > 0,
      hard_veto_reasons: reasons,
    };
  })
  .sort((a, b) => a.run_id.localeCompare(b.run_id));

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
};
const summary = Object.fromEntries(
  ["incumbent", "dbos"].map((arm) => {
    const selected = rows.filter((row) => row.arm === arm);
    return [
      arm,
      {
        runs: selected.length,
        completed: selected.filter((row) => row.status === "COMPLETED").length,
        hard_vetoes: selected.filter((row) => row.hard_veto).length,
        duplicate_markers: selected.filter((row) => row.duplicate_marker).length,
        worker_errors: selected.reduce((sum, row) => sum + row.worker_errors.length, 0),
        elapsed_ms: {
          median: percentile(selected.map((row) => row.elapsed_ms), 0.5),
          p95: percentile(selected.map((row) => row.elapsed_ms), 0.95),
        },
        state_bytes: {
          median: percentile(selected.map((row) => row.state_bytes), 0.5),
          p95: percentile(selected.map((row) => row.state_bytes), 0.95),
        },
      },
    ];
  }),
);
const byFault = Object.fromEntries(
  ["N", "F0", "F1", "F2", "F3"].map((fault) => [
    fault,
    Object.fromEntries(
      ["incumbent", "dbos"].map((arm) => {
        const selected = rows.filter((row) => row.arm === arm && row.fault === fault);
        return [
          arm,
          {
            runs: selected.length,
            completed: selected.filter((row) => row.status === "COMPLETED").length,
            hard_vetoes: selected.filter((row) => row.hard_veto).length,
            worker_errors: selected.reduce((sum, row) => sum + row.worker_errors.length, 0),
          },
        ];
      }),
    ),
  ]),
);

const dbosRegression = Object.values(byFault).some(
  (fault) => fault.incumbent.hard_vetoes === 0 && fault.dbos.hard_vetoes > 0,
);
const dbosUniquePass = Object.values(byFault).some(
  (fault) => fault.incumbent.hard_vetoes > 0 && fault.dbos.hard_vetoes === 0,
);
const disposition =
  summary.dbos.hard_vetoes > 0 || dbosRegression
    ? "REJECT_DBOS_REGRESSION_OR_VETO"
    : dbosUniquePass
      ? "CANARY_QUALIFIED_SHADOW_ONLY"
      : "REJECT_NO_INCREMENTAL_CAPABILITY_SECOND_OWNER";

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const full = join(path, entry.name);
    if (entry.isDirectory()) return files(full);
    if ([resultPath, indexPath].includes(full)) return [];
    return [full];
  });
}
const indexed = files(root)
  .map((path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    bytes: fileBytes(path),
    sha256: fileSha256(path),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
const index = {
  protocol: "darwin.dbos-durable-recovery-evidence-index/v1",
  entries: indexed,
  total_files: indexed.length,
  total_bytes: indexed.reduce((sum, entry) => sum + entry.bytes, 0),
  root_sha256: sha256(stableJson(indexed)),
};
writeJsonAtomic(indexPath, index);

const result = {
  protocol: RESULT_PROTOCOL,
  disposition,
  claim_ceiling: CLAIM_CEILING,
  input: provisional.input,
  summary,
  by_fault: byFault,
  runs: rows,
  cleanup: provisional.cleanup,
  evidence_index: {
    path: "assimilation/evidence/dbos-durable-recovery-001/evidence-index.json",
    sha256: fileSha256(indexPath),
    root_sha256: index.root_sha256,
  },
  provisional_result_sha256: fileSha256(provisionalPath),
};
writeJsonAtomic(resultPath, result);

const failedIncumbentFaults = Object.entries(byFault)
  .filter(([, value]) => value.incumbent.hard_vetoes > 0 && value.dbos.hard_vetoes === 0)
  .map(([fault]) => fault);
writeJsonAtomic(decisionPath, {
  schema: "darwin.assimilation-decision/1",
  decision_id: "dbos-durable-recovery-001",
  candidate: {
    package: "@dbos-inc/dbos-sdk",
    version: provisional.input.dbos_version,
    integrity: provisional.input.dbos_integrity,
  },
  decision: {
    disposition,
    adoption_status: "NOT_ADOPTED",
    unique_pass_faults: failedIncumbentFaults,
    rationale:
      disposition === "CANARY_QUALIFIED_SHADOW_ONLY"
        ? "DBOS uniquely completed at least one incumbent-failing crash boundary without a provider duplicate, but PostgreSQL and DBOS remain a second non-authoritative history owner; shadow-only follow-up is required."
        : "See the sealed bakeoff result and per-run vetoes.",
  },
  evidence: {
    result_path: "assimilation/evidence/dbos-durable-recovery-001/result.json",
    result_sha256: fileSha256(resultPath),
    evidence_index_sha256: fileSha256(indexPath),
  },
  limitations: [
    "Local disposable marker provider and PostgreSQL only.",
    "No production durability, exactly-once, Benefit, or adoption claim.",
    "One incumbent F3 failure is a SQLite contention/recovery result, not a duplicate provider effect.",
  ],
  next_action:
    disposition === "CANARY_QUALIFIED_SHADOW_ONLY"
      ? "Repair or characterize incumbent multi-contender SQLite recovery, then repeat a held-out shadow comparison before any integration."
      : "Retain the incumbent and do not integrate DBOS.",
  claim_ceiling: CLAIM_CEILING,
});
