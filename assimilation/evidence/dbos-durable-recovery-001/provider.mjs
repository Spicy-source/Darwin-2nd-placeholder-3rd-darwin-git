import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseArgs,
  readJson,
  sha256,
  sleep,
  writeBytesDurable,
  writeJsonAtomic,
} from "./common.mjs";

const args = parseArgs();
const root = String(args.root ?? "");
const portFile = String(args["port-file"] ?? "");
if (!root || !portFile) throw new Error("PROVIDER_ARGS_REQUIRED");
mkdirSync(root, { recursive: true });

const markerPath = join(root, "marker.bin");
const statePath = join(root, "provider-state.json");
const commitBarrier = join(root, "provider-commit.barrier.json");
const commitRelease = join(root, "provider-commit.release");
let state = existsSync(statePath)
  ? readJson(statePath)
  : { protocol: "darwin.local-marker-provider/v1", key: null, created_count: 0, ensure_calls: 0, inspections: 0, events: [] };

const save = () => writeJsonAtomic(statePath, state);
const event = (kind, detail = {}) => {
  state.events.push({ sequence: state.events.length, kind, ...detail });
  save();
};
const marker = () => (existsSync(markerPath) ? readFileSync(markerPath) : null);

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("PROVIDER_BODY_OVERSIZED");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes);
}

function sendJson(res, status, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
  res.end(bytes);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/state") {
      const bytes = marker();
      return sendJson(res, 200, {
        ...state,
        marker_base64: bytes?.toString("base64") ?? null,
        marker_sha256: bytes ? sha256(bytes) : null,
      });
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      sendJson(res, 200, { status: "shutting_down" });
      return server.close();
    }
    if (url.pathname !== "/marker") return sendJson(res, 404, { error: "NOT_FOUND" });
    const key = url.searchParams.get("key");
    if (!key) return sendJson(res, 400, { error: "KEY_REQUIRED" });

    if (req.method === "GET") {
      state.inspections += 1;
      const bytes = marker();
      event("inspect", { key, present: Boolean(bytes) });
      if (!bytes) return sendJson(res, 404, { status: "missing", key });
      if (state.key !== key) return sendJson(res, 409, { error: "FOREIGN_KEY" });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
        "x-content-sha256": sha256(bytes),
      });
      return res.end(bytes);
    }

    if (req.method === "PUT") {
      const bytes = await body(req);
      state.ensure_calls += 1;
      const existing = marker();
      let created = false;
      if (existing) {
        if (state.key !== key || !existing.equals(bytes)) {
          event("ensure_conflict", { key });
          return sendJson(res, 409, { error: "MARKER_CONFLICT" });
        }
      } else {
        writeBytesDurable(markerPath, bytes, "wx");
        state.key = key;
        state.created_count += 1;
        created = true;
      }
      event(created ? "created" : "existing_exact", { key, sha256: sha256(bytes) });
      if (created && req.headers["x-fault-after-commit"] === "1") {
        writeJsonAtomic(commitBarrier, { key, sha256: sha256(bytes), created_count: state.created_count });
        while (!existsSync(commitRelease)) await sleep(20);
      }
      return sendJson(res, created ? 201 : 200, {
        status: created ? "created" : "existing_exact",
        key,
        sha256: sha256(bytes),
      });
    }

    return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  writeJsonAtomic(portFile, { host: "127.0.0.1", port: address.port, pid: process.pid });
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));

