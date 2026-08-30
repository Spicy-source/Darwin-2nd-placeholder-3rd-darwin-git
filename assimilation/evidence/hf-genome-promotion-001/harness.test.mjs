import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyBundle } from "./harness.mjs";

const SOURCE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DECISION = resolve(SOURCE, "..", "..", "hf-genome-promotion-001.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = () => {
  const temp = mkdtempSync(join(tmpdir(), "darwin-hf-heldout-audit-"));
  const root = join(temp, "bundle");
  const decisionPath = join(temp, "decision.json");
  cpSync(SOURCE, root, { recursive: true });
  cpSync(SOURCE_DECISION, decisionPath);
  return { decisionPath, root };
};
const rewriteJson = (path, update) => {
  const value = JSON.parse(readFileSync(path, "utf8"));
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const reject = (mutate, code) => {
  const copy = clone();
  mutate(copy);
  assert.throws(() => verifyBundle(copy), (error) => error.code === code);
};

test("portable offline evidence reconstructs with zero provider calls", () => {
  const copy = clone();
  let calls = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = () => {
    calls++;
    throw new Error("network forbidden in verifier");
  };
  try {
    const verified = verifyBundle(copy);
    assert.equal(verified.result.decision.disposition, "REJECT_NO_CROSS_COHORT_GENERALIZATION");
    assert.equal(verified.result.metrics.scoreable_pairs, 50);
    assert.equal(verified.result.metrics.truth_evidence_count, 100);
    assert.ok(
      verified.result.metrics.candidate_train_accuracy <
        verified.result.metrics.baseline_train_accuracy,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = prior;
  }
});

test("source, listing and prediction forgeries fail closed", () => {
  reject(
    ({ root }) =>
      rewriteJson(join(root, "source-episode.json"), (source) => {
        source.rows.find((row) => row.kind === "predictions_committed").population_weights[
          "genome:aef499ba354adef5"
        ].age = 9;
      }),
    "SOURCE_EPISODE_INVALID",
  );
  reject(
    ({ root }) =>
      rewriteJson(join(root, "observation.json"), (observation) => {
        observation.raw_base64 = `${observation.raw_base64.slice(0, -1)}A`;
      }),
    "OBSERVATION_INVALID",
  );
  reject(
    ({ root }) =>
      rewriteJson(join(root, "observation.json"), (observation) => {
        const raw = Buffer.from(observation.raw_base64, "base64");
        const listing = JSON.parse(raw.toString("utf8"));
        listing[100].id = "attacker/replaced-model";
        const changed = Buffer.from(JSON.stringify(listing));
        observation.raw_base64 = changed.toString("base64");
        observation.raw_sha256 = sha256(changed);
        observation.bytes = changed.length;
      }),
    "PREDICTIONS_INVALID",
  );
  for (const field of ["prediction_now_ms", "weights", "prediction"]) {
    reject(
      ({ root }) =>
        rewriteJson(join(root, "predictions.json"), (predictions) => {
          if (field === "prediction_now_ms") predictions.prediction_now_ms++;
          if (field === "weights") predictions.policies.candidate.weights.age = 9;
          if (field === "prediction") predictions.predictions.candidate[0] = "attack";
        }),
      "PREDICTIONS_INVALID",
    );
  }
});

test("missing, duplicate and hash-valid semantic truth forgeries fail closed", () => {
  reject(
    ({ root }) => {
      const path = join(root, "truth.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      writeFileSync(path, `${lines.slice(1).join("\n")}\n`);
    },
    "TRUTH_INVALID",
  );
  reject(
    ({ root }) => {
      const path = join(root, "truth.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      writeFileSync(path, `${[...lines, lines[0]].join("\n")}\n`);
    },
    "TRUTH_INVALID",
  );
  reject(
    ({ root }) => {
      const path = join(root, "truth.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const row = JSON.parse(lines[0]);
      const body = JSON.parse(Buffer.from(row.raw_base64, "base64"));
      body.downloads++;
      const changed = Buffer.from(JSON.stringify(body));
      row.downloads = body.downloads;
      row.raw_base64 = changed.toString("base64");
      row.raw_sha256 = sha256(changed);
      row.bytes = changed.length;
      lines[0] = JSON.stringify(row);
      writeFileSync(path, `${lines.join("\n")}\n`);
    },
    "RESULT_INVALID",
  );
});

test("trajectory, result, index and decision forgeries fail closed", () => {
  reject(
    ({ root }) => {
      const path = join(root, "trajectory.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n").reverse();
      writeFileSync(path, `${lines.join("\n")}\n`);
    },
    "TRAJECTORY_INVALID",
  );
  reject(
    ({ root }) =>
      rewriteJson(join(root, "result.json"), (result) => {
        result.decision.disposition = "PASS_PENDING_EXTERNAL_PROMOTION_AUTHORITY";
      }),
    "RESULT_INVALID",
  );
  reject(
    ({ root }) =>
      rewriteJson(join(root, "evidence-index.json"), (index) => {
        index.entries[0].path = "C:/attacker/input.json";
      }),
    "INDEX_INVALID",
  );
  reject(
    ({ decisionPath }) =>
      rewriteJson(decisionPath, (decision) => {
        decision.promotion_admitted = true;
      }),
    "DECISION_INVALID",
  );
});
