import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { MockAdapter } from "./adapters/mock.js";
import { ServiceRegistry } from "./core/service-registry.js";
import { getSystemSnapshot } from "./core/system.js";

const rootDir = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const webDir = join(rootDir, "apps/web");
const host = process.env.STUDIOOPS_HOST ?? "127.0.0.1";
const port = Number(process.env.STUDIOOPS_PORT ?? 7227);
const configuredToken = process.env.STUDIOOPS_TOKEN ?? "";

if (host !== "127.0.0.1" && host !== "localhost" && !configuredToken) {
  throw new Error("STUDIOOPS_TOKEN is required when binding outside loopback");
}

const registry = new ServiceRegistry();
registry.registerAdapter(new MockAdapter());
registry.registerAdapter(new LaunchdAdapter());
registry.register({
  id: "demo-web",
  name: "Demo Web Project",
  kind: "process",
  description:
    "Placeholder service showing the control contract before real adapters are enabled.",
  group: "Projects",
  adapter: "mock",
  target: "demo-web",
  allowedActions: ["start", "stop", "restart", "pause", "resume"],
  health: { type: "none" },
});

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
app.get("/api/system", (c) => json(getSystemSnapshot()));
app.get("/api/services", async (c) => json(await registry.list()));
app.post("/api/services/:id/:action", async (c) => {
  const id = c.req.param("id");
  const action = c.req.param("action") as ServiceAction;
  try {
    const snapshot = await registry.execute(id, action);
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
          at: new Date().toISOString(),
        },
      },
      "events",
    );
    return json(snapshot);
  } catch (error) {
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
      { type: "snapshot", topic: "system", data: getSystemSnapshot() },
      "system",
    );
  if ([...clients.values()].some((topics) => topics.has("services")))
    broadcast(
      { type: "snapshot", topic: "services", data: await registry.list() },
      "services",
    );
}, 5000).unref();
