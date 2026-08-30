import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = resolve(ROOT, "input.json");
const DECISION_PATH = resolve(ROOT, "..", "..", "hf-genome-promotion-001.json");
const PORTABLE_ROOT = "assimilation/evidence/hf-genome-promotion-001";
const INPUT_SHA256 = "fc4e9e24de382c6484bc6fbc7a25fd976022f5f0d040362ecb26dacc0185ddfc";
const FEATURES = ["likes", "age", "freshness", "tags", "pipeline", "known_org", "id_length"];
const KNOWN_ORGS = new Set([
  "google",
  "meta-llama",
  "openai",
  "microsoft",
  "facebook",
  "stabilityai",
  "sentence-transformers",
  "google-bert",
  "openai-community",
  "mistralai",
  "Qwen",
  "deepseek-ai",
  "black-forest-labs",
  "nvidia",
  "Salesforce",
]);
const GENERATED = [
  "observation.json",
  "predictions.json",
  "trajectory.jsonl",
  "truth.jsonl",
  "result.json",
  "evidence-index.json",
];

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const expect = (condition, code, message) => {
  if (!condition) fail(code, message);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  return value;
};
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const parseJson = (bytes, code, role) => {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail(code, `${role} is not JSON`);
  }
};
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
const fileRecord = (role, path) => {
  const bytes = readFileSync(path);
  return {
    role,
    path: `${PORTABLE_ROOT}/${basename(path)}`,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
};
const vector = (partial) => Object.fromEntries(FEATURES.map((key) => [key, Number(partial[key] ?? 0)]));
const genomeId = (weights) => `genome:${sha256(JSON.stringify(vector(weights))).slice(0, 16)}`;
const days = (iso, nowMs) => {
  const time = Date.parse(iso ?? "");
  return Number.isFinite(time) ? Math.max(0, (nowMs - time) / 86_400_000) : 0;
};
const featuresOf = (candidate, nowMs) => ({
  likes: Math.log1p(Math.max(0, candidate.likes)),
  age: Math.log1p(days(candidate.createdAt, nowMs)),
  freshness: -Math.log1p(days(candidate.lastModified, nowMs)),
  tags: Math.log1p(candidate.tags.length),
  pipeline: candidate.pipeline_tag ? 1 : 0,
  known_org: KNOWN_ORGS.has(candidate.author) ? 1 : 0,
  id_length: -Math.log1p(candidate.id.length),
});
const decide = (weights, a, b, nowMs) => {
  const left = featuresOf(a, nowMs);
  const right = featuresOf(b, nowMs);
  let score = 0;
  for (const feature of FEATURES) score += weights[feature] * (left[feature] - right[feature]);
  return score >= 0 ? "a" : "b";
};
const mulberry32 = (seedHex) => {
  let state = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};
const projectCandidate = (model) => ({
  id: String(model.id ?? model.modelId ?? ""),
  author: String(model.id ?? "").split("/")[0] ?? "",
  pipeline_tag: model.pipeline_tag ?? null,
  library_name: model.library_name ?? null,
  tags: Array.isArray(model.tags) ? model.tags.slice(0, 40).map(String) : [],
  likes: Number(model.likes ?? 0),
  createdAt: model.createdAt ?? null,
  lastModified: model.lastModified ?? null,
});
const truthUrl = (origin, id) =>
  `${origin}/api/models/${id.split("/").map(encodeURIComponent).join("/")}`;

function loadInput(root = ROOT) {
  const path = resolve(root, "input.json");
  const bytes = readFileSync(path);
  expect(sha256(bytes) === INPUT_SHA256, "INPUT_HASH_DRIFT", "frozen input bytes changed");
  const input = parseJson(bytes, "INPUT_INVALID", "input");
  expect(input.schema === "darwin.hf-genome-promotion-heldout-input/1", "INPUT_INVALID", "schema");
  expect(input.evaluation_id === "hf-genome-promotion-001", "INPUT_INVALID", "evaluation id");
  expect(genomeId(input.candidate.weights) === input.candidate.id, "INPUT_INVALID", "candidate id");
  expect(
    canonicalJson(vector(input.baseline.weights)) === canonicalJson(vector({ likes: 1 })) &&
      input.baseline.id === "named:likes",
    "INPUT_INVALID",
    "baseline",
  );
  expect(
    input.world.listing_url ===
      "https://huggingface.co/api/models?sort=likes&direction=-1&limit=200" &&
      input.world.truth_origin === "https://huggingface.co" &&
      input.world.cohort_start_zero_based === 100 &&
      input.world.cohort_end_exclusive === 200,
    "INPUT_INVALID",
    "world envelope",
  );
  expect(
    input.split.train_pairs === 30 && input.split.holdout_pairs === 20,
    "INPUT_INVALID",
    "split",
  );
  return { input, bytes };
}

function verifySourceEpisode(input, root = ROOT) {
  const path = resolve(root, "source-episode.json");
  const bytes = readFileSync(path);
  expect(
    sha256(bytes) === input.source.artifact_sha256,
    "SOURCE_EPISODE_INVALID",
    "source artifact hash",
  );
  const source = parseJson(bytes, "SOURCE_EPISODE_INVALID", "source episode");
  expect(
    source.schema === "darwin.hf-genome-promotion-source-episode/1" &&
      source.darwin.repository === input.source.repository &&
      source.darwin.revision === input.source.revision &&
      source.darwin.tree === input.source.tree &&
      source.episode_id === input.source.episode_id &&
      source.result_sha256 === input.source.result_sha256 &&
      source.evidence_sha256 === input.source.evidence_sha256,
    "SOURCE_EPISODE_INVALID",
    "source identity",
  );
  expect(Array.isArray(source.rows), "SOURCE_EPISODE_INVALID", "source rows");
  const row = (kind) => source.rows.find((candidate) => candidate.kind === kind);
  const committed = row("predictions_committed");
  const settled = row("truth_settled");
  const evidence = row("evolution_evidence");
  const benefit = row("evolution_benefit");
  const quarantine = row("genome_candidate_quarantined");
  const result = row("evolution_result");
  expect(
    committed && settled && evidence && benefit && quarantine && result,
    "SOURCE_EPISODE_INVALID",
    "source roles",
  );
  expect(
    sha256(canonicalJson(result.result)) === input.source.result_sha256 &&
      result.result_sha256 === input.source.result_sha256 &&
      sha256(canonicalJson(evidence.bundle)) === input.source.evidence_sha256 &&
      evidence.bundle_sha256 === input.source.evidence_sha256,
    "SOURCE_EPISODE_INVALID",
    "source result/evidence hashes",
  );
  expect(
    canonicalJson(committed.population_weights[input.candidate.id]) ===
      canonicalJson(vector(input.candidate.weights)) &&
      result.result.winner === input.candidate.id &&
      canonicalJson(result.result.benefit) === canonicalJson(benefit.vector) &&
      benefit.vector.lift_over_frozen_baseline === 0.25 &&
      quarantine.genome_id === input.candidate.id &&
      quarantine.reason === "PROVIDER_REINSPECTION_REQUIRED" &&
      quarantine.benefit_key === benefit.idempotency_key,
    "SOURCE_EPISODE_INVALID",
    "source candidate/benefit binding",
  );
  const truthEvidence = evidence.bundle.truth_evidence;
  const truthIds = Object.keys(settled.truth).sort();
  expect(
    Array.isArray(truthEvidence) &&
      new Set(truthEvidence.map(({ repository }) => repository)).size === truthEvidence.length &&
      canonicalJson(truthEvidence.map(({ repository }) => repository).sort()) ===
        canonicalJson(truthIds),
    "SOURCE_EPISODE_INVALID",
    "source truth coverage",
  );
  for (const truthRow of truthEvidence) {
    const raw = Buffer.from(truthRow.raw_base64, "base64");
    const body = parseJson(raw, "SOURCE_EPISODE_INVALID", truthRow.repository);
    expect(
      sha256(raw) === truthRow.raw_sha256 &&
        String(body.id ?? body.modelId ?? "") === truthRow.repository &&
        Number(body.downloads) === truthRow.downloads &&
        settled.truth[truthRow.repository] === truthRow.downloads,
      "SOURCE_EPISODE_INVALID",
      `source truth ${truthRow.repository}`,
    );
  }
  return source;
}

async function readBounded(response, cap) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length <= cap, "PROVIDER_RESPONSE_OVERSIZED", "response cap");
    return bytes;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      fail("PROVIDER_RESPONSE_OVERSIZED", "response cap");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function get(url, cap, counters) {
  const parsed = new URL(url);
  expect(parsed.origin === "https://huggingface.co", "PROVIDER_ORIGIN_REFUSED", parsed.origin);
  counters.http_attempts++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref();
  try {
    const response = await fetch(parsed, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", "User-Agent": "Darwin-Heldout-Evaluator/1" },
      signal: controller.signal,
    });
    expect(response.status === 200, "PROVIDER_READ_FAILED", `${url} returned ${response.status}`);
    const rawBytes = await readBounded(response, cap);
    counters.successful_responses++;
    return {
      source_url: url,
      provider_date: response.headers.get("date"),
      raw_sha256: sha256(rawBytes),
      raw_base64: rawBytes.toString("base64"),
      bytes: rawBytes.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function predictionsFrom(input, observation) {
  const raw = Buffer.from(observation.raw_base64, "base64");
  expect(raw.toString("base64") === observation.raw_base64, "OBSERVATION_INVALID", "base64");
  expect(sha256(raw) === observation.raw_sha256, "OBSERVATION_INVALID", "hash");
  expect(observation.source_url === input.world.listing_url, "OBSERVATION_INVALID", "URL");
  const listed = parseJson(raw, "OBSERVATION_INVALID", "listing");
  expect(Array.isArray(listed) && listed.length >= 200, "OBSERVATION_INVALID", "listing size");
  const cohort = listed
    .map(projectCandidate)
    .slice(input.world.cohort_start_zero_based, input.world.cohort_end_exclusive);
  expect(
    cohort.length === 100 && new Set(cohort.map(({ id }) => id)).size === 100,
    "COHORT_INVALID",
    "cohort identity",
  );
  expect(cohort.every(({ id }) => id.includes("/")), "COHORT_INVALID", "repository id");
  const predictionNowMs = Date.parse(observation.provider_date);
  expect(Number.isFinite(predictionNowMs), "OBSERVATION_INVALID", "provider clock");
  const seed = sha256(
    canonicalJson({
      schema: "darwin.hf-genome-promotion-heldout-seed/1",
      candidate_id: input.candidate.id,
      source_evidence_sha256: input.source.evidence_sha256,
      observation_sha256: observation.raw_sha256,
      cohort: input.world.cohort,
    }),
  );
  const random = mulberry32(seed);
  const order = cohort.slice();
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  const pairs = [];
  for (let index = 0; index + 1 < order.length; index += 2)
    pairs.push([order[index].id, order[index + 1].id]);
  const byId = new Map(cohort.map((candidate) => [candidate.id, candidate]));
  const predict = (weights) =>
    pairs.map(([a, b]) => decide(weights, byId.get(a), byId.get(b), predictionNowMs));
  return {
    schema: "darwin.hf-genome-promotion-heldout-predictions/1",
    evaluation_id: input.evaluation_id,
    input_sha256: INPUT_SHA256,
    observation_sha256: observation.raw_sha256,
    cohort: input.world.cohort,
    cohort_candidates: cohort,
    prediction_now_ms: predictionNowMs,
    seed,
    pair_ids: pairs,
    policies: {
      candidate: { id: input.candidate.id, weights: vector(input.candidate.weights) },
      baseline: { id: input.baseline.id, weights: vector(input.baseline.weights) },
    },
    predictions: {
      candidate: predict(vector(input.candidate.weights)),
      baseline: predict(vector(input.baseline.weights)),
    },
    provider_successful_responses_before_truth: 1,
  };
}

function parseTruth(input, predictions, truthBytes) {
  const lines = truthBytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJson(Buffer.from(line), "TRUTH_INVALID", "truth row"));
  const ids = [...new Set(predictions.pair_ids.flat())].sort();
  expect(lines.length === 100, "TRUTH_INVALID", "truth row count");
  expect(new Set(lines.map(({ repository }) => repository)).size === 100, "TRUTH_INVALID", "duplicate truth");
  expect(
    canonicalJson(lines.map(({ repository }) => repository).sort()) === canonicalJson(ids),
    "TRUTH_INVALID",
    "one-to-one truth coverage",
  );
  const truth = {};
  for (const row of lines) {
    expect(
      row.schema === "darwin.hf-genome-promotion-heldout-truth/1" &&
        row.source_url === truthUrl(input.world.truth_origin, row.repository) &&
        typeof row.raw_base64 === "string" &&
        typeof row.raw_sha256 === "string",
      "TRUTH_INVALID",
      `truth envelope ${row.repository}`,
    );
    const raw = Buffer.from(row.raw_base64, "base64");
    expect(
      raw.toString("base64") === row.raw_base64 &&
        raw.length === row.bytes &&
        sha256(raw) === row.raw_sha256,
      "TRUTH_INVALID",
      `truth bytes ${row.repository}`,
    );
    const body = parseJson(raw, "TRUTH_INVALID", row.repository);
    expect(
      String(body.id ?? body.modelId ?? "") === row.repository &&
        Number.isFinite(Number(body.downloads)) &&
        Number(body.downloads) === row.downloads,
      "TRUTH_INVALID",
      `truth semantics ${row.repository}`,
    );
    truth[row.repository] = row.downloads;
  }
  return { lines, truth };
}

function resultFrom(input, observation, predictions, truthBytes, counters) {
  const { lines, truth } = parseTruth(input, predictions, truthBytes);
  const scoreable = predictions.pair_ids
    .map(([a, b], index) => ({ a, b, index }))
    .filter(({ a, b }) => truth[a] !== truth[b]);
  const accuracy = (policy, start, end) => {
    const rows = scoreable.filter(({ index }) => index >= start && index < end);
    if (rows.length === 0) return null;
    const hits = rows.filter(({ a, b, index }) => {
      const expected = truth[a] > truth[b] ? "a" : "b";
      return predictions.predictions[policy][index] === expected;
    }).length;
    return Number((hits / rows.length).toFixed(4));
  };
  const trainEnd = input.split.train_pairs;
  const holdoutEnd = trainEnd + input.split.holdout_pairs;
  const metrics = {
    scoreable_pairs: scoreable.length,
    voided_pairs: predictions.pair_ids.length - scoreable.length,
    candidate_train_accuracy: accuracy("candidate", 0, trainEnd),
    baseline_train_accuracy: accuracy("baseline", 0, trainEnd),
    candidate_holdout_accuracy: accuracy("candidate", trainEnd, holdoutEnd),
    baseline_holdout_accuracy: accuracy("baseline", trainEnd, holdoutEnd),
    truth_evidence_count: lines.length,
    provider_successful_responses: counters?.successful_responses ?? 101,
    provider_http_attempts: counters?.http_attempts ?? 101,
  };
  let disposition = "REJECT_INSUFFICIENT_HELDOUT_EVIDENCE";
  if (
    metrics.scoreable_pairs === 50 &&
    metrics.candidate_train_accuracy > metrics.baseline_train_accuracy &&
    metrics.candidate_holdout_accuracy > metrics.baseline_holdout_accuracy
  )
    disposition = "PASS_PENDING_EXTERNAL_PROMOTION_AUTHORITY";
  else if (metrics.scoreable_pairs === 50) disposition = "REJECT_NO_CROSS_COHORT_GENERALIZATION";
  return {
    schema: "darwin.hf-genome-promotion-heldout-result/1",
    evaluation_id: input.evaluation_id,
    evaluated_at: observation.provider_date,
    source: input.source,
    cohort: {
      id: input.world.cohort,
      listing_url: input.world.listing_url,
      ranks_one_based: [101, 200],
      observation_sha256: observation.raw_sha256,
    },
    candidate: input.candidate,
    baseline: input.baseline,
    predictions_sha256: sha256(canonicalJson(predictions.predictions)),
    truth_root_sha256: sha256(
      canonicalJson(lines.map(({ repository, raw_sha256 }) => ({ repository, raw_sha256 }))),
    ),
    metrics,
    decision: {
      disposition,
      promotion_admitted: false,
      retention_admitted: false,
      rationale:
        disposition === "REJECT_NO_CROSS_COHORT_GENERALIZATION"
          ? "The quarantined candidate did not strictly exceed named:likes on both the fresh train and held-out partitions."
          : disposition === "PASS_PENDING_EXTERNAL_PROMOTION_AUTHORITY"
            ? "The candidate passed this held-out evidence gate; a separate external promotion authority is still required."
            : "The held-out cohort did not contain exactly 50 scoreable pairs.",
    },
    claim_ceiling: input.claim_ceiling,
  };
}

function expectedTrajectory(observationPath, predictionsPath, truthPath) {
  const observation = fileRecord("observation", observationPath);
  const predictions = fileRecord("predictions", predictionsPath);
  const events = [
    {
      sequence: 1,
      event: "PREDICTIONS_COMMITTED",
      observation_sha256: observation.sha256,
      predictions_sha256: predictions.sha256,
      provider_successful_responses: 1,
    },
  ];
  if (existsSync(truthPath)) {
    const truth = fileRecord("truth", truthPath);
    events.push({
      sequence: 2,
      event: "TRUTH_SETTLED",
      predictions_sha256: predictions.sha256,
      truth_sha256: truth.sha256,
      provider_successful_responses: 101,
    });
  }
  return events;
}

export function verifyBundle({ root = ROOT, decisionPath = DECISION_PATH } = {}) {
  const { input } = loadInput(root);
  verifySourceEpisode(input, root);
  const paths = Object.fromEntries(GENERATED.map((name) => [name, resolve(root, name)]));
  for (const [name, path] of Object.entries(paths))
    expect(existsSync(path), "EVIDENCE_MISSING", name);
  const observation = parseJson(
    readFileSync(paths["observation.json"]),
    "OBSERVATION_INVALID",
    "observation",
  );
  expect(
    observation.schema === "darwin.hf-genome-promotion-heldout-observation/1" &&
      observation.bytes <= 2 * 1024 * 1024,
    "OBSERVATION_INVALID",
    "observation envelope",
  );
  const expectedPredictions = predictionsFrom(input, observation);
  const predictions = parseJson(
    readFileSync(paths["predictions.json"]),
    "PREDICTIONS_INVALID",
    "predictions",
  );
  expect(
    canonicalJson(predictions) === canonicalJson(expectedPredictions),
    "PREDICTIONS_INVALID",
    "predictions do not recompute",
  );
  expect(
    predictions.cohort_candidates.every((candidate) => !Object.hasOwn(candidate, "downloads")),
    "PREDICTIONS_INVALID",
    "truth leaked into candidates",
  );
  const truthBytes = readFileSync(paths["truth.jsonl"]);
  const expectedResult = resultFrom(input, observation, predictions, truthBytes);
  const result = parseJson(readFileSync(paths["result.json"]), "RESULT_INVALID", "result");
  expect(canonicalJson(result) === canonicalJson(expectedResult), "RESULT_INVALID", "result drift");
  const trajectory = readFileSync(paths["trajectory.jsonl"], "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJson(Buffer.from(line), "TRAJECTORY_INVALID", "trajectory"));
  const expectedEvents = expectedTrajectory(
    paths["observation.json"],
    paths["predictions.json"],
    paths["truth.jsonl"],
  );
  expect(
    canonicalJson(trajectory) === canonicalJson(expectedEvents),
    "TRAJECTORY_INVALID",
    "prediction/truth ordering",
  );
  const index = parseJson(
    readFileSync(paths["evidence-index.json"]),
    "INDEX_INVALID",
    "index",
  );
  const indexed = [
    fileRecord("input", resolve(root, "input.json")),
    fileRecord("source_episode", resolve(root, "source-episode.json")),
    fileRecord("harness", resolve(root, "harness.mjs")),
    fileRecord("observation", paths["observation.json"]),
    fileRecord("predictions", paths["predictions.json"]),
    fileRecord("trajectory", paths["trajectory.jsonl"]),
    fileRecord("truth", paths["truth.jsonl"]),
    fileRecord("result", paths["result.json"]),
  ];
  const expectedIndex = {
    schema: "darwin.hf-genome-promotion-heldout-evidence-index/1",
    evaluation_id: input.evaluation_id,
    entries: indexed,
    total_files: indexed.length,
    total_bytes: indexed.reduce((sum, entry) => sum + entry.bytes, 0),
    evidence_root_sha256: sha256(canonicalJson(indexed)),
  };
  expect(canonicalJson(index) === canonicalJson(expectedIndex), "INDEX_INVALID", "index drift");
  expect(
    index.entries.every(({ path }) => !path.includes("\\") && !/^[A-Za-z]:|^\//.test(path)),
    "INDEX_INVALID",
    "nonportable path",
  );
  const decision = parseJson(readFileSync(decisionPath), "DECISION_INVALID", "decision");
  const expectedDecision = {
    schema: "darwin.hf-genome-promotion-heldout-decision/1",
    evaluation_id: input.evaluation_id,
    result: result.decision.disposition,
    candidate: input.candidate,
    baseline: input.baseline,
    metrics: result.metrics,
    result_sha256: sha256(readFileSync(paths["result.json"])),
    evidence_index_sha256: sha256(readFileSync(paths["evidence-index.json"])),
    evidence_root_sha256: index.evidence_root_sha256,
    promotion_admitted: false,
    retention_admitted: false,
    claim_ceiling: input.claim_ceiling,
  };
  expect(canonicalJson(decision) === canonicalJson(expectedDecision), "DECISION_INVALID", "decision drift");
  return { decision, index, result };
}

async function run() {
  const { input } = loadInput();
  const generatedPaths = GENERATED.map((name) => resolve(ROOT, name));
  if (generatedPaths.every(existsSync) && existsSync(DECISION_PATH)) {
    const verified = verifyBundle();
    console.log(JSON.stringify({ disposition: "ALREADY_EXACT", result: verified.result.decision }));
    return;
  }
  expect(
    generatedPaths.every((path) => !existsSync(path)) && !existsSync(DECISION_PATH),
    "OUTPUT_COLLISION",
    "partial evidence exists",
  );
  const counters = { http_attempts: 0, successful_responses: 0 };
  const observationResponse = await get(input.world.listing_url, 2 * 1024 * 1024, counters);
  const observation = {
    schema: "darwin.hf-genome-promotion-heldout-observation/1",
    ...observationResponse,
  };
  writeJson(resolve(ROOT, "observation.json"), observation);
  const predictions = predictionsFrom(input, observation);
  writeJson(resolve(ROOT, "predictions.json"), predictions);
  const firstEvent = expectedTrajectory(
    resolve(ROOT, "observation.json"),
    resolve(ROOT, "predictions.json"),
    resolve(ROOT, "truth.jsonl"),
  )[0];
  writeFileSync(resolve(ROOT, "trajectory.jsonl"), `${canonicalJson(firstEvent)}\n`, {
    encoding: "utf8",
    flush: true,
  });

  const repositories = [...new Set(predictions.pair_ids.flat())].sort();
  const rows = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let index = cursor++; index < repositories.length; index = cursor++) {
        const repository = repositories[index];
        const response = await get(truthUrl(input.world.truth_origin, repository), 2 * 1024 * 1024, counters);
        const body = parseJson(
          Buffer.from(response.raw_base64, "base64"),
          "TRUTH_INVALID",
          repository,
        );
        expect(
          String(body.id ?? body.modelId ?? "") === repository &&
            Number.isFinite(Number(body.downloads)),
          "TRUTH_INVALID",
          `provider semantics ${repository}`,
        );
        rows[index] = {
          schema: "darwin.hf-genome-promotion-heldout-truth/1",
          repository,
          downloads: Number(body.downloads),
          ...response,
        };
      }
    }),
  );
  expect(
    counters.successful_responses === 101 && counters.http_attempts === 101,
    "PROVIDER_CALL_COUNT_DRIFT",
    "provider call envelope",
  );
  writeFileSync(
    resolve(ROOT, "truth.jsonl"),
    `${rows.map((row) => canonicalJson(row)).join("\n")}\n`,
    { encoding: "utf8", flush: true },
  );
  const secondEvent = expectedTrajectory(
    resolve(ROOT, "observation.json"),
    resolve(ROOT, "predictions.json"),
    resolve(ROOT, "truth.jsonl"),
  )[1];
  appendFileSync(resolve(ROOT, "trajectory.jsonl"), `${canonicalJson(secondEvent)}\n`, {
    encoding: "utf8",
    flush: true,
  });
  const truthBytes = readFileSync(resolve(ROOT, "truth.jsonl"));
  const result = resultFrom(input, observation, predictions, truthBytes, counters);
  writeJson(resolve(ROOT, "result.json"), result);
  const entries = [
    fileRecord("input", INPUT_PATH),
    fileRecord("source_episode", resolve(ROOT, "source-episode.json")),
    fileRecord("harness", resolve(ROOT, "harness.mjs")),
    fileRecord("observation", resolve(ROOT, "observation.json")),
    fileRecord("predictions", resolve(ROOT, "predictions.json")),
    fileRecord("trajectory", resolve(ROOT, "trajectory.jsonl")),
    fileRecord("truth", resolve(ROOT, "truth.jsonl")),
    fileRecord("result", resolve(ROOT, "result.json")),
  ];
  const index = {
    schema: "darwin.hf-genome-promotion-heldout-evidence-index/1",
    evaluation_id: input.evaluation_id,
    entries,
    total_files: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    evidence_root_sha256: sha256(canonicalJson(entries)),
  };
  writeJson(resolve(ROOT, "evidence-index.json"), index);
  writeJson(DECISION_PATH, {
    schema: "darwin.hf-genome-promotion-heldout-decision/1",
    evaluation_id: input.evaluation_id,
    result: result.decision.disposition,
    candidate: input.candidate,
    baseline: input.baseline,
    metrics: result.metrics,
    result_sha256: sha256(readFileSync(resolve(ROOT, "result.json"))),
    evidence_index_sha256: sha256(readFileSync(resolve(ROOT, "evidence-index.json"))),
    evidence_root_sha256: index.evidence_root_sha256,
    promotion_admitted: false,
    retention_admitted: false,
    claim_ceiling: input.claim_ceiling,
  });
  const verified = verifyBundle();
  console.log(JSON.stringify({ disposition: "CREATED", result: verified.result.decision }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "run") await run();
  else if (command === "verify")
    console.log(JSON.stringify({ disposition: "VERIFIED", result: verifyBundle().result.decision }));
  else fail("COMMAND_INVALID", "use run or verify");
}
