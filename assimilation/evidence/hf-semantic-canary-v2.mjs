import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

const MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41";
const CACHE = join(import.meta.dirname, "cache");
const LOCAL_MODEL = join(CACHE, MODEL, REVISION);
const RESULT = join(import.meta.dirname, "result-v2.json");
const MiB = 1024 * 1024;

const docs = [
  ["owner-1", "STATE_OWNER", "The mission store at src/forecast/store.mjs is the sole writer of mutable mission truth and lease fences; workers only propose changes."],
  ["owner-2", "STATE_OWNER", "One canonical record owns each changing fact. Models and temporary runtimes cannot become the authoritative state owner."],
  ["authority-1", "AUTHORITY_GATE", "BIBLE-00 requires an external authority gate to verify scope, expiry, revocation, and the legal grant before work becomes executable."],
  ["authority-2", "AUTHORITY_GATE", "Possessing a tool is capability, not permission. Protected admission decides whether an action is allowed now."],
  ["receipt-1", "EVIDENCE_RECEIPT", "BuilderReceiptV2 binds producer inputs, outputs, hashes, commands, tests, and claim ceiling for independent reconstruction."],
  ["receipt-2", "EVIDENCE_RECEIPT", "A durable verification receipt lets a fresh auditor reproduce the result without trusting the producing agent's report."],
  ["continuity-1", "DURABLE_CONTINUITY", "mission.db and content-addressed checkpoints preserve organism state after context loss, process death, or model replacement."],
  ["continuity-2", "DURABLE_CONTINUITY", "Inference is disposable; durable continuity lives in persistent state and replayable evidence rather than a model conversation."],
  ["rollback-1", "ROLLBACK", "A semantic canary writes only to side-index:semantic-v1 so a veto can delete it and restore the lexical incumbent without migration."],
  ["rollback-2", "ROLLBACK", "Rollback disables the challenger, removes its namespaced state, and leaves the proven baseline unchanged."],
  ["frontier-1", "LEGAL_FRONTIER", "Closure Controller 1217755807389746 separates admitted READY work from research, history, deferred ideas, and merely mentioned tasks."],
  ["frontier-2", "LEGAL_FRONTIER", "The live readiness frontier, not an attractive backlog entry, determines which bounded ticket may execute now."],
  ["effect-1", "EFFECT_COMMITMENT", "darwin.effect-receipt.v1 reconciles a provider result to a durable outbox intent; ambiguous outcomes are inspected before retry."],
  ["effect-2", "EFFECT_COMMITMENT", "An external effect commitment records intent before action and never blindly repeats an uncertain provider call."],
  ["edge-1", "PRODUCER_CONSUMER", "hf-semantic-receptor-001 is functional only when its typed observation changes a named downstream consumer decision and observable consequence."],
  ["edge-2", "PRODUCER_CONSUMER", "A producer-consumer edge proves a receptor matters by tracing sensed evidence through a decision to a measurable world delta."],
].map(([id, label, text]) => ({ id, label, text }));

const queries = [
  ["q-owner-l", "lexical", "STATE_OWNER", "Which state owner writes mutable mission truth?"],
  ["q-owner-p", "paraphrase", "STATE_OWNER", "Which durable component has final say when two agents disagree?"],
  ["q-authority-l", "lexical", "AUTHORITY_GATE", "Which authority gate admits executable work?"],
  ["q-authority-p", "paraphrase", "AUTHORITY_GATE", "What proves a builder is entitled to proceed rather than merely able?"],
  ["q-receipt-l", "lexical", "EVIDENCE_RECEIPT", "Which evidence receipt binds hashes and test commands?"],
  ["q-receipt-p", "paraphrase", "EVIDENCE_RECEIPT", "How can a stranger check yesterday's claimed outcome from artifacts alone?"],
  ["q-continuity-l", "lexical", "DURABLE_CONTINUITY", "What durable continuity survives process death?"],
  ["q-continuity-p", "paraphrase", "DURABLE_CONTINUITY", "If every running program and chat vanish, what lets the same being resume?"],
  ["q-rollback-l", "lexical", "ROLLBACK", "How does rollback restore the incumbent after a failed canary?"],
  ["q-rollback-p", "paraphrase", "ROLLBACK", "Where should a trial place reversible bytes so failure leaves production untouched?"],
  ["q-frontier-l", "lexical", "LEGAL_FRONTIER", "Which legal frontier separates READY from mentioned work?"],
  ["q-frontier-p", "paraphrase", "LEGAL_FRONTIER", "Which source tells me today's lawful next move instead of everything someone proposed?"],
  ["q-effect-l", "lexical", "EFFECT_COMMITMENT", "How is an effect commitment reconciled after an outbox intent?"],
  ["q-effect-p", "paraphrase", "EFFECT_COMMITMENT", "A remote API timed out after sending; how do we avoid doing it twice?"],
  ["q-edge-l", "lexical", "PRODUCER_CONSUMER", "What producer consumer edge proves a receptor is functional?"],
  ["q-edge-p", "paraphrase", "PRODUCER_CONSUMER", "What demonstrates that a new sensor improved behavior rather than becoming dead code?"],
  ["q-owner-x", "exact", "STATE_OWNER", "src/forecast/store.mjs"],
  ["q-authority-x", "exact", "AUTHORITY_GATE", "BIBLE-00"],
  ["q-receipt-x", "exact", "EVIDENCE_RECEIPT", "BuilderReceiptV2"],
  ["q-continuity-x", "exact", "DURABLE_CONTINUITY", "mission.db"],
  ["q-rollback-x", "exact", "ROLLBACK", "side-index:semantic-v1"],
  ["q-frontier-x", "exact", "LEGAL_FRONTIER", "1217755807389746"],
  ["q-effect-x", "exact", "EFFECT_COMMITMENT", "darwin.effect-receipt.v1"],
  ["q-edge-x", "exact", "PRODUCER_CONSUMER", "hf-semantic-receptor-001"],
].map(([id, kind, expectedLabel, text]) => ({ id, kind, expectedLabel, text }));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (process.argv.includes("--fixture-only")) {
  console.log(JSON.stringify({ fixtureSha256: sha256(JSON.stringify({ docs, queries })), documents: docs.length, queries: queries.length }));
  process.exit(0);
}
const tokens = (text) => text.toLowerCase().match(/[a-z0-9]+(?:[._:/-][a-z0-9]+)*/g) ?? [];
const rankLexical = (query) => {
  const wanted = new Set(tokens(query));
  return docs
    .map((doc) => {
      const have = new Set(tokens(doc.text));
      const overlap = [...wanted].filter((token) => have.has(token)).length;
      const exact = doc.text.toLowerCase().includes(query.toLowerCase()) ? 10 : 0;
      return { id: doc.id, label: doc.label, score: exact + overlap / Math.max(1, wanted.size) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
};
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const rankDense = (vector, docVectors) => docs
  .map((doc, index) => ({ id: doc.id, label: doc.label, score: dot(vector, docVectors[index]) }))
  .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
const rankUnion = (lexical, dense) => [...lexical, ...dense].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
const hit = (ranking, label, k) => ranking.slice(0, k).some((item) => item.label === label);
const reciprocalRank = (ranking, label) => {
  const index = ranking.findIndex((item) => item.label === label);
  return index < 0 ? 0 : 1 / (index + 1);
};
const metrics = (rows, field) => ({
  hit1: rows.filter((row) => hit(row[field], row.expectedLabel, 1)).length,
  hit3: rows.filter((row) => hit(row[field], row.expectedLabel, 3)).length,
  mrr: rows.reduce((sum, row) => sum + reciprocalRank(row[field], row.expectedLabel), 0) / rows.length,
  total: rows.length,
});
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function fileEvidence(relative, expectedSha256, expectedBytes) {
  const path = join(CACHE, MODEL, REVISION, relative);
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedSha256 || bytes.length !== expectedBytes) throw new Error(`ARTIFACT_MISMATCH:${relative}`);
  return { relative, sha256: expectedSha256, bytes: expectedBytes };
}

env.allowRemoteModels = false;
env.allowLocalModels = true;
let observedRss = process.memoryUsage().rss;
const load = (modelFileName) => pipeline("feature-extraction", LOCAL_MODEL, {
  local_files_only: true,
  device: "cpu",
  dtype: "fp32",
  model_file_name: modelFileName,
});
const embed = async (extractor, texts) => (await extractor(texts, { pooling: "mean", normalize: true })).tolist();

const quantized = await load("model_quint8_avx2");
const indexStart = performance.now();
const qDocs = await embed(quantized, docs.map(({ text }) => text));
const indexBuildMs = performance.now() - indexStart;
const qQueries = await embed(quantized, queries.map(({ text }) => text));
await embed(quantized, ["warmup"]);
const latencyMs = [];
for (const query of queries.filter(({ kind }) => kind !== "exact")) {
  const started = performance.now();
  await embed(quantized, [query.text]);
  latencyMs.push(performance.now() - started);
  observedRss = Math.max(observedRss, process.memoryUsage().rss);
}
await quantized.dispose();

const fp32 = await load("model");
const parityTexts = [...docs.map(({ text }) => text), ...queries.filter(({ kind }) => kind !== "exact").map(({ text }) => text)];
const fpVectors = await embed(fp32, parityTexts);
observedRss = Math.max(observedRss, process.memoryUsage().rss);
await fp32.dispose();

const qParity = [...qDocs, ...qQueries.slice(0, 16)];
const vectorParity = qParity.map((vector, index) => dot(vector, fpVectors[index]));
const rows = queries.map((query, index) => {
  const lexical = rankLexical(query.text);
  const dense = rankDense(qQueries[index], qDocs);
  return { ...query, lexical, dense, union: rankUnion(lexical, dense) };
});
const semantic = rows.filter(({ kind }) => kind !== "exact");
const paraphrase = rows.filter(({ kind }) => kind === "paraphrase");
const exact = rows.filter(({ kind }) => kind === "exact");
const protectedLabels = new Set(["AUTHORITY_GATE", "EFFECT_COMMITMENT"]);
const wrongProtectedTop3 = semantic.flatMap((row) => row.dense.slice(0, 3)
  .filter(({ label }) => protectedLabels.has(label) && label !== row.expectedLabel)
  .map((rank) => ({ query: row.id, got: rank.label, expected: row.expectedLabel })));
const fpDocVectors = fpVectors.slice(0, docs.length);
const fpQueryVectors = fpVectors.slice(docs.length);
const parityTop1Agreement = semantic.filter((row, index) => rankDense(fpQueryVectors[index], fpDocVectors)[0].label === row.dense[0].label).length;

const qArtifact = await fileEvidence("onnx/model_quint8_avx2.onnx", "b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21", 23046789);
const fpArtifact = await fileEvidence("onnx/model.onnx", "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452", 90405214);
const modelPayloadBytes = qArtifact.bytes + fpArtifact.bytes;
const packageLock = JSON.parse(await readFile(join(import.meta.dirname, "package-lock.json"), "utf8"));
const runtimePackage = packageLock.packages["node_modules/@huggingface/transformers"];
const gates = {
  fixtureHasHeadroom: metrics(paraphrase, "lexical").hit3 <= 5,
  paraphraseHit3DeltaAtLeast3: metrics(paraphrase, "dense").hit3 - metrics(paraphrase, "lexical").hit3 >= 3,
  protectedMisrouteZero: wrongProtectedTop3.length === 0,
  protectedQueriesTop1: semantic.filter(({ expectedLabel }) => protectedLabels.has(expectedLabel)).every((row) => row.dense[0].label === row.expectedLabel),
  exactUnionNoRegression: metrics(exact, "union").hit1 >= metrics(exact, "lexical").hit1 && metrics(exact, "union").hit3 >= metrics(exact, "lexical").hit3,
  onnxVectorParity: Math.min(...vectorParity) >= 0.985,
  onnxTop1Parity: parityTop1Agreement >= 15,
  modelPayloadWithin150MiB: modelPayloadBytes <= 150 * MiB,
  indexBuildWithin10Minutes: indexBuildMs <= 600_000,
  warmP95Within200Ms: percentile(latencyMs, 0.95) <= 200,
  observedRssWithin1_5GiB: observedRss <= 1.5 * 1024 * MiB,
};
const passed = Object.values(gates).every(Boolean);
const result = {
  protocol: "darwin.hf-semantic-receptor-canary/v2",
  decision: !gates.fixtureHasHeadroom ? "NOT_COMPARABLE_FIXTURE_NO_HEADROOM" : passed ? "CANARY_QUALIFIED_SHADOW_ONLY" : "REJECT_RETAIN_LEXICAL_BASELINE",
  cutoffDate: "2026-08-29",
  claimCeiling: "FIXED_SYNTHETIC_RETRIEVAL_CANARY_ONLY_NO_AUTHORITY_NO_ADOPTION",
  searchStopContract: {
    decisionToSupport: "Whether MiniLM merits a shadow-only Darwin semantic receptor canary",
    capabilityFailure: "Recover short paraphrased capability evidence that lexical overlap misses",
    incumbent: "deterministic token-overlap lexical retrieval",
    deferredChallengers: ["BAAI/bge-small-en-v1.5@5c38ec7c405ec4b44b94cc5a9bb96e735b38267a", "jinaai/jina-embeddings-v2-small-en@44e7d1d6caec8c883c2d4b207588504d519788d0"],
    knownGap: "Synthetic 16-document fixture; no production Darwin archive or downstream decision delta",
  },
  model: { id: MODEL, revision: REVISION, license: "Apache-2.0", runtime: { package: "@huggingface/transformers", version: runtimePackage.version, integrity: runtimePackage.integrity, license: "Apache-2.0" }, artifacts: [qArtifact, fpArtifact], modelPayloadBytes },
  fixture: { sha256: sha256(JSON.stringify({ docs, queries })), documents: docs.length, queries: queries.length, labels: new Set(docs.map(({ label }) => label)).size },
  metrics: { semantic: { lexical: metrics(semantic, "lexical"), dense: metrics(semantic, "dense") }, paraphrase: { lexical: metrics(paraphrase, "lexical"), dense: metrics(paraphrase, "dense") }, exact: { lexical: metrics(exact, "lexical"), dense: metrics(exact, "dense"), union: metrics(exact, "union") } },
  parity: { minimumCosine: Math.min(...vectorParity), top1Agreement: parityTop1Agreement, total: semantic.length },
  resources: { indexBuildMs, warmLatencyMs: { n: latencyMs.length, median: percentile(latencyMs, 0.5), p95: percentile(latencyMs, 0.95), min: Math.min(...latencyMs), max: Math.max(...latencyMs) }, observedRssBytes: observedRss, modelPayloadBytes },
  gates,
  wrongProtectedTop3,
  rankings: rows,
};
await writeFile(RESULT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: RESULT, decision: result.decision, fixtureSha256: result.fixture.sha256, gates, metrics: result.metrics, parity: result.parity, resources: result.resources }, null, 2));
if (!passed) process.exitCode = 2;
