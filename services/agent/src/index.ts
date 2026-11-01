import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientMessage,
  ServiceAction,
  ServerMessage,
  Topic,
} from "../../../packages/contracts/src/index.js";
import { LaunchdAdapter } from "./adapters/launchd.js";
import { DockerComposeAdapter } from "./adapters/docker-compose.js";
import { MockAdapter } from "./adapters/mock.js";
import { ProcessAdapter } from "./adapters/process.js";
import { loadConfig } from "./core/config.js";
import { EventStore } from "./core/event-store.js";
import { ServiceRegistry } from "./core/service-registry.js";
import { getSystemSnapshot } from "./core/system.js";

const rootDir = resolve(process.env.STUDIOOPS_ROOT ?? process.cwd());
const webDir = resolve(
  process.env.STUDIOOPS_WEB_DIR ?? join(rootDir, "apps/web"),
);
const host = process.env.STUDIOOPS_HOST ?? "127.0.0.1";
const port = Number(process.env.STUDIOOPS_PORT ?? 7227);
const configuredToken = process.env.STUDIOOPS_TOKEN ?? "";
const dataDir = process.env.STUDIOOPS_DATA_DIR ?? join(rootDir, "data");

if (host !== "127.0.0.1" && host !== "localhost" && !configuredToken) {
  throw new Error("STUDIOOPS_TOKEN is required when binding outside loopback");
}

const registry = new ServiceRegistry();
registry.registerAdapter(new MockAdapter());
registry.registerAdapter(new LaunchdAdapter());
registry.registerAdapter(new ProcessAdapter());
registry.registerAdapter(new DockerComposeAdapter());
const loadedConfig = loadConfig(rootDir);
if (loadedConfig.services.length > 0) {
  for (const service of loadedConfig.services) registry.register(service);
} else {
  registry.register({
    id: "demo-web",
    name: "Demo Web Project",
    kind: "process",
    description: "Fallback service used until config/services.yaml is created.",
    group: "Projects",
    adapter: "mock",
    target: "demo-web",
    allowedActions: ["start", "stop", "restart", "pause", "resume"],
    health: { type: "none" },
  });
}
const eventStore = new EventStore(dataDir);

const app = new Hono();
const clients = new Map<WebSocket, Set<Topic>>();

function isAuthorized(request: Request): boolean {
  if (!configuredToken) return true;
  return request.headers.get("authorization") === `Bearer ${configuredToken}`;
}

function json<T>(data: T, requestId = randomUUID()): Response {
  return Response.json({ data, requestId });
}

function broadcast(message: ServerMessage, topic: Topic): void {
  const payload = JSON.stringify(message);
  for (const [client, topics] of clients) {
    if (topics.has(topic) && client.readyState === client.OPEN)
      client.send(payload);
  }
}

app.use("/api/*", async (c, next) => {
  if (!isAuthorized(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.get("/api/health", (c) =>
  json({ status: "ok", service: "studioops-agent", version: "0.1.0" }),
);
app.get("/api/system", async (c) => json(await getSystemSnapshot()));
app.get("/api/services", async (c) => json(await registry.list()));
app.get("/api/config", (c) =>
  json({
    filePath: loadedConfig.filePath,
    serviceCount: loadedConfig.services.length,
    usingFallback: loadedConfig.services.length === 0,
  }),
);
app.post("/api/config/backup", (c) => {
  if (!loadedConfig.filePath)
    return c.json({ error: "No services.yaml is configured" }, 400);
  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(
    backupDir,
    `${stamp}-${basename(loadedConfig.filePath)}`,
  );
  copyFileSync(loadedConfig.filePath, backupPath);
  return json({ path: backupPath, createdAt: new Date().toISOString() });
});
app.get("/api/events", (c) =>
  json(eventStore.recent(Number(c.req.query("limit") ?? 50))),
);
app.get("/api/services/:id/logs", async (c) => {
  try {
    return json(
      await registry.logs(
        c.req.param("id"),
        Number(c.req.query("tail") ?? 200),
      ),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to read logs" },
      400,
    );
  }
});
app.post("/api/services/:id/:action", async (c) => {
  const id = c.req.param("id");
  const action = c.req.param("action") as ServiceAction;
  const actor =
    c.req.header("x-studioops-actor") === "desktop"
      ? "desktop"
      : c.req.header("x-studioops-actor") === "web"
        ? "web"
        : "local";
  try {
    const snapshot = await registry.execute(id, action);
    const event = eventStore.record({
      serviceId: id,
      action,
      state: snapshot.state,
      success: true,
      actor,
      at: new Date().toISOString(),
    });
    broadcast(
      { type: "snapshot", topic: "services", data: await registry.list() },
      "services",
    );
    broadcast(
      {
        type: "event",
        topic: "events",
        data: {
          action,
          serviceId: id,
          state: snapshot.state,
          at: event.at,
        },
      },
      "events",
    );
    return json(snapshot);
  } catch (error) {
    eventStore.record({
      serviceId: id,
      action,
      state: "error",
      success: false,
      actor,
      error: error instanceof Error ? error.message : "Action failed",
      at: new Date().toISOString(),
    });
    return c.json(
      { error: error instanceof Error ? error.message : "Action failed" },
      400,
    );
  }
});

app.get("/api/healthz", (c) => c.text("ok"));

app.get("/*", (c) => {
  const requested = c.req.path === "/" ? "/index.html" : c.req.path;
  const filePath = normalize(join(webDir, requested));
  if (
    !filePath.startsWith(webDir) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  )
    return c.notFound();
  return new Response(readFileSync(filePath), {
    headers: { "content-type": contentType(filePath) },
  });
});

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(
    `StudioOps agent listening at http://${info.address}:${info.port}`,
  );
});

const wss = new WebSocketServer({ server: server as never, path: "/ws" });
wss.on("connection", async (client, request) => {
  if (
    configuredToken &&
    request.headers.authorization !== `Bearer ${configuredToken}`
  ) {
    client.close(1008, "Unauthorized");
    return;
  }
  const topics = new Set<Topic>(["services"]);
  clients.set(client, topics);
  client.send(
    JSON.stringify({
      type: "snapshot",
      topic: "services",
      data: await registry.list(),
    }),
  );
  client.on("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      if (message.type === "subscribe")
        message.topics.forEach((topic) => topics.add(topic));
      if (message.type === "unsubscribe")
        message.topics.forEach((topic) => topics.delete(topic));
      if (message.type === "ping")
        client.send(
          JSON.stringify({ type: "pong", at: new Date().toISOString() }),
        );
    } catch {
      client.send(JSON.stringify({ error: "Invalid WebSocket message" }));
    }
  });
  client.on("close", () => clients.delete(client));
});

setInterval(async () => {
  if ([...clients.values()].some((topics) => topics.has("system")))
    broadcast(
      { type: "snapshot", topic: "system", data: await getSystemSnapshot() },
      "system",
    );
  if ([...clients.values()].some((topics) => topics.has("services")))
    broadcast(
      { type: "snapshot", topic: "services", data: await registry.list() },
      "services",
    );
}, 5000).unref();

process.on("exit", () => eventStore.close());
