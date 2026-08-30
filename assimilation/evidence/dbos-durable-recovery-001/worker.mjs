import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DBOS } from "@dbos-inc/dbos-sdk";

import {
  MARKER_PROTOCOL,
  parseArgs,
  readJson,
  sha256,
  sleep,
  stableJson,
  writeBytesDurable,
  writeJsonAtomic,
} from "./common.mjs";

const args = parseArgs();
const arm = String(args.arm ?? "");
const runRoot = String(args.root ?? "");
const providerUrl = String(args.provider ?? "");
const fault = String(args.fault ?? "");
const generation = Number(args.generation ?? 1);
const darwinRepo = String(args["darwin-repo"] ?? "");
const dbosUrl = String(args["dbos-url"] ?? "");
const workflowID = String(args["workflow-id"] ?? "");
const executorID = String(args["executor-id"] ?? "");
const runId = String(args["run-id"] ?? "");
if (!arm || !runRoot || !providerUrl || !fault || !darwinRepo || !runId)
  throw new Error("WORKER_ARGS_REQUIRED");
mkdirSync(runRoot, { recursive: true });

const resultPath = join(runRoot, "worker-result.json");
const errorPath = join(runRoot, `worker-error-${process.pid}.json`);
const observationBytes = Buffer.from(
  `${stableJson({ protocol: "darwin.canary-observation/v1", repository: "fixture/habitat", run_id: runId })}\n`,
);

const episodeModule = await import(
  pathToFileURL(join(darwinRepo, "src", "episode.mjs")).href
);
const journalModule = await import(
  pathToFileURL(join(darwinRepo, "src", "journal.mjs")).href
);
const identity = episodeModule.episodeIdentity({
  organismId: "darwin-canary",
  episodeKey: runId,
  repository: "fixture/habitat",
  branch: null,
});
const marker = Buffer.from(
  episodeModule.markerBytes({
    organismId: "darwin-canary",
    episode_id: identity.episode_id,
    causal_chain_id: identity.causal_chain_id,
    observationSha256: sha256(observationBytes),
  }),
);
const markerSha256 = sha256(marker);

async function barrier(name) {
  if (generation !== 1) return;
  const path = join(runRoot, `barrier-${name}.json`);
  const release = join(runRoot, `release-${name}.flag`);
  writeJsonAtomic(path, { name, arm, fault, generation, pid: process.pid });
  while (!existsSync(release)) await sleep(20);
}

const markerUrl = `${providerUrl}/marker?key=${encodeURIComponent(identity.path)}`;
async function inspectMarker() {
  const response = await fetch(markerUrl, { method: "GET", redirect: "error" });
  if (response.status === 404) return { status: "missing", path: identity.path };
  if (response.status !== 200) throw new Error(`PROVIDER_INSPECT_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: "present",
    path: identity.path,
    bytes,
    content_sha256: sha256(bytes),
    provider_blob_sha: `file-${sha256(bytes).slice(0, 20)}`,
    provider_date: null,
  };
}

async function ensureMarker({ faultAfterCommit = false } = {}) {
  const before = await inspectMarker();
  if (before.status === "present") {
    if (!before.bytes.equals(marker)) throw new Error("PROVIDER_MARKER_CONFLICT");
    return { disposition: "existing_exact", inspection: before };
  }
  const response = await fetch(markerUrl, {
    method: "PUT",
    redirect: "error",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(marker.length),
      ...(faultAfterCommit ? { "x-fault-after-commit": "1" } : {}),
    },
    body: marker,
  });
  if (response.status !== 200 && response.status !== 201)
    throw new Error(`PROVIDER_ENSURE_HTTP_${response.status}`);
  const after = await inspectMarker();
  if (after.status !== "present" || !after.bytes.equals(marker))
    throw new Error("PROVIDER_REINSPECTION_MISMATCH");
  return { disposition: response.status === 201 ? "created" : "existing_exact", inspection: after };
}

function writeResult(value) {
  const body = `${stableJson(value)}\n`;
  try {
    writeBytesDurable(resultPath, body, "wx");
  } catch (error) {
    if (error.code !== "EEXIST" || readFileSync(resultPath, "utf8") !== body) throw error;
  }
}

async function runIncumbent() {
  const world = Object.freeze({
    id: "canary.local-marker.v1",
    callCount: () => 0,
    async observeRepository({ repository }) {
      return {
        repository,
        rawBytes: observationBytes,
        projection: { repository, run_id: runId },
        provider_date: null,
      };
    },
    async inspectContent({ repository, path }) {
      if (repository !== "fixture/habitat" || path !== identity.path)
        throw new Error("INCUMBENT_PROVIDER_BINDING_MISMATCH");
      return inspectMarker();
    },
    async ensureContent({ repository, path, content }) {
      if (
        repository !== "fixture/habitat" ||
        path !== identity.path ||
        Buffer.from(content).toString("utf8") !== marker.toString("utf8")
      )
        throw new Error("INCUMBENT_PROVIDER_BINDING_MISMATCH");
      if (fault === "F0" || fault === "F3") await barrier(fault);
      const ensured = await ensureMarker({ faultAfterCommit: generation === 1 && fault === "F1" });
      if (fault === "F2") await barrier(fault);
      return ensured;
    },
  });
  const result = await episodeModule.runEpisode({
    stateDir: join(runRoot, "incumbent-state"),
    receiptsDir: join(runRoot, "incumbent-receipts"),
    organismId: "darwin-canary",
    episodeKey: runId,
    repository: "fixture/habitat",
    world,
    now: () => "2026-08-30T00:00:00Z",
  });
  const journal = journalModule.readJournal(join(runRoot, "incumbent-state"));
  return {
    protocol: "darwin.incumbent-recovery-result/v1",
    arm,
    run_id: runId,
    episode_id: result.episode_id,
    causal_chain_id: result.causal_chain_id,
    status: result.status,
    marker_sha256: markerSha256,
    journal_rows: journal.length,
    journal_sha256: sha256(stableJson(journal)),
  };
}

async function runDbos() {
  if (!dbosUrl || !workflowID || !executorID) throw new Error("DBOS_ARGS_REQUIRED");
  DBOS.setConfig({
    name: `darwin-canary-${runId}`,
    applicationVersion: "dbos-canary-v1",
    systemDatabaseUrl: dbosUrl,
    executorID,
    systemDatabasePoolSize: 4,
    systemDatabasePollingConcurrency: 2,
    enableOTLP: false,
    tracingEnabled: false,
    runAdminServer: false,
    logLevel: "warn",
  });
  const workflow = DBOS.registerWorkflow(
    async (input) => {
      await DBOS.runStep(async () => {
        const observed = await inspectMarker();
        if (observed.status === "present" && !observed.bytes.equals(marker))
          throw new Error("DBOS_OBSERVATION_CONFLICT");
        return { status: observed.status };
      }, { name: "observe", retriesAllowed: false });
      await DBOS.runStep(async () => {
        if (fault === "F0" || fault === "F3") await barrier(fault);
        return { protocol: MARKER_PROTOCOL, key: identity.path, marker_sha256: markerSha256 };
      }, { name: "prepare", retriesAllowed: false });
      const effect = await DBOS.runStep(
        () => ensureMarker({ faultAfterCommit: generation === 1 && fault === "F1" }),
        { name: "reinspect-ensure", retriesAllowed: false },
      );
      await DBOS.runStep(async () => {
        if (fault === "F2") await barrier(fault);
        return { marker_sha256: effect.inspection.content_sha256 };
      }, { name: "finalize", retriesAllowed: false });
      return {
        protocol: "darwin.dbos-recovery-result/v1",
        run_id: input.run_id,
        episode_id: identity.episode_id,
        causal_chain_id: identity.causal_chain_id,
        status: "SETTLED",
        marker_sha256: effect.inspection.content_sha256,
      };
    },
    { name: "darwinCanaryReconcileEpisode", maxRecoveryAttempts: 10 },
  );
  await DBOS.launch();
  try {
    const handle = generation === 1
      ? await DBOS.startWorkflow(workflow, { workflowID })({ run_id: runId })
      : DBOS.retrieveWorkflow(workflowID);
    const result = await handle.getResult();
    const status = await handle.getStatus();
    const steps = await DBOS.listWorkflowSteps(workflowID);
    return {
      ...result,
      arm,
      workflow_id: workflowID,
      workflow_status: status,
      workflow_steps: steps,
    };
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}

try {
  const result = arm === "incumbent" ? await runIncumbent() : await runDbos();
  writeResult(result);
} catch (error) {
  writeJsonAtomic(errorPath, {
    arm,
    fault,
    generation,
    name: error.name,
    code: error.code ?? null,
    message: error.message,
    stack: error.stack,
  });
  process.exitCode = 1;
}

