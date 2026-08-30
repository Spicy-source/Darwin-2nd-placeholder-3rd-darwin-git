import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_CEILING,
  RESULT_PROTOCOL,
  fileBytes,
  fileSha256,
  parseArgs,
  readJson,
  sha256,
  sleep,
  stableJson,
  waitForFile,
  writeBytesDurable,
  writeJsonAtomic,
} from "./common.mjs";

const args = parseArgs();
const reps = Number(args.reps ?? 5);
const darwinRepo = resolve(String(args["darwin-repo"] ?? ""));
const image = String(
  args.image ??
    "postgres:16.11@sha256:ed5a1fad193768f89265c7c297999bab9aa116e82142f6e38bc33b8587b2f2da",
);
const canaryRoot = fileURLToPath(new URL(".", import.meta.url));
const label = String(args.label ?? "");
if (label && !/^[a-z0-9-]+$/.test(label)) throw new Error("LABEL_INVALID");
const claimCeiling = String(args["claim-ceiling"] ?? CLAIM_CEILING);
if (!/^[A-Z0-9_]+$/.test(claimCeiling)) throw new Error("CLAIM_CEILING_INVALID");
const runsRoot = join(canaryRoot, label ? `${label}-runs` : "runs");
const resultPath = join(canaryRoot, label ? `${label}-result.json` : "result.json");
const decisionPath = resolve(
  String(
    args.decision ??
      (label
        ? join(canaryRoot, `${label}-decision.json`)
        : join(canaryRoot, "..", "..", "dbos-durable-recovery-001.json")),
  ),
);
if (!Number.isInteger(reps) || reps < 1 || reps > 10 || !darwinRepo)
  throw new Error("SUPERVISOR_ARGS_INVALID");
if (existsSync(resultPath)) throw new Error("TERMINAL_RESULT_ALREADY_EXISTS");
mkdirSync(runsRoot, { recursive: true });

const docker = (...argv) =>
  execFileSync("docker", argv, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).trim();
const tree = execFileSync("git", ["-C", darwinRepo, "rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();
const revision = execFileSync("git", ["-C", darwinRepo, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const expectedTree = String(
  args["darwin-tree"] ?? "2eaba3e1ca85919c9fcc02cdbdcbbb625215b1ae",
);
const expectedRevision = String(args["darwin-revision"] ?? "");
if (!/^[0-9a-f]{40}$/.test(expectedTree)) throw new Error("DARWIN_TREE_ARG_INVALID");
if (expectedRevision && !/^[0-9a-f]{40}$/.test(expectedRevision))
  throw new Error("DARWIN_REVISION_ARG_INVALID");
if (tree !== expectedTree)
  throw new Error(`DARWIN_TREE_MISMATCH:${tree}`);
if (expectedRevision && revision !== expectedRevision)
  throw new Error(`DARWIN_REVISION_MISMATCH:${revision}`);

const lock = readJson(join(canaryRoot, "package-lock.json"));
const dbosLock = lock.packages["node_modules/@dbos-inc/dbos-sdk"];
if (
  dbosLock?.version !== "4.27.6" ||
  dbosLock?.integrity !==
    "sha512-mr5CEllYovAHPh/TpQcvxTYM+4t4tgV7CjkZGe7hzNxw9Nzf6l7ggxJKDbewLFwgwx8NaWcWw21ESHXNE1UwrA=="
)
  throw new Error("DBOS_LOCK_MISMATCH");

function directoryBytes(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (sum, entry) => sum + directoryBytes(join(path, entry.name)),
    0,
  );
}

function spawnLogged(file, argv, options, prefix) {
  const stdoutPath = `${prefix}.stdout.log`;
  const stderrPath = `${prefix}.stderr.log`;
  const out = openSync(stdoutPath, "a");
  const err = openSync(stderrPath, "a");
  const child = spawn(process.execPath, [file, ...argv], {
    ...options,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  closeSync(out);
  closeSync(err);
  return { child, stdoutPath, stderrPath };
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`PROCESS_TIMEOUT:${child.pid}`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function kill(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGKILL");
  return waitExit(child, 10_000);
}

async function startProvider(runRoot) {
  const portFile = join(runRoot, "provider-port.json");
  const providerRoot = join(runRoot, "provider");
  const processInfo = spawnLogged(
    join(canaryRoot, "provider.mjs"),
    [`--root=${providerRoot}`, `--port-file=${portFile}`],
    { cwd: canaryRoot },
    join(runRoot, "provider"),
  );
  await waitForFile(portFile, 10_000, "provider port");
  const port = readJson(portFile).port;
  return { ...processInfo, providerRoot, url: `http://127.0.0.1:${port}` };
}

async function stopProvider(provider) {
  try {
    await fetch(`${provider.url}/shutdown`, { method: "POST" });
  } catch {}
  try {
    await waitExit(provider.child, 5_000);
  } catch {
    await kill(provider.child);
  }
}

function workerArgs({ arm, runRoot, provider, fault, generation, pairId, dbosUrl }) {
  return [
    `--arm=${arm}`,
    `--root=${runRoot}`,
    `--provider=${provider.url}`,
    `--fault=${fault}`,
    `--generation=${generation}`,
    `--darwin-repo=${darwinRepo}`,
    `--run-id=${pairId}`,
    `--workflow-id=workflow-${pairId}`,
    `--executor-id=executor-${pairId}`,
    ...(dbosUrl ? [`--dbos-url=${dbosUrl}`] : []),
  ];
}

function startWorker(config, label) {
  return spawnLogged(
    join(canaryRoot, "worker.mjs"),
    workerArgs(config),
    { cwd: canaryRoot, env: { ...process.env } },
    join(config.runRoot, label),
  );
}

async function waitBarrier(runRoot, providerRoot, fault) {
  const path =
    fault === "F1"
      ? join(providerRoot, "provider-commit.barrier.json")
      : join(runRoot, `barrier-${fault}.json`);
  return waitForFile(path, 60_000, `${fault} barrier`);
}

function releaseBarrier(runRoot, providerRoot, fault) {
  const path =
    fault === "F1"
      ? join(providerRoot, "provider-commit.release")
      : join(runRoot, `release-${fault}.flag`);
  writeBytesDurable(path, "release\n");
}

const errors = (runRoot) =>
  readdirSync(runRoot)
    .filter((name) => name.startsWith("worker-error-") && name.endsWith(".json"))
    .map((name) => readJson(join(runRoot, name)));

async function runOne({ arm, fault, rep, postgres }) {
  const pairId = `${fault.toLowerCase()}-${String(rep).padStart(2, "0")}-${sha256(`${fault}|${rep}`).slice(0, 10)}`;
  const runId = `${arm}-${pairId}`;
  const runRoot = join(runsRoot, runId);
  mkdirSync(runRoot, { recursive: true });
  const startedAt = Date.now();
  let database = null;
  let dbosUrl = null;
  let provider;
  const workers = [];
  let row;
  try {
    if (arm === "dbos") {
      database = `c_${sha256(runId).slice(0, 20)}`;
      docker("exec", postgres.name, "createdb", "-U", "postgres", database);
      dbosUrl = `postgresql://postgres:${postgres.password}@127.0.0.1:${postgres.port}/${database}`;
    }
    provider = await startProvider(runRoot);
    const config = { arm, runRoot, provider, fault, generation: 1, pairId, dbosUrl };
    const p1 = startWorker(config, "p1");
    workers.push(p1);

    if (fault === "N") {
      await waitExit(p1.child, 60_000);
    } else {
      await waitBarrier(runRoot, provider.providerRoot, fault);
      await kill(p1.child);
      releaseBarrier(runRoot, provider.providerRoot, fault);
      const contenders = fault === "F3" ? 2 : 1;
      for (let index = 0; index < contenders; index++) {
        const p2 = startWorker({ ...config, generation: 2 }, `p2-${index}`);
        workers.push(p2);
      }
      await waitForFile(join(runRoot, "worker-result.json"), 60_000, "worker result");
      await sleep(500);
      for (const worker of workers.slice(1)) await kill(worker.child);
    }

    await waitForFile(join(runRoot, "worker-result.json"), 10_000, "worker result");
    const result = readJson(join(runRoot, "worker-result.json"));
    const providerState = await fetch(`${provider.url}/state`).then((response) => response.json());
    const markerMatches = providerState.marker_sha256 === result.marker_sha256;
    const workerErrors = errors(runRoot);
    row = {
      protocol: "darwin.dbos-durable-recovery-run/v1",
      arm,
      fault,
      rep,
      pair_id: pairId,
      run_id: runId,
      status: "COMPLETED",
      result,
      provider: providerState,
      hard_veto:
        result.status !== "SETTLED" ||
        providerState.created_count !== 1 ||
        !markerMatches ||
        (fault !== "F3" && workerErrors.length > 0),
      marker_matches: markerMatches,
      elapsed_ms: Date.now() - startedAt,
      worker_errors: workerErrors,
    };
  } catch (error) {
    row = {
      protocol: "darwin.dbos-durable-recovery-run/v1",
      arm,
      fault,
      rep,
      pair_id: pairId,
      run_id: runId,
      status: "FAILED",
      hard_veto: true,
      error: { name: error.name, code: error.code ?? null, message: error.message },
      worker_errors: errors(runRoot),
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    for (const worker of workers) {
      try {
        await kill(worker.child);
      } catch {}
    }
    if (provider) await stopProvider(provider);
    if (database) {
      try {
        const dump = execFileSync(
          "docker",
          ["exec", postgres.name, "pg_dump", "-U", "postgres", "--no-owner", "--no-privileges", database],
          { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
        );
        writeBytesDurable(join(runRoot, "dbos.sql"), dump);
      } catch {}
      try {
        docker("exec", postgres.name, "dropdb", "-U", "postgres", "--force", database);
      } catch {}
    }
  }
  row.state_bytes = directoryBytes(runRoot);
  writeJsonAtomic(join(runRoot, "run.json"), row);
  return row;
}

function startPostgres() {
  const token = sha256(`${Date.now()}|${process.pid}`).slice(0, 12);
  const name = `darwin-dbos-canary-${token}`;
  const password = `p_${sha256(`${token}|password`).slice(0, 24)}`;
  const imageIdentity = JSON.parse(docker("image", "inspect", image))[0];
  docker(
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--memory",
    "768m",
    "--cpus",
    "2",
    "--health-cmd",
    "pg_isready -U postgres",
    "--health-interval",
    "1s",
    "--health-timeout",
    "3s",
    "--health-retries",
    "30",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-p",
    "127.0.0.1::5432",
    image,
  );
  return { name, password, imageIdentity };
}

async function waitPostgres(postgres) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const health = docker("inspect", "--format", "{{.State.Health.Status}}", postgres.name);
    if (health === "healthy") {
      const mapped = docker("port", postgres.name, "5432/tcp").split(/\r?\n/)[0];
      postgres.port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
      postgres.version = docker(
        "exec",
        postgres.name,
        "psql",
        "-U",
        "postgres",
        "-Atc",
        "SELECT version()",
      );
      return postgres;
    }
    await sleep(500);
  }
  throw new Error("POSTGRES_HEALTH_TIMEOUT");
}

const allFaults = ["N", "F0", "F1", "F2", "F3"];
const faults = String(args.faults ?? allFaults.join(","))
  .split(",")
  .filter(Boolean);
if (faults.length === 0 || faults.some((fault) => !allFaults.includes(fault)))
  throw new Error("FAULT_SET_INVALID");
const rows = [];
let postgres;
let cleanup;
try {
  postgres = await waitPostgres(startPostgres());
  for (let rep = 0; rep < reps; rep++) {
    for (let faultIndex = 0; faultIndex < faults.length; faultIndex++) {
      const fault = faults[faultIndex];
      const arms = (rep + faultIndex) % 2 === 0 ? ["incumbent", "dbos"] : ["dbos", "incumbent"];
      for (const arm of arms) {
        const row = await runOne({ arm, fault, rep, postgres });
        rows.push(row);
        process.stdout.write(`${row.run_id} ${row.status} veto=${row.hard_veto}\n`);
      }
    }
  }
} finally {
  if (postgres?.name) {
    try {
      docker("rm", "-f", postgres.name);
      cleanup = { container: postgres.name, removed: true };
    } catch (error) {
      cleanup = { container: postgres.name, removed: false, error: error.message };
    }
  }
}

const byArm = Object.fromEntries(
  ["incumbent", "dbos"].map((arm) => {
    const selected = rows.filter((row) => row.arm === arm);
    return [
      arm,
      {
        runs: selected.length,
        completed: selected.filter((row) => row.status === "COMPLETED").length,
        hard_vetoes: selected.filter((row) => row.hard_veto).length,
        duplicate_markers: selected.filter((row) => row.provider?.created_count !== 1).length,
        worker_errors: selected.reduce((sum, row) => sum + row.worker_errors.length, 0),
      },
    ];
  }),
);
let disposition;
if (byArm.dbos.hard_vetoes > 0 || byArm.dbos.completed < byArm.incumbent.completed) {
  disposition = "REJECT_DBOS_REGRESSION_OR_VETO";
} else if (byArm.incumbent.hard_vetoes === 0 && byArm.dbos.hard_vetoes === 0) {
  disposition = "REJECT_NO_INCREMENTAL_CAPABILITY_SECOND_OWNER";
} else {
  disposition = "CANARY_QUALIFIED_SHADOW_ONLY";
}

const result = {
  protocol: RESULT_PROTOCOL,
  disposition,
  claim_ceiling: claimCeiling,
  input: {
    darwin_revision: revision,
    darwin_tree: tree,
    dbos_version: dbosLock.version,
    dbos_integrity: dbosLock.integrity,
    postgres_image: image,
    postgres_image_id: postgres?.imageIdentity?.Id ?? null,
    postgres_version: postgres?.version ?? null,
    faults,
    reps,
  },
  summary: byArm,
  runs: rows,
  cleanup,
};
writeJsonAtomic(resultPath, result);
writeJsonAtomic(decisionPath, {
  schema: "darwin.assimilation-decision/1",
  decision_id: label ? `dbos-durable-recovery-001-${label}` : "dbos-durable-recovery-001",
  candidate: {
    package: "@dbos-inc/dbos-sdk",
    version: dbosLock.version,
    integrity: dbosLock.integrity,
  },
  decision: {
    disposition,
    adoption_status: "NOT_ADOPTED",
    rationale:
      disposition === "REJECT_NO_INCREMENTAL_CAPABILITY_SECOND_OWNER"
        ? "Darwin's existing SQLite and provider-reinspection baseline passed the same crash matrix; DBOS adds PostgreSQL and a second durable history without incremental capability."
        : "See the sealed bakeoff result and per-run vetoes.",
  },
  evidence: {
    result_path: `assimilation/evidence/dbos-durable-recovery-001/${basename(resultPath)}`,
    result_sha256: fileSha256(resultPath),
  },
  claim_ceiling: claimCeiling,
});

function evidenceFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? evidenceFiles(join(path, entry.name)) : [join(path, entry.name)],
  );
}

if (label) {
  const indexed = [
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
    ].map((name) => join(canaryRoot, name)),
  ]
    .flatMap(evidenceFiles)
    .map((path) => ({
      path: relative(canaryRoot, path).replaceAll("\\", "/"),
      bytes: fileBytes(path),
      sha256: fileSha256(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  writeJsonAtomic(join(canaryRoot, `${label}-evidence-index.json`), {
    protocol: "darwin.dbos-heldout-evidence-index/v1",
    label,
    entries: indexed,
    total_files: indexed.length,
    total_bytes: indexed.reduce((sum, entry) => sum + entry.bytes, 0),
    root_sha256: sha256(stableJson(indexed)),
  });
}
