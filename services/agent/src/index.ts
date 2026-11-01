import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientMessage,
  ServerMessage,
  ServiceAction,
  ServiceDefinition,
  Topic,
} from "../../../packages/contracts/src/index.js";
import { DockerComposeAdapter } from "./adapters/docker-compose.js";
import { LaunchdAdapter } from "./adapters/launchd.js";
import { ProcessAdapter } from "./adapters/process.js";
import { ConfigStore } from "./core/config-store.js";
import { getDockerSnapshot, runContainerAction } from "./core/docker-status.js";
import { EventStore } from "./core/event-store.js";
import { listInferenceProcesses } from "./core/inference.js";
import { getOllamaModels } from "./core/ollama.js";
import { ProcessIconStore } from "./core/process-icons.js";
import { terminateProcess } from "./core/process-control.js";
import { listProcesses } from "./core/process-list.js";
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
registry.registerAdapter(new LaunchdAdapter());
registry.registerAdapter(new ProcessAdapter());
registry.registerAdapter(new DockerComposeAdapter());
const configStore = new ConfigStore({
  rootDir,
  dataDir,
  adapterIds: ["launchd", "process", "docker-compose"],
});
let configError: string | undefined;
try {
  registry.replaceAll(configStore.load());
} catch (error) {
  configError =
    error instanceof Error ? error.message : "Invalid services.yaml";
}
const eventStore = new EventStore(dataDir);
const iconStore = new ProcessIconStore(dataDir);

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

async function applyServices(services: ServiceDefinition[]): Promise<void> {
  registry.replaceAll(services);
  configError = undefined;
  broadcast(
    { type: "snapshot", topic: "services", data: await registry.list() },
    "services",
  );
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Request body must be a JSON object");
  return body as Record<string, unknown>;
}

app.use(
  "*",
  cors({
    origin: [
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ],
    allowHeaders: ["Authorization", "Content-Type", "x-studioops-actor"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.use("/api/*", async (c, next) => {
  if (!isAuthorized(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.get("/api/health", (c) =>
  json({ status: "ok", service: "studioops-agent", version: "0.1.0" }),
);
app.get("/api/system", async (c) => json(await getSystemSnapshot()));
app.get("/api/services", async (c) => json(await registry.list()));
app.get("/api/processes", async (c) => {
  const sort = c.req.query("sort") === "memory" ? "memory" : "cpu";
  const snapshot = await listProcesses(
    sort,
    Number(c.req.query("limit") ?? 50),
  );
  for (const processInfo of snapshot.processes)
    processInfo.iconUrl = iconStore.register(processInfo.command);
  return json(snapshot);
});
app.post("/api/processes/:pid/terminate", async (c) => {
  const pid = Number(c.req.param("pid"));
  const actor =
    c.req.header("x-studioops-actor") === "desktop"
      ? "desktop"
      : c.req.header("x-studioops-actor") === "web"
        ? "web"
        : "local";
  try {
    const body = await readJsonObject(c.req.raw);
    const result = await terminateProcess(pid, body.force === true);
    eventStore.record({
      serviceId: `process:${pid}`,
      action: "terminate",
      state: result.exited ? "stopped" : "running",
      success: true,
      actor,
      at: new Date().toISOString(),
    });
    return json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to terminate process";
    eventStore.record({
      serviceId: `process:${pid}`,
      action: "terminate",
      state: "error",
      success: false,
      actor,
      error: message,
      at: new Date().toISOString(),
    });
    return c.json({ error: message }, 400);
  }
});
app.get("/api/inference", async (c) => {
  const snapshot = await listInferenceProcesses(configStore.services);
  for (const processInfo of snapshot.processes)
    processInfo.iconUrl = iconStore.register(processInfo.command);
  return json(snapshot);
});
app.get("/api/docker", async (c) => json(await getDockerSnapshot()));
app.post("/api/docker/containers/:id/:action", async (c) => {
  const id = c.req.param("id");
  const action = c.req.param("action");
  const actor =
    c.req.header("x-studioops-actor") === "desktop"
      ? "desktop"
      : c.req.header("x-studioops-actor") === "web"
        ? "web"
        : "local";
  try {
    const result = await runContainerAction(id, action);
    eventStore.record({
      serviceId: `docker:${id}`,
      action: action as ServiceAction,
      state: action === "stop" ? "stopped" : "running",
      success: true,
      actor,
      at: new Date().toISOString(),
    });
    return json({ ...result, snapshot: await getDockerSnapshot() });
  } catch (error) {
    eventStore.record({
      serviceId: `docker:${id}`,
      action: action as ServiceAction,
      state: "error",
      success: false,
      actor,
      error: error instanceof Error ? error.message : "Container action failed",
      at: new Date().toISOString(),
    });
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Container action failed",
      },
      400,
    );
  }
});
app.get("/api/config", (c) =>
  json({
    filePath: configStore.filePath,
    serviceCount: configStore.services.length,
    usingFallback: !existsSync(configStore.filePath),
    configError,
    host,
    port,
    tokenRequired: Boolean(configuredToken),
    dataDir,
    version: "0.1.0",
  }),
);
app.get("/api/config/services", (c) => json(configStore.services));
app.post("/api/config/services", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    const services = configStore.add(body);
    await applyServices(services);
    return json({ services });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unable to add service",
      },
      400,
    );
  }
});
app.put("/api/config/services/:id", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    const services = configStore.update(c.req.param("id"), body);
    await applyServices(services);
    return json({ services });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to update service",
      },
      400,
    );
  }
});
app.delete("/api/config/services/:id", async (c) => {
  try {
    const services = configStore.remove(c.req.param("id"));
    await applyServices(services);
    return json({ services });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to delete service",
      },
      400,
    );
  }
});
app.post("/api/config/reload", async (c) => {
  try {
    const services = configStore.reload();
    await applyServices(services);
    return json({ services });
  } catch (error) {
    configError =
      error instanceof Error ? error.message : "Unable to reload config";
    return c.json({ error: configError }, 400);
  }
});
app.get("/api/config/backups", (c) => json(configStore.listBackups()));
app.post("/api/config/backup", (c) => {
  const backup = configStore.backup();
  if (!backup) return c.json({ error: "No services.yaml is configured" }, 400);
  return json(backup);
});
app.post("/api/config/restore", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    if (typeof body.name !== "string" || !body.name.trim())
      throw new Error("Backup name is required");
    const services = configStore.restore(body.name.trim());
    await applyServices(services);
    return json({ services });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to restore backup",
      },
      400,
    );
  }
});
app.get("/api/events", (c) =>
  json(eventStore.recent(Number(c.req.query("limit") ?? 50))),
);
app.get("/api/services/:id/models", async (c) => {
  try {
    const definition = registry.definition(c.req.param("id"));
    if (definition.kind !== "ollama")
      return c.json({ error: "Models are only supported for Ollama" }, 400);
    return json(await getOllamaModels(definition));
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unable to list models",
      },
      400,
    );
  }
});
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

app.get("/icons/:file", async (c) => {
  const key = c.req.param("file").replace(/\.png$/, "");
  const file = await iconStore.icon(key);
  if (!file) return c.notFound();
  try {
    return new Response(readFileSync(file), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch {
    return c.notFound();
  }
});

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
    headers: {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    },
  });
});

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(
    `StudioOps agent listening at http://${info.address}:${info.port}`,
  );
});

const wss = new WebSocketServer({ server: server as never, path: "/ws" });
wss.on("connection", async (client, request) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const queryToken = requestUrl.searchParams.get("token") ?? "";
  if (
    configuredToken &&
    request.headers.authorization !== `Bearer ${configuredToken}` &&
    queryToken !== configuredToken
  ) {
    client.close(1008, "Unauthorized");
    return;
  }
  const topics = new Set<Topic>(["services"]);
  clients.set(client, topics);
  // Attach the listener before awaiting the first snapshot. Otherwise a client
  // that sends "subscribe" immediately after connecting loses the message.
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

  registry
    .list()
    .then((services) => {
      if (client.readyState === client.OPEN)
        client.send(
          JSON.stringify({
            type: "snapshot",
            topic: "services",
            data: services,
          }),
        );
    })
    .catch(() => {});
});

setInterval(async () => {
  if (![...clients.values()].some((topics) => topics.has("system"))) return;
  try {
    broadcast(
      { type: "snapshot", topic: "system", data: await getSystemSnapshot() },
      "system",
    );
  } catch (error) {
    console.error("system snapshot failed", error);
  }
}, 2000).unref();

setInterval(async () => {
  if (![...clients.values()].some((topics) => topics.has("services"))) return;
  try {
    broadcast(
      { type: "snapshot", topic: "services", data: await registry.list() },
      "services",
    );
  } catch (error) {
    console.error("service snapshot failed", error);
  }
}, 5000).unref();

process.on("exit", () => eventStore.close());
