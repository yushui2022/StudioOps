import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { extractModel, type MemoryAdmission } from "./memory.js";
import { UsageObserver } from "./usage.js";
import { ModelCallLog, type ModelCallRecord } from "./records.js";

export type BackendName = "ollama" | "comfyui" | "video";
export type JobState =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "rejected"
  | "timed-out"
  | "cancelled";

export interface BackendConfig {
  name: BackendName;
  listenPort: number;
  upstream: URL;
  concurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number;
  maxBodyBytes: number;
}

export interface GatewayOptions {
  backends: BackendConfig[];
  adminPort: number;
  host?: string;
  version?: string;
  admission?: MemoryAdmission;
  recordsFile?: string;
}

export interface BackendStats {
  received: number;
  started: number;
  completed: number;
  failed: number;
  rejected: number;
  timedOut: number;
  cancelled: number;
}

export interface RecentEvent {
  id: string;
  backend: BackendName;
  state: JobState;
  method: string;
  path: string;
  client?: string;
  statusCode?: number;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  waitMs?: number;
  durationMs?: number;
  bytes: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
}

interface Job {
  id: string;
  backend: BackendName;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  client?: string;
  req: IncomingMessage;
  res: ServerResponse;
  state: JobState;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  statusCode?: number;
  bytesOut: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  queueTimer?: NodeJS.Timeout;
  requestTimer?: NodeJS.Timeout;
  upstreamRequest?: http.ClientRequest;
  cancelledByOperator?: boolean;
  error?: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardableHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
    ),
  );
}

class BackendQueue {
  private readonly queue: Job[] = [];
  private active = 0;
  private readonly stats: BackendStats = {
    received: 0,
    started: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    timedOut: 0,
    cancelled: 0,
  };
  private readonly activeJobs = new Map<string, Job>();
  private readonly scheduling = new Set<Job>();
  private readonly recent: RecentEvent[] = [];
  private processing = false;
  private closed = false;

  constructor(
    private readonly config: BackendConfig,
    private readonly admission?: MemoryAdmission,
    private readonly onModelCall?: (record: ModelCallRecord) => void,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): void {
    this.stats.received += 1;
    readBody(req, this.config.maxBodyBytes).then(
      (body) => this.enqueue(req, res, body),
      (error: Error) => {
        this.stats.rejected += 1;
        const job = this.job(req, res, Buffer.alloc(0), "rejected");
        job.finishedAt = Date.now();
        job.error = error.message;
        this.record(job);
        jsonResponse(res, error.message.includes("too large") ? 413 : 400, {
          error: error.message,
          backend: this.config.name,
        });
      },
    );
  }

  status() {
    return {
      backend: this.config.name,
      listenPort: this.config.listenPort,
      upstream: this.config.upstream.toString().replace(/\/$/, ""),
      concurrency: this.config.concurrency,
      maxQueue: this.config.maxQueue,
      queueTimeoutMs: this.config.queueTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxBodyBytes: this.config.maxBodyBytes,
      active: this.active,
      queued: this.queue.length,
      stats: { ...this.stats },
      activeJobs: [...this.activeJobs.values()].map(jobDetails),
      queuedJobs: this.queue.map(jobDetails),
    };
  }

  cancel(id: string): "queued" | "active" | null {
    const index = this.queue.findIndex((job) => job.id === id);
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1);
      if (!job) return null;
      clearTimeout(job.queueTimer);
      job.state = "cancelled";
      job.finishedAt = Date.now();
      this.stats.cancelled += 1;
      this.record(job);
      jsonResponse(job.res, 409, {
        error: "Cancelled while waiting in queue",
        backend: this.config.name,
      });
      return "queued";
    }
    const scheduled = [...this.scheduling].find((job) => job.id === id);
    if (scheduled) {
      this.scheduling.delete(scheduled);
      clearTimeout(scheduled.queueTimer);
      scheduled.state = "cancelled";
      scheduled.finishedAt = Date.now();
      this.stats.cancelled += 1;
      this.record(scheduled);
      jsonResponse(scheduled.res, 409, {
        error: "Cancelled while waiting in queue",
        backend: this.config.name,
      });
      return "queued";
    }
    const activeJob = this.activeJobs.get(id);
    if (!activeJob) return null;
    activeJob.cancelledByOperator = true;
    activeJob.error = "Cancelled by operator";
    activeJob.upstreamRequest?.destroy();
    if (!activeJob.res.headersSent) {
      jsonResponse(activeJob.res, 499, {
        error: "Cancelled by operator",
        backend: this.config.name,
      });
    } else {
      activeJob.res.destroy();
    }
    return "active";
  }

  recentEvents(): RecentEvent[] {
    return [...this.recent];
  }

  close(): void {
    this.closed = true;
    for (const job of [...this.queue]) {
      this.cancel(job.id);
    }
    for (const job of [...this.scheduling]) {
      this.cancel(job.id);
    }
    for (const job of [...this.activeJobs.values()]) {
      this.cancel(job.id);
    }
  }

  private enqueue(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): void {
    if (this.closed) {
      this.stats.rejected += 1;
      jsonResponse(res, 503, { error: "Gateway is shutting down" });
      return;
    }
    if (this.queue.length >= this.config.maxQueue) {
      this.stats.rejected += 1;
      const job = this.job(req, res, body, "rejected");
      job.finishedAt = Date.now();
      job.error = "Queue is full";
      this.record(job);
      jsonResponse(
        res,
        429,
        {
          error: "Queue is full",
          backend: this.config.name,
          retryAfterSeconds: 15,
        },
        { "retry-after": "15" },
      );
      return;
    }
    const job = this.job(req, res, body, "queued");
    const precheck = this.admission?.precheck?.({
      backend: job.backend,
      method: job.method,
      path: job.path,
      model: job.model,
    });
    if (precheck && !precheck.allowed) {
      this.reject(job, precheck);
      return;
    }
    this.queue.push(job);
    job.queueTimer = setTimeout(() => {
      const index = this.queue.indexOf(job);
      if (index < 0) return;
      this.queue.splice(index, 1);
      job.state = "timed-out";
      job.finishedAt = Date.now();
      this.stats.timedOut += 1;
      this.record(job);
      jsonResponse(job.res, 503, {
        error: "Queue wait timed out",
        backend: this.config.name,
        queueTimeoutMs: this.config.queueTimeoutMs,
      });
    }, this.config.queueTimeoutMs);
    job.queueTimer.unref?.();
    res.on("close", () => {
      if (job.state !== "queued") return;
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      else if (!this.scheduling.delete(job)) return;
      job.state = "cancelled";
      job.finishedAt = Date.now();
      clearTimeout(job.queueTimer);
      this.stats.cancelled += 1;
      this.record(job);
    });
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      while (this.active < this.config.concurrency && this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        clearTimeout(job.queueTimer);
        this.scheduling.add(job);
        const decision = await this.admit(job);
        this.scheduling.delete(job);
        if (
          job.state !== "queued" ||
          job.res.destroyed ||
          job.res.writableEnded
        )
          continue;
        if (decision) {
          this.reject(job, decision);
          continue;
        }
        job.state = "active";
        job.startedAt = Date.now();
        this.active += 1;
        this.activeJobs.set(job.id, job);
        this.stats.started += 1;
        void this.proxy(job).finally(() => {
          this.active -= 1;
          this.activeJobs.delete(job.id);
          void this.processNext();
        });
      }
    } finally {
      this.processing = false;
      if (this.queue.length && this.active < this.config.concurrency)
        void this.processNext();
    }
  }

  private async admit(
    job: Job,
  ): Promise<{ code?: string; reason?: string } | undefined> {
    if (!this.admission) return undefined;
    const activeModels = [...this.activeJobs.values()]
      .map((activeJob) => activeJob.model)
      .filter((model): model is string => Boolean(model));
    const decision = await this.admission.admit({
      backend: job.backend,
      method: job.method,
      path: job.path,
      model: job.model,
      activeModels,
    });
    return decision.allowed
      ? undefined
      : { code: decision.code, reason: decision.reason };
  }

  private reject(job: Job, decision: { code?: string; reason?: string }): void {
    this.stats.rejected += 1;
    job.state = "rejected";
    job.finishedAt = Date.now();
    job.error = decision.reason ?? "Rejected by admission control";
    this.record(job);
    jsonResponse(
      job.res,
      503,
      {
        error: job.error,
        code: decision.code ?? "admission",
        backend: this.config.name,
        retryAfterSeconds: 30,
      },
      { "retry-after": "30" },
    );
  }

  private proxy(job: Job): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (state: JobState, error?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(job.requestTimer);
        job.state = state;
        job.finishedAt = Date.now();
        if (error) job.error = error;
        if (state === "completed") this.stats.completed += 1;
        else if (state === "failed") this.stats.failed += 1;
        else if (state === "timed-out") this.stats.timedOut += 1;
        else if (state === "cancelled") this.stats.cancelled += 1;
        this.record(job);
        resolve();
      };

      job.requestTimer = setTimeout(() => {
        job.error = `Request timed out after ${this.config.requestTimeoutMs} ms`;
        job.upstreamRequest?.destroy(new Error("Request timed out"));
        finish("timed-out");
        if (!job.res.headersSent) {
          jsonResponse(job.res, 504, {
            error: "Upstream request timed out",
            backend: this.config.name,
          });
        } else {
          job.res.destroy();
        }
      }, this.config.requestTimeoutMs);
      job.requestTimer.unref?.();

      const headers = forwardableHeaders(job.headers);
      headers.host = this.config.upstream.host;
      headers["content-length"] = String(job.body.length);

      const upstream = http.request(
        {
          protocol: this.config.upstream.protocol,
          hostname: this.config.upstream.hostname,
          port: this.config.upstream.port,
          method: job.method,
          path: job.path,
          headers,
        },
        (upstreamRes) => {
          job.statusCode = upstreamRes.statusCode;
          job.res.writeHead(
            upstreamRes.statusCode ?? 502,
            upstreamRes.statusMessage,
            forwardableHeaders(upstreamRes.headers),
          );
          const usage = new UsageObserver();
          upstreamRes.on("data", (chunk: Buffer) => {
            job.bytesOut += chunk.length;
            const seen = usage.observe(chunk);
            job.promptTokens = seen.promptTokens;
            job.completionTokens = seen.completionTokens;
            job.totalTokens = seen.totalTokens;
          });
          upstreamRes.on("error", (error) => {
            job.res.destroy();
            finish("failed", error.message);
          });
          upstreamRes.pipe(job.res);
        },
      );
      job.upstreamRequest = upstream;
      upstream.on("error", (error) => {
        const state = job.cancelledByOperator ? "cancelled" : "failed";
        finish(state, job.error ?? error.message);
        if (!job.res.headersSent) {
          jsonResponse(job.res, 502, {
            error: error.message,
            backend: this.config.name,
          });
        } else {
          job.res.destroy();
        }
      });
      job.res.on("finish", () => finish("completed"));
      job.res.on("close", () => {
        if (!finished) {
          upstream.destroy();
          finish("cancelled", "Client disconnected");
        }
      });
      upstream.end(job.body);
    });
  }

  private job(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    state: JobState,
  ): Job {
    return {
      id: randomUUID(),
      backend: this.config.name,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      body,
      client: clientAddress(req),
      req,
      res,
      state,
      enqueuedAt: Date.now(),
      bytesOut: 0,
      model: extractModel(body),
    };
  }

  private record(job: Job): void {
    const event: RecentEvent = {
      id: job.id,
      backend: job.backend,
      state: job.state,
      method: job.method,
      path: job.path,
      client: job.client,
      statusCode: job.statusCode,
      enqueuedAt: new Date(job.enqueuedAt).toISOString(),
      startedAt: job.startedAt
        ? new Date(job.startedAt).toISOString()
        : undefined,
      finishedAt: job.finishedAt
        ? new Date(job.finishedAt).toISOString()
        : undefined,
      waitMs: job.startedAt ? job.startedAt - job.enqueuedAt : undefined,
      durationMs:
        job.startedAt && job.finishedAt
          ? job.finishedAt - job.startedAt
          : undefined,
      bytes: job.body.length,
      model: job.model,
      promptTokens: job.promptTokens,
      completionTokens: job.completionTokens,
      totalTokens: job.totalTokens,
      error: job.error,
    };
    this.recent.unshift(event);
    if (this.recent.length > 50) this.recent.length = 50;
    if (isModelCallEvent(event)) this.onModelCall?.(event);
  }
}

export class InferenceGateway {
  private readonly backends: BackendQueue[];
  private readonly host: string;
  private readonly adminServer: http.Server;
  private readonly backendServers: http.Server[] = [];
  private readonly recordLog?: ModelCallLog;
  private startedAt = new Date().toISOString();

  constructor(
    private readonly options: GatewayOptions,
    private readonly logger: (message: string) => void = () => {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.recordLog = options.recordsFile
      ? new ModelCallLog(options.recordsFile)
      : undefined;
    this.backends = options.backends.map(
      (config) =>
        new BackendQueue(config, options.admission, (record) =>
          this.recordLog?.append(record),
        ),
    );
    this.adminServer = http.createServer((req, res) => {
      void this.handleAdmin(req, res);
    });
  }

  async start(): Promise<void> {
    for (const [index, config] of this.options.backends.entries()) {
      await new Promise<void>((resolve, reject) => {
        const server = http.createServer((req, res) =>
          this.backends[index]?.handle(req, res),
        );
        server.once("error", reject);
        server.listen(config.listenPort, this.host, () => {
          const address = server.address() as AddressInfo | null;
          if (address) config.listenPort = address.port;
          this.logger(
            `[gateway] ${config.name} ${this.host}:${config.listenPort} -> ${config.upstream}`,
          );
          this.backendServers[index] = server;
          resolve();
        });
      });
    }
    await new Promise<void>((resolve, reject) => {
      this.adminServer.once("error", reject);
      this.adminServer.listen(this.options.adminPort, this.host, () => {
        const address = this.adminServer.address() as AddressInfo | null;
        if (address) this.options.adminPort = address.port;
        this.logger(
          `[gateway] admin http://${this.host}:${this.options.adminPort}`,
        );
        resolve();
      });
    });
    this.startedAt = new Date().toISOString();
  }

  addresses(): { backends: Record<string, number>; admin: number } {
    return {
      backends: Object.fromEntries(
        this.options.backends.map((config) => [config.name, config.listenPort]),
      ),
      admin: this.options.adminPort,
    };
  }

  cancel(id: string): "queued" | "active" | null {
    for (const backend of this.backends) {
      const result = backend.cancel(id);
      if (result) return result;
    }
    return null;
  }

  status() {
    return {
      status: "ok",
      service: "studioops-inference-gateway",
      version: this.options.version,
      startedAt: this.startedAt,
      pid: process.pid,
      adminPort: this.options.adminPort,
      memory: this.options.admission?.status(),
      records: this.recordLog?.status(),
      backends: this.backends.map((backend) => backend.status()),
      recent: this.backends
        .flatMap((backend) => backend.recentEvents())
        .sort((left, right) =>
          (right.finishedAt ?? right.enqueuedAt).localeCompare(
            left.finishedAt ?? left.enqueuedAt,
          ),
        )
        .slice(0, 50),
    };
  }

  async close(): Promise<void> {
    this.backends.forEach((backend) => backend.close());
    await this.recordLog?.close();
    for (const server of [...this.backendServers, this.adminServer]) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }

  private async handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, {
        status: "ok",
        service: "studioops-inference-gateway",
        uptimeSeconds: Math.round(
          (Date.now() - Date.parse(this.startedAt)) / 1000,
        ),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      jsonResponse(res, 200, this.status());
      return;
    }
    if (req.method === "GET" && url.pathname === "/records") {
      const requested = Number(url.searchParams.get("limit") ?? 200);
      const limit = Number.isFinite(requested)
        ? Math.min(1000, Math.max(1, Math.floor(requested)))
        : 200;
      try {
        const records = (await this.recordLog?.read(limit)) ?? [];
        jsonResponse(res, 200, { records });
      } catch (error) {
        jsonResponse(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname.startsWith("/queue/") &&
      url.pathname.endsWith("/cancel")
    ) {
      const id = decodeURIComponent(
        url.pathname.slice("/queue/".length, -"/cancel".length),
      );
      const state = this.cancel(id);
      jsonResponse(res, state ? 200 : 404, {
        cancelled: Boolean(state),
        state,
        id,
      });
      return;
    }
    jsonResponse(res, 404, { error: "Not found" });
  }
}

function isModelCallEvent(event: RecentEvent): boolean {
  if (event.model) return true;
  if (event.method !== "POST") return false;
  if (event.backend !== "comfyui" && event.backend !== "video") return false;
  try {
    const pathname = new URL(event.path, "http://127.0.0.1").pathname;
    return (
      pathname === "/prompt" ||
      pathname === "/api/prompt" ||
      pathname === "/v1/images/generations" ||
      pathname === "/v1/videos/generations"
    );
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        reject(new Error(`Request body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Client aborted")));
  });
}

function clientAddress(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim();
  }
  const cloudflare = req.headers["cf-connecting-ip"];
  if (typeof cloudflare === "string" && cloudflare.trim()) {
    return cloudflare.trim();
  }
  return req.socket.remoteAddress;
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

function jobDetails(job: Job) {
  return {
    id: job.id,
    backend: job.backend,
    method: job.method,
    path: job.path,
    client: job.client,
    enqueuedAt: new Date(job.enqueuedAt).toISOString(),
    startedAt: job.startedAt
      ? new Date(job.startedAt).toISOString()
      : undefined,
    waitMs: job.startedAt ? job.startedAt - job.enqueuedAt : undefined,
    bytes: job.body.length,
    model: job.model,
    promptTokens: job.promptTokens,
    completionTokens: job.completionTokens,
    totalTokens: job.totalTokens,
  };
}
