import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoArg, evidenceArg] = process.argv.slice(2);
if (!repoArg || !evidenceArg) throw new Error("usage: runner <repo> <evidence-dir>");
const repo = resolve(repoArg);
const evidenceDir = resolve(evidenceArg);
const stateDir = join(evidenceDir, "state");
mkdirSync(stateDir, { recursive: true });

const moduleAt = (relative) => pathToFileURL(join(repo, relative)).href;
const { createHubWorld, projectHubCandidate } = await import(moduleAt("src/hub.mjs"));
const { runEvolutionEpisode } = await import(moduleAt("src/evolve.mjs"));
const { canonicalJson, readJournal, sha256 } = await import(moduleAt("src/journal.mjs"));
const { decide } = await import(moduleAt("src/policies.mjs"));

const organismId = "darwin2-public-hf-observer-v1";
const episodeKey = "hf-public-observation-001-2";
const fixedNow = "2026-08-30T00:00:00Z";
const hub = createHubWorld();
const started = performance.now();
const result = await runEvolutionEpisode({
  stateDir,
  hub,
  organismId,
  episodeKey,
  poolLimit: 80,
  offspringCount: 12,
  now: () => fixedNow,
});
const elapsedMs = performance.now() - started;
const callsAfterRun = hub.callCount();
const rows = readJournal(stateDir);
const bundle = result.evidence?.bundle;

assert.equal(result.mode, "unattested");
assert.equal(result.benefit.settlement_confidence, "PROVIDER_REINSPECTION_REQUIRED");
assert.equal(rows.filter((row) => row.kind === "genome_retained").length, 0);
assert.ok(["NOT_RETAINED", "QUARANTINED_PENDING_PROVIDER_REINSPECTION"].includes(result.retention_status));
assert.equal(result.evidence.sha256, sha256(canonicalJson(bundle)));

const observationBytes = Buffer.from(bundle.observation.raw_base64, "base64");
assert.equal(sha256(observationBytes), bundle.observation.raw_sha256);
const rawObservation = JSON.parse(observationBytes.toString("utf8"));
assert.deepEqual(
  rawObservation.map(projectHubCandidate).filter((candidate) => candidate.id.includes("/")),
  bundle.candidates,
);

const byId = new Map(bundle.candidates.map((candidate) => [candidate.id, candidate]));
const recomputedPredictions = Object.fromEntries(
  Object.entries(bundle.population_weights).map(([policyId, weights]) => [
    policyId,
    bundle.pair_ids.map(([aId, bId]) =>
      decide(weights, byId.get(aId), byId.get(bId), bundle.prediction_now_ms),
    ),
  ]),
);
assert.deepEqual(recomputedPredictions, bundle.predictions);

const truthRepositories = Object.keys(bundle.truth).sort();
const evidenceRepositories = bundle.truth_evidence.map((row) => row.repository).sort();
assert.deepEqual(evidenceRepositories, truthRepositories);
for (const row of bundle.truth_evidence) {
  const raw = Buffer.from(row.raw_base64, "base64");
  assert.equal(sha256(raw), row.raw_sha256);
  const body = JSON.parse(raw.toString("utf8"));
  assert.equal(String(body.id ?? body.modelId ?? ""), row.repository);
  assert.equal(Number(body.downloads), row.downloads);
  assert.equal(bundle.truth[row.repository], row.downloads);
}

const replay = await runEvolutionEpisode({
  stateDir,
  hub,
  organismId,
  episodeKey,
  poolLimit: 80,
  offspringCount: 12,
  now: () => fixedNow,
});
assert.deepEqual(replay, result);
assert.equal(hub.callCount(), callsAfterRun);

const receipt = {
  protocol: "darwin.hf-public-observation-canary/v1",
  disposition: "PASS_PENDING_INDEPENDENT_VERIFICATION",
  source: {
    darwin_revision: "3010aa0e697de9df2f851da2e9524889f9b1d62b",
    hub_origin: "https://huggingface.co",
    organism_id: organismId,
    episode_key: episodeKey,
    episode_key_sha256: sha256(episodeKey),
    sampling_frame: result.sampling_frame,
    pool_limit: 80,
    fixed_now: fixedNow,
  },
  result,
  counters: {
    provider_calls: callsAfterRun,
    replay_provider_call_delta: hub.callCount() - callsAfterRun,
    journal_rows: rows.length,
    candidates: bundle.candidates.length,
    truth_records: truthRepositories.length,
    observation_raw_bytes: observationBytes.length,
    truth_raw_bytes: bundle.truth_evidence.reduce(
      (sum, row) => sum + Buffer.from(row.raw_base64, "base64").length,
      0,
    ),
    elapsed_ms_descriptive: elapsedMs,
    spend_usd: 0,
    retained_rows: 0,
    external_effects: 0,
  },
  claim_ceiling:
    "REAL_PUBLIC_HF_OBSERVATION_TO_DURABLE_LOCAL_QUARANTINE_DECISION_ONLY_NOT_PROVIDER_AUTHORITY_NOT_EFFECT_NOT_BENEFIT_NOT_RETENTION",
};
const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
writeFileSync(join(evidenceDir, "hf-public-observation-001.result.json"), receiptBytes);
console.log(
  JSON.stringify(
    {
      evidenceDir,
      disposition: receipt.disposition,
      resultStatus: result.status,
      samplingFrame: result.sampling_frame,
      decision: { winner: result.winner, retentionStatus: result.retention_status },
      counters: receipt.counters,
      resultSha256: sha256(receiptBytes),
      evidenceSha256: result.evidence.sha256,
      claimCeiling: receipt.claim_ceiling,
    },
    null,
    2,
  ),
);
