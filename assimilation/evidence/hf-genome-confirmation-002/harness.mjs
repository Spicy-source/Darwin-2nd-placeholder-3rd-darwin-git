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
const DECISION_PATH = resolve(ROOT, "..", "..", "hf-genome-confirmation-002.json");
const PORTABLE_ROOT = "assimilation/evidence/hf-genome-confirmation-002";
const INPUT_SHA256 = "8f3c678c017bcdcb14806108bfbf171585e43af17e2c5b68d6f7f781a53a6513";
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
  expect(input.schema === "darwin.hf-genome-confirmation-input/1", "INPUT_INVALID", "schema");
  expect(input.evaluation_id === "hf-genome-confirmation-002", "INPUT_INVALID", "evaluation id");
  expect(genomeId(input.candidate.weights) === input.candidate.id, "INPUT_INVALID", "candidate id");
  expect(
    canonicalJson(vector(input.baseline.weights)) === canonicalJson(vector({ likes: 1 })) &&
      input.baseline.id === "named:likes",
    "INPUT_INVALID",
    "baseline",
  );
  expect(
    input.world.listing_url ===
      "https://huggingface.co/api/models?sort=likes&direction=-1&limit=300" &&
      input.world.truth_origin === "https://huggingface.co" &&
      input.world.cohort_start_zero_based === 200 &&
      input.world.cohort_end_exclusive === 300,
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

function verifySelectionSource(input, root = ROOT) {
  const read = (name, hash) => {
    const bytes = readFileSync(resolve(root, name));
    expect(sha256(bytes) === hash, "SELECTION_SOURCE_INVALID", name);
    return bytes;
  };
  const population = parseJson(read("source-population.json", input.source.population_sha256), "SELECTION_SOURCE_INVALID", "population");
  const observation = parseJson(read("selection-observation.json", input.source.selection_observation_sha256), "SELECTION_SOURCE_INVALID", "observation");
  const predictions = parseJson(read("selection-predictions.json", input.source.selection_predictions_sha256), "SELECTION_SOURCE_INVALID", "predictions");
  const truthRows = read("selection-truth.jsonl", input.source.selection_truth_sha256).toString("utf8").trim().split("\n").map((line) => parseJson(Buffer.from(line), "SELECTION_SOURCE_INVALID", "truth"));
  expect(
    input.source.output_evidence.repository === "Spicy-source/Darwin-2nd-placeholder-3rd-darwin-git" &&
      input.source.output_evidence.revision === "acd02aa90793f4ef3277e0d8ee94a518416d7bb8" &&
      input.source.output_evidence.tree === "7910747b93302d2a931042c8f3358f45bbc2506f" &&
      input.source.output_evidence.evidence_root_sha256 === "11c6b3d89c8ca273c07893de5cf6b67ef8c9d769f8253d3c074ac8c9dc5247ac" &&
      population.schema === "darwin.hf-genome-promotion-source-episode/1" &&
      population.darwin.repository === input.source.population_origin.repository &&
      population.darwin.revision === input.source.population_origin.revision &&
      population.darwin.tree === input.source.population_origin.tree,
    "SELECTION_SOURCE_INVALID", "population origin",
  );
  const committed = population.rows.find((row) => row.kind === "predictions_committed");
  expect(committed && canonicalJson(committed.population_weights[input.candidate.id]) === canonicalJson(vector(input.candidate.weights)), "SELECTION_SOURCE_INVALID", "candidate population binding");
  const raw = Buffer.from(observation.raw_base64, "base64");
  expect(sha256(raw) === observation.raw_sha256 && Array.isArray(JSON.parse(raw)), "SELECTION_SOURCE_INVALID", "selection observation");
  const sourceCohort = JSON.parse(raw).map(projectCandidate).slice(100, 200);
  expect(
    predictions.schema === "darwin.hf-genome-promotion-heldout-predictions/1" &&
      predictions.pair_ids.length === 50 && predictions.cohort === input.source_selection.cohort &&
      canonicalJson(predictions.cohort_candidates) === canonicalJson(sourceCohort) &&
      Number.isFinite(predictions.prediction_now_ms) && predictions.prediction_now_ms === Date.parse(observation.provider_date),
    "SELECTION_SOURCE_INVALID", "selection schedule",
  );
  const truth = Object.fromEntries(truthRows.map((row) => {
    const body = parseJson(Buffer.from(row.raw_base64, "base64"), "SELECTION_SOURCE_INVALID", row.repository);
    expect(sha256(Buffer.from(row.raw_base64, "base64")) === row.raw_sha256 && String(body.id ?? body.modelId ?? "") === row.repository && Number(body.downloads) === row.downloads, "SELECTION_SOURCE_INVALID", "selection truth");
    return [row.repository, row.downloads];
  }));
  const ids = predictions.pair_ids.flat();
  expect(new Set(ids).size === 100 && Object.keys(truth).length === 100 && ids.every((id) => Object.hasOwn(truth, id)), "SELECTION_SOURCE_INVALID", "selection truth coverage");
  const byId = new Map(predictions.cohort_candidates.map((candidate) => [candidate.id, candidate]));
  const ranking = Object.entries(committed.population_weights).map(([id, weights]) => ({ id, score: predictions.pair_ids.reduce((score, [a, b]) => score + (decide(vector(weights), byId.get(a), byId.get(b), predictions.prediction_now_ms) === (truth[a] > truth[b] ? "a" : "b") ? 1 : 0), 0) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  expect(
    ranking[0].id === input.candidate.id && ranking[0].score === input.source_selection.candidate_score &&
      ranking[0].score === input.source_selection.population_max_score && input.source_selection.unique_maximum === true &&
      input.source_selection.pair_count === 50 && ranking.filter((row) => row.score === ranking[0].score).length === 1 &&
      ranking[1].score === 34 && ranking.find((row) => row.id === "named:likes")?.score === 31,
    "SELECTION_SOURCE_INVALID", "selection ranking",
  );
  return ranking;
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
      headers: { Accept: "application/json", "User-Agent": "Darwin-Confirmation-Evaluator/1" },
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
      schema: "darwin.hf-genome-confirmation-seed/1",
      candidate_id: input.candidate.id,
      source_evidence_sha256: input.source.output_evidence.evidence_root_sha256,
      source_revision: input.source.output_evidence.revision,
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
    schema: "darwin.hf-genome-confirmation-predictions/1",
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
      row.schema === "darwin.hf-genome-confirmation-truth/1" &&
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
    schema: "darwin.hf-genome-confirmation-result/1",
    evaluation_id: input.evaluation_id,
    evaluated_at: observation.provider_date,
    source: input.source,
    cohort: {
      id: input.world.cohort,
      listing_url: input.world.listing_url,
      ranks_one_based: [201, 300],
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
          ? "The source-selected candidate did not strictly exceed named:likes on both the fresh train and held-out partitions."
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
  verifySelectionSource(input, root);
  const paths = Object.fromEntries(GENERATED.map((name) => [name, resolve(root, name)]));
  for (const [name, path] of Object.entries(paths))
    expect(existsSync(path), "EVIDENCE_MISSING", name);
  const observation = parseJson(
    readFileSync(paths["observation.json"]),
    "OBSERVATION_INVALID",
    "observation",
  );
  expect(
    observation.schema === "darwin.hf-genome-confirmation-observation/1" &&
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
    fileRecord("source_population", resolve(root, "source-population.json")),
    fileRecord("selection_observation", resolve(root, "selection-observation.json")),
    fileRecord("selection_predictions", resolve(root, "selection-predictions.json")),
    fileRecord("selection_truth", resolve(root, "selection-truth.jsonl")),
    fileRecord("harness", resolve(root, "harness.mjs")),
    fileRecord("observation", paths["observation.json"]),
    fileRecord("predictions", paths["predictions.json"]),
    fileRecord("trajectory", paths["trajectory.jsonl"]),
    fileRecord("truth", paths["truth.jsonl"]),
    fileRecord("result", paths["result.json"]),
  ];
  const expectedIndex = {
    schema: "darwin.hf-genome-confirmation-evidence-index/1",
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
    schema: "darwin.hf-genome-confirmation-decision/1",
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
    schema: "darwin.hf-genome-confirmation-observation/1",
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
          schema: "darwin.hf-genome-confirmation-truth/1",
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
    fileRecord("source_population", resolve(ROOT, "source-population.json")),
    fileRecord("selection_observation", resolve(ROOT, "selection-observation.json")),
    fileRecord("selection_predictions", resolve(ROOT, "selection-predictions.json")),
    fileRecord("selection_truth", resolve(ROOT, "selection-truth.jsonl")),
    fileRecord("harness", resolve(ROOT, "harness.mjs")),
    fileRecord("observation", resolve(ROOT, "observation.json")),
    fileRecord("predictions", resolve(ROOT, "predictions.json")),
    fileRecord("trajectory", resolve(ROOT, "trajectory.jsonl")),
    fileRecord("truth", resolve(ROOT, "truth.jsonl")),
    fileRecord("result", resolve(ROOT, "result.json")),
  ];
  const index = {
    schema: "darwin.hf-genome-confirmation-evidence-index/1",
    evaluation_id: input.evaluation_id,
    entries,
    total_files: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    evidence_root_sha256: sha256(canonicalJson(entries)),
  };
  writeJson(resolve(ROOT, "evidence-index.json"), index);
  writeJson(DECISION_PATH, {
    schema: "darwin.hf-genome-confirmation-decision/1",
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

function rebuild() {
  const { input } = loadInput();
  const observationPath = resolve(ROOT, "observation.json");
  const truthPath = resolve(ROOT, "truth.jsonl");
  expect(existsSync(observationPath) && existsSync(truthPath), "REBUILD_INPUT_MISSING", "observation/truth");
  for (const name of ["predictions.json", "trajectory.jsonl", "result.json", "evidence-index.json"])
    expect(!existsSync(resolve(ROOT, name)), "OUTPUT_COLLISION", name);
  expect(!existsSync(DECISION_PATH), "OUTPUT_COLLISION", "decision");
  const observation = parseJson(readFileSync(observationPath), "OBSERVATION_INVALID", "observation");
  const predictions = predictionsFrom(input, observation);
  writeJson(resolve(ROOT, "predictions.json"), predictions);
  const trajectory = expectedTrajectory(observationPath, resolve(ROOT, "predictions.json"), truthPath);
  writeFileSync(resolve(ROOT, "trajectory.jsonl"), `${trajectory.map(canonicalJson).join("\n")}\n`, { encoding: "utf8", flush: true });
  const counters = { successful_responses: 101, http_attempts: 101 };
  const result = resultFrom(input, observation, predictions, readFileSync(truthPath), counters);
  writeJson(resolve(ROOT, "result.json"), result);
  const entries = [
    fileRecord("input", INPUT_PATH), fileRecord("source_population", resolve(ROOT, "source-population.json")),
    fileRecord("selection_observation", resolve(ROOT, "selection-observation.json")), fileRecord("selection_predictions", resolve(ROOT, "selection-predictions.json")),
    fileRecord("selection_truth", resolve(ROOT, "selection-truth.jsonl")), fileRecord("harness", resolve(ROOT, "harness.mjs")),
    fileRecord("observation", observationPath), fileRecord("predictions", resolve(ROOT, "predictions.json")),
    fileRecord("trajectory", resolve(ROOT, "trajectory.jsonl")), fileRecord("truth", truthPath), fileRecord("result", resolve(ROOT, "result.json")),
  ];
  const index = { schema: "darwin.hf-genome-confirmation-evidence-index/1", evaluation_id: input.evaluation_id, entries, total_files: entries.length, total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), evidence_root_sha256: sha256(canonicalJson(entries)) };
  writeJson(resolve(ROOT, "evidence-index.json"), index);
  writeJson(DECISION_PATH, { schema: "darwin.hf-genome-confirmation-decision/1", evaluation_id: input.evaluation_id, result: result.decision.disposition, candidate: input.candidate, baseline: input.baseline, metrics: result.metrics, result_sha256: sha256(readFileSync(resolve(ROOT, "result.json"))), evidence_index_sha256: sha256(readFileSync(resolve(ROOT, "evidence-index.json"))), evidence_root_sha256: index.evidence_root_sha256, promotion_admitted: false, retention_admitted: false, claim_ceiling: input.claim_ceiling });
  console.log(JSON.stringify({ disposition: "REBUILT_OFFLINE", result: verifyBundle().result.decision }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "run") await run();
  else if (command === "rebuild") rebuild();
  else if (command === "verify")
    console.log(JSON.stringify({ disposition: "VERIFIED", result: verifyBundle().result.decision }));
  else fail("COMMAND_INVALID", "use run, rebuild or verify");
}
