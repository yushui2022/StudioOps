import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InferenceGateway,
  type BackendConfig,
} from "../services/gateway/src/gateway.js";
import {
  extractModel,
  MemoryGuard,
  type MemoryAdmission,
} from "../services/gateway/src/memory.js";
import {
  sameResidentModel,
  UsageObserver,
} from "../services/gateway/src/usage.js";

interface HarnessOptions {
  concurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  admission?: MemoryAdmission;
  recordsFile?: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

interface Harness {
  gateway: InferenceGateway;
  port: number;
  adminPort: number;
  base: string;
  admin: string;
  close: () => Promise<void>;
}

async function startHarness(options: HarnessOptions): Promise<Harness> {
  const upstream = http.createServer(options.handler);
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const backendConfig: BackendConfig = {
    name: "ollama",
    listenPort: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    concurrency: options.concurrency ?? 1,
    maxQueue: options.maxQueue ?? 8,
    queueTimeoutMs: options.queueTimeoutMs ?? 10_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
  };
  const gateway = new InferenceGateway({
    backends: [backendConfig],
    adminPort: 0,
    version: "test",
    admission: options.admission,
    recordsFile: options.recordsFile,
  });
  await gateway.start();
  const addresses = gateway.addresses();
  const port = addresses.backends.ollama ?? 0;
  return {
    gateway,
    port,
    adminPort: addresses.admin,
    base: `http://127.0.0.1:${port}`,
    admin: `http://127.0.0.1:${addresses.admin}`,
    close: async () => {
      await gateway.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function status(harness: Harness) {
  const response = await fetch(`${harness.admin}/status`);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    backends: Array<{
      active: number;
      queued: number;
      stats: Record<string, number>;
      activeJobs: Array<{ id: string; client?: string }>;
      queuedJobs: Array<{ id: string; client?: string }>;
      listenPort: number;
      upstream: string;
    }>;
    recent: Array<{
      state: string;
      path: string;
      error?: string;
      client?: string;
      bytes: number;
    }>;
  };
}

test("gateway forwards method, path, query and body to upstream", async () => {
  const harness = await startHarness({
    handler: (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString("utf8"),
            host: req.headers.host,
          }),
        );
      });
    },
  });
  try {
    const response = await fetch(`${harness.base}/api/generate?stream=false`, {
      method: "POST",
      body: "hello",
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      method: string;
      url: string;
      body: string;
      host: string;
    };
    assert.equal(payload.method, "POST");
    assert.equal(payload.url, "/api/generate?stream=false");
    assert.equal(payload.body, "hello");
    assert.match(payload.host, /^127\.0\.0\.1:\d+$/);
  } finally {
    await harness.close();
  }
});

test("gateway streams upstream chunks without buffering the response", async () => {
  const harness = await startHarness({
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first\n");
      setTimeout(() => res.end("second\n"), 150);
    },
  });
  try {
    const started = Date.now();
    const response = await fetch(`${harness.base}/api/chat`);
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    const firstChunk = Buffer.from(first.value ?? []).toString("utf8");
    assert.equal(firstChunk, "first\n");
    assert.ok(
      Date.now() - started < 140,
      "first chunk should arrive before upstream finishes",
    );
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += Buffer.from(chunk.value).toString("utf8");
    }
    assert.equal(rest, "second\n");
  } finally {
    await harness.close();
  }
});

test("gateway limits concurrency and releases slots in order", async () => {
  let running = 0;
  let peak = 0;
  const harness = await startHarness({
    concurrency: 2,
    handler: (_req, res) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        res.end("ok");
      }, 60);
    },
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => fetch(`${harness.base}/api/tags`)),
    );
    assert.deepEqual(
      results.map((response) => response.status),
      [200, 200, 200, 200, 200, 200],
    );
    assert.equal(peak, 2);
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.started, 6);
    assert.equal(snapshot.backends[0]?.stats.completed, 6);
    assert.equal(snapshot.backends[0]?.active, 0);
    assert.equal(snapshot.backends[0]?.queued, 0);
  } finally {
    await harness.close();
  }
});

test("gateway rejects with 429 when the queue is full", async () => {
  const gate = deferred();
  const started = deferred();
  const harness = await startHarness({
    concurrency: 1,
    maxQueue: 1,
    handler: (_req, res) => {
      started.resolve();
      gate.promise.then(() => res.end("ok"));
    },
  });
  try {
    const first = fetch(`${harness.base}/first`);
    await started.promise;
    const second = fetch(`${harness.base}/second`);
    await waitFor(
      async () => (await status(harness)).backends[0]?.queued === 1,
    );
    const third = await fetch(`${harness.base}/third`);
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("retry-after"), "15");
    assert.match(
      ((await third.json()) as { error: string }).error,
      /Queue is full/,
    );
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.rejected, 1);
    gate.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally {
    await harness.close();
  }
});

test("gateway returns 503 when the queue wait times out", async () => {
  const gate = deferred();
  const started = deferred();
  const harness = await startHarness({
    concurrency: 1,
    maxQueue: 4,
    queueTimeoutMs: 80,
    handler: (_req, res) => {
      started.resolve();
      gate.promise.then(() => res.end("ok"));
    },
  });
  try {
    const first = fetch(`${harness.base}/first`);
    await started.promise;
    const startedAt = Date.now();
    const second = await fetch(`${harness.base}/second`);
    assert.equal(second.status, 503);
    assert.ok(Date.now() - startedAt >= 70);
    assert.match(
      ((await second.json()) as { error: string }).error,
      /Queue wait timed out/,
    );
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.timedOut, 1);
    gate.resolve();
    await first;
  } finally {
    await harness.close();
  }
});

test("gateway removes queued request when the client disconnects", async () => {
  const gate = deferred();
  const started = deferred();
  const harness = await startHarness({
    concurrency: 1,
    handler: (_req, res) => {
      started.resolve();
      gate.promise.then(() => res.end("ok"));
    },
  });
  try {
    const first = fetch(`${harness.base}/first`);
    await started.promise;
    const controller = new AbortController();
    const second = fetch(`${harness.base}/second`, {
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(
      async () => (await status(harness)).backends[0]?.queued === 1,
    );
    controller.abort();
    await second;
    await waitFor(
      async () => (await status(harness)).backends[0]?.queued === 0,
    );
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.cancelled, 1);
    gate.resolve();
    await first;
  } finally {
    await harness.close();
  }
});

test("gateway cancels a queued job via the admin API", async () => {
  const gate = deferred();
  const started = deferred();
  const harness = await startHarness({
    concurrency: 1,
    handler: (_req, res) => {
      started.resolve();
      gate.promise.then(() => res.end("ok"));
    },
  });
  try {
    const first = fetch(`${harness.base}/first`);
    await started.promise;
    const second = fetch(`${harness.base}/second`);
    await waitFor(
      async () => (await status(harness)).backends[0]?.queued === 1,
    );
    const snapshot = await status(harness);
    const queuedId = snapshot.backends[0]?.queuedJobs[0]?.id;
    assert.ok(queuedId);
    const response = await fetch(
      `${harness.admin}/queue/${encodeURIComponent(queuedId)}/cancel`,
      { method: "POST" },
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { state: string }).state,
      "queued",
    );
    assert.equal((await second).status, 409);
    const missing = await fetch(`${harness.admin}/queue/missing/cancel`, {
      method: "POST",
    });
    assert.equal(missing.status, 404);
    gate.resolve();
    await first;
  } finally {
    await harness.close();
  }
});

test("gateway aborts the upstream request when the client disconnects", async () => {
  const started = deferred();
  let upstreamAborted = false;
  const harness = await startHarness({
    concurrency: 1,
    handler: (req, res) => {
      started.resolve();
      req.on("aborted", () => {
        upstreamAborted = true;
      });
      res.on("close", () => {
        if (!res.writableEnded) upstreamAborted = true;
      });
    },
  });
  try {
    const controller = new AbortController();
    const response = fetch(`${harness.base}/api/chat`, {
      signal: controller.signal,
    }).catch(() => undefined);
    await started.promise;
    controller.abort();
    await response;
    await waitFor(() => upstreamAborted);
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.active, 0);
    assert.equal(snapshot.backends[0]?.stats.cancelled, 1);
  } finally {
    await harness.close();
  }
});

test("gateway returns 504 when the request exceeds its deadline", async () => {
  const harness = await startHarness({
    requestTimeoutMs: 120,
    handler: () => {
      // Never respond.
    },
  });
  try {
    const response = await fetch(`${harness.base}/api/generate`);
    assert.equal(response.status, 504);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /timed out/,
    );
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.timedOut, 1);
  } finally {
    await harness.close();
  }
});

test("gateway rejects oversized request bodies with 413", async () => {
  const harness = await startHarness({
    maxBodyBytes: 16,
    handler: (_req, res) => res.end("should not happen"),
  });
  try {
    const response = await fetch(`${harness.base}/api/generate`, {
      method: "POST",
      body: "x".repeat(64),
    });
    assert.equal(response.status, 413);
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.rejected, 1);
    assert.equal(snapshot.backends[0]?.stats.started, 0);
  } finally {
    await harness.close();
  }
});

test("gateway records forwarded client address without logging bodies", async () => {
  const harness = await startHarness({
    handler: (_req, res) => res.end("ok"),
  });
  try {
    const response = await fetch(`${harness.base}/api/chat`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      body: "secret-prompt-must-not-be-recorded",
    });
    assert.equal(response.status, 200);
    const snapshot = await status(harness);
    assert.equal(snapshot.recent[0]?.client, "203.0.113.9");
    assert.equal(
      JSON.stringify(snapshot).includes("secret-prompt"),
      false,
      "request body must not appear in gateway status",
    );
  } finally {
    await harness.close();
  }
});

test("gateway LaunchAgent plist keeps the service resident and loopback-only", async () => {
  const { buildGatewayPlist } =
    await import("../services/agent/src/core/gateway-service.js");
  const dataDir = await import("node:fs").then((fs) =>
    fs.mkdtempSync(join(tmpdir(), "studioops-gateway-")),
  );
  const plist = buildGatewayPlist({
    dataDir,
    nodePath: "/Users/example/.local/bin/node",
  });
  assert.equal(plist.label, "com.studioops.inference-gateway");
  assert.ok(plist.scriptPath.startsWith(dataDir));
  assert.match(plist.content, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist.content, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist.content, /STUDIOOPS_GATEWAY_OLLAMA_PORT/);
  assert.equal(
    plist.content.includes(
      "STUDIOOPS_GATEWAY_OLLAMA_PORT</key>\n    <string>11435</string>",
    ),
    true,
  );
});

test("gateway script discovery supports packaged and dev layouts", async () => {
  const { findGatewayScript } =
    await import("../services/agent/src/core/gateway-service.js");
  const root = mkdtempSync(join(tmpdir(), "studioops-gateway-root-"));
  assert.equal(findGatewayScript(root), undefined);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "gateway.cjs"), "// dev\n");
  assert.equal(findGatewayScript(root), join(root, "dist", "gateway.cjs"));
  writeFileSync(join(root, "gateway.cjs"), "// packaged\n");
  assert.equal(findGatewayScript(root), join(root, "gateway.cjs"));
});

test("gateway rejects requests when memory admission denies them", async () => {
  const admission: MemoryAdmission = {
    status: () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 60 * 1024 ** 3,
      freeBytes: 4 * 1024 ** 3,
      percent: 93.75,
      budgetBytes: 52 * 1024 ** 3,
      reserveBytes: 12 * 1024 ** 3,
      pressure: "high",
      ollama: { loadedModels: [], maxLoadedModels: 1 },
    }),
    admit: (request) =>
      request.method === "POST"
        ? {
            allowed: false,
            code: "memory",
            reason: "内存准入：测试拒绝",
          }
        : { allowed: true },
  };
  const harness = await startHarness({
    admission,
    handler: (_req, res) => res.end("should not happen"),
  });
  try {
    const blocked = await fetch(`${harness.base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ model: "qwen" }),
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get("retry-after"), "30");
    assert.equal(((await blocked.json()) as { code: string }).code, "memory");
    const allowed = await fetch(`${harness.base}/api/tags`);
    assert.equal(allowed.status, 200);
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.rejected, 1);
    assert.equal(snapshot.backends[0]?.stats.started, 1);
    const blockedEvent = snapshot.recent.find(
      (event) => event.path === "/api/chat",
    );
    assert.equal(blockedEvent?.state, "rejected");
  } finally {
    await harness.close();
  }
});

test("memory guard enforces the model slot and the memory budget", async () => {
  const readMemory = async () => ({
    totalBytes: 64 * 1024 ** 3,
    usedBytes: 20 * 1024 ** 3,
    freeBytes: 44 * 1024 ** 3,
  });
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [{ name: "loaded-model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const guard = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    maxLoadedModels: 1,
    readMemory,
    fetchImpl,
  });
  await guard.start();
  guard.stop();
  assert.deepEqual(guard.status().ollama.loadedModels, ["loaded-model"]);
  assert.equal(guard.status().pressure, "normal");
  assert.equal(
    (
      await guard.admit({
        backend: "ollama",
        method: "POST",
        path: "/api/chat",
        model: "loaded-model",
      })
    ).allowed,
    true,
  );
  const slot = await guard.admit({
    backend: "ollama",
    method: "POST",
    path: "/api/chat",
    model: "another-model",
  });
  assert.equal(slot.allowed, false);
  assert.equal(slot.code, "model-slot");
  assert.equal(
    (
      await guard.admit({
        backend: "ollama",
        method: "GET",
        path: "/api/tags",
        model: "another-model",
      })
    ).allowed,
    true,
  );

  const highGuard = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 55 * 1024 ** 3,
      freeBytes: 9 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await highGuard.start();
  highGuard.stop();
  assert.equal(highGuard.status().pressure, "high");
  assert.equal(
    (
      await highGuard.admit({
        backend: "ollama",
        method: "POST",
        path: "/api/chat",
        model: "loaded-model",
      })
    ).allowed,
    true,
  );
  const denied = await highGuard.admit({
    backend: "comfyui",
    method: "POST",
    path: "/prompt",
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "memory");
  const openAiDenied = await highGuard.admit({
    backend: "ollama",
    method: "POST",
    path: "/v1/chat/completions",
    model: "another-model",
  });
  assert.equal(openAiDenied.allowed, false);
  assert.equal(openAiDenied.code, "memory");
  assert.equal(
    (
      await highGuard.admit({
        backend: "comfyui",
        method: "GET",
        path: "/queue",
      })
    ).allowed,
    true,
  );
  assert.equal(extractModel(Buffer.from('{"model":"qwen3"}')), "qwen3");
  assert.equal(extractModel(Buffer.from("not json")), undefined);
});

test("memory guard unloads an idle model to make room for a new one", async () => {
  let loaded = ["idle-model"];
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ps") {
      return new Response(
        JSON.stringify({
          models: loaded.map((name) => ({ name })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    calls.push(url.pathname);
    if (url.pathname === "/api/generate") {
      loaded = [];
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unsupported", { status: 404 });
  }) as typeof fetch;
  const guard = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    maxLoadedModels: 1,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 20 * 1024 ** 3,
      freeBytes: 44 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await guard.start();
  guard.stop();
  const blocked = await guard.admit({
    backend: "ollama",
    method: "POST",
    path: "/api/chat",
    model: "new-model",
    activeModels: ["idle-model"],
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "model-slot");
  const allowed = await guard.admit({
    backend: "ollama",
    method: "POST",
    path: "/api/chat",
    model: "new-model",
    activeModels: [],
  });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(calls, ["/api/generate"]);
  assert.deepEqual(guard.status().ollama.loadedModels, []);
});

test("gateway cancels an admission check when the client disconnects", async () => {
  const admitEntered = deferred();
  const release = deferred();
  let upstreamCalled = false;
  const admission: MemoryAdmission = {
    status: () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 20 * 1024 ** 3,
      freeBytes: 44 * 1024 ** 3,
      percent: 31.25,
      budgetBytes: 52 * 1024 ** 3,
      reserveBytes: 12 * 1024 ** 3,
      pressure: "normal",
      ollama: { loadedModels: [], maxLoadedModels: 1 },
    }),
    admit: async () => {
      admitEntered.resolve();
      await release.promise;
      return { allowed: true };
    },
  };
  const harness = await startHarness({
    admission,
    handler: (_req, res) => {
      upstreamCalled = true;
      res.end("ok");
    },
  });
  try {
    const controller = new AbortController();
    const request = fetch(`${harness.base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ model: "qwen" }),
      signal: controller.signal,
    }).catch(() => undefined);
    await admitEntered.promise;
    controller.abort();
    await waitFor(
      async () => (await status(harness)).backends[0]?.stats.cancelled === 1,
    );
    release.resolve();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(upstreamCalled, false);
    const snapshot = await status(harness);
    assert.equal(snapshot.backends[0]?.stats.started, 0);
    assert.equal(snapshot.backends[0]?.active, 0);
    assert.equal(snapshot.backends[0]?.queued, 0);
  } finally {
    await harness.close();
  }
});

test("gateway persists model call records without request bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-records-"));
  const recordsFile = join(root, "model-calls.jsonl");
  const harness = await startHarness({
    recordsFile,
    handler: (_req, res) => res.end("ok"),
  });
  try {
    const prompt = "secret-prompt-must-not-be-recorded";
    const response = await fetch(`${harness.base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: "qwen3.8-test",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    assert.equal(response.status, 200);
    await fetch(`${harness.base}/api/tags`);
    await waitFor(async () => {
      const records = await (await fetch(`${harness.admin}/records`)).json();
      return (records as { records: unknown[] }).records.length === 1;
    });
    const recordsResponse = await fetch(`${harness.admin}/records?limit=10`);
    assert.equal(recordsResponse.status, 200);
    const records = (await recordsResponse.json()) as {
      records: Array<{
        backend: string;
        model?: string;
        state: string;
        path: string;
        durationMs?: number;
      }>;
    };
    assert.equal(records.records.length, 1);
    assert.equal(records.records[0]?.backend, "ollama");
    assert.equal(records.records[0]?.model, "qwen3.8-test");
    assert.equal(records.records[0]?.state, "completed");
    assert.equal(records.records[0]?.path, "/api/chat");
    assert.ok(Number.isFinite(records.records[0]?.durationMs));
    const raw = readFileSync(recordsFile, "utf8");
    assert.match(raw, /qwen3\.8-test/);
    assert.equal(raw.includes(prompt), false);
    const summary = await status(harness);
    assert.equal(
      summary.recent.some((event) => event.path === "/api/tags"),
      true,
    );
  } finally {
    await harness.close();
  }
});

test("memory guard keeps free memory headroom for ComfyUI", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const tight = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 45 * 1024 ** 3,
      freeBytes: 19 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await tight.start();
  tight.stop();
  const denied = await tight.admit({
    backend: "comfyui",
    method: "POST",
    path: "/v1/images/generations",
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "memory");
  assert.match(denied.reason ?? "", /ComfyUI 需要至少/);

  const roomy = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 34 * 1024 ** 3,
      freeBytes: 30 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await roomy.start();
  roomy.stop();
  assert.equal(
    (
      await roomy.admit({
        backend: "comfyui",
        method: "POST",
        path: "/v1/images/generations",
      })
    ).allowed,
    true,
  );
});

test("memory guard reserves headroom for H3 video jobs", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const tight = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 38 * 1024 ** 3,
      freeBytes: 26 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await tight.start();
  tight.stop();
  const denied = await tight.admit({
    backend: "video",
    method: "POST",
    path: "/v1/videos/generations",
    model: "minimax-h3",
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "memory");
  assert.match(denied.reason ?? "", /H3 视频需要至少/);

  const roomy = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 28 * 1024 ** 3,
      freeBytes: 36 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await roomy.start();
  roomy.stop();
  assert.equal(
    (
      await roomy.admit({
        backend: "video",
        method: "POST",
        path: "/v1/videos/generations",
        model: "minimax-h3",
      })
    ).allowed,
    true,
  );
});

test("usage observer keeps the last token counts and ignores prompt text", () => {
  const observer = new UsageObserver();
  observer.observe('data: {"content":"secret-prompt"}\n');
  observer.observe('{"prompt_eval_');
  observer.observe('count": 128, "eval_count": 16}\n');
  assert.equal(observer.usage.promptTokens, 128);
  assert.equal(observer.usage.completionTokens, 16);
  assert.equal(observer.usage.totalTokens, 144);
  observer.observe(
    JSON.stringify({
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }),
  );
  assert.deepEqual(observer.usage, {
    promptTokens: 20,
    completionTokens: 5,
    totalTokens: 25,
  });
  assert.equal(sameResidentModel("ravenx-cyber", "ravenx-cyber:35b"), true);
  assert.equal(sameResidentModel("ravenx-cyber:35b", "ravenx-cyber"), true);
  assert.equal(
    sameResidentModel(
      "qwen3.8-27b-uncensored",
      "qwen3.8-27b-abliterated:q4km",
    ),
    false,
  );
  assert.equal(
    sameResidentModel("ravenx-cyber:35b", "qwen3.8-27b-abliterated:q4km"),
    false,
  );
});

test("memory guard keeps the requested model and unloads the other idle one", async () => {
  let loaded = ["qwen3.8-27b-abliterated:q4km", "ravenx-cyber:35b"];
  const unloaded: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ps") {
      return new Response(
        JSON.stringify({ models: loaded.map((name) => ({ name })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/generate") {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      unloaded.push(body.model ?? "");
      loaded = loaded.filter((name) => name !== body.model);
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unsupported", { status: 404 });
  }) as typeof fetch;
  const guard = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    maxLoadedModels: 1,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 20 * 1024 ** 3,
      freeBytes: 44 * 1024 ** 3,
    }),
    fetchImpl,
  });
  await guard.start();
  guard.stop();
  const allowed = await guard.admit({
    backend: "ollama",
    method: "POST",
    path: "/api/chat",
    model: "ravenx-cyber",
    activeModels: [],
  });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(unloaded, ["qwen3.8-27b-abliterated:q4km"]);
  assert.deepEqual(guard.status().ollama.loadedModels, ["ravenx-cyber:35b"]);

  const busy = new MemoryGuard({
    ollamaUpstream: new URL("http://127.0.0.1:11434"),
    reserveBytes: 12 * 1024 ** 3,
    maxLoadedModels: 1,
    readMemory: async () => ({
      totalBytes: 64 * 1024 ** 3,
      usedBytes: 20 * 1024 ** 3,
      freeBytes: 44 * 1024 ** 3,
    }),
    fetchImpl: (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/ps") {
        return new Response(
          JSON.stringify({
            models: [{ name: "qwen3.8-27b-abliterated:q4km" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      unloaded.push("should-not-unload");
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    }) as typeof fetch,
  });
  await busy.start();
  busy.stop();
  const blocked = await busy.admit({
    backend: "ollama",
    method: "POST",
    path: "/api/chat",
    model: "ravenx-cyber:35b",
    activeModels: ["qwen3.8-27b-abliterated:q4km"],
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "model-slot");
  assert.equal(unloaded.includes("should-not-unload"), false);
});

test("gateway records token counts without the prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-tokens-"));
  const recordsFile = join(root, "model-calls.jsonl");
  const harness = await startHarness({
    recordsFile,
    handler: (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
    },
  });
  try {
    const prompt = "secret-prompt-must-not-be-recorded";
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ravenx-cyber:35b",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    assert.equal(response.status, 200);
    await waitFor(async () => {
      const records = await (await fetch(`${harness.admin}/records`)).json();
      return (records as { records: unknown[] }).records.length === 1;
    });
    const payload = (await (
      await fetch(`${harness.admin}/records?limit=5`)
    ).json()) as {
      records: Array<{
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        model?: string;
      }>;
    };
    assert.equal(payload.records[0]?.model, "ravenx-cyber:35b");
    assert.equal(payload.records[0]?.promptTokens, 11);
    assert.equal(payload.records[0]?.completionTokens, 7);
    assert.equal(payload.records[0]?.totalTokens, 18);
    const raw = readFileSync(recordsFile, "utf8");
    assert.equal(raw.includes(prompt), false);
    const summary = await status(harness);
    const event = summary.recent.find(
      (item) => item.path === "/v1/chat/completions",
    );
    assert.equal(event?.totalTokens, 18);
  } finally {
    await harness.close();
  }
});
