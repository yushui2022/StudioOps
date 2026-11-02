import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientMessage,
  ServerMessage,
  ServiceAction,
  ServiceDefinition,
  Topic,
} from "../../../packages/contracts/src/index.js";
import { CloudflaredAdapter } from "./adapters/cloudflared.js";
import { DockerComposeAdapter } from "./adapters/docker-compose.js";
import { LaunchdAdapter } from "./adapters/launchd.js";
import { ProcessAdapter } from "./adapters/process.js";
import {
  generateApiToken,
  loadApiToken,
  saveApiToken,
  type ApiTokenSource,
} from "./core/api-token.js";
import { changedRuntimeFields } from "./core/config-diff.js";
import { ConfigStore } from "./core/config-store.js";
import { getDockerSnapshot, runContainerAction } from "./core/docker-status.js";
import { listDiscoveredProcesses } from "./core/discovery.js";
import { EventStore } from "./core/event-store.js";
import { listInferenceProcesses } from "./core/inference.js";
import { getOllamaModels } from "./core/ollama.js";
import { ProcessIconStore } from "./core/process-icons.js";
import { listProjectTemplates } from "./core/project-templates.js";
import {
  buildProjectPlist,
  installProjectPlist,
  removeProjectPlist,
  startProjectPlist,
  writeProjectPlist,
} from "./core/project-persistence.js";
import { terminateProcess } from "./core/process-control.js";
import { listProcesses } from "./core/process-list.js";
import { ServiceRegistry } from "./core/service-registry.js";
import { auditRemoteAccess } from "./core/security-audit.js";
import { getSystemSnapshot } from "./core/system.js";
import {
  TAILSCALE_DOWNLOAD_URL,
  findTailscaleServeProxy,
  readTailscaleFunnelInfo,
  readTailscaleInfo,
  readTailscaleServeInfo,
  setTailscaleServe,
  suggestTailscaleServePort,
  tailscaleProxyServePort,
  type TailscaleServeInfo,
} from "./core/tailscale.js";
import {
  createBackupArchive,
  isStudioOpsProject,
  listStudioOpsLaunchAgents,
  removeStudioOpsLaunchAgents,
  resetPersistedProject,
} from "./core/uninstall.js";

const rootDir = resolve(process.env.STUDIOOPS_ROOT ?? process.cwd());
const webDir = resolve(
  process.env.STUDIOOPS_WEB_DIR ?? join(rootDir, "apps/web"),
);
const host = process.env.STUDIOOPS_HOST ?? "127.0.0.1";
const port = Number(process.env.STUDIOOPS_PORT ?? 7227);
const dataDir = process.env.STUDIOOPS_DATA_DIR ?? join(rootDir, "data");
const initialToken = loadApiToken(dataDir);
let configuredToken = initialToken.token;
let tokenSource: ApiTokenSource = initialToken.source;

if (host !== "127.0.0.1" && host !== "localhost" && !configuredToken) {
  throw new Error("STUDIOOPS_TOKEN is required when binding outside loopback");
}

const registry = new ServiceRegistry();
registry.registerAdapter(new LaunchdAdapter());
registry.registerAdapter(new ProcessAdapter(dataDir));
registry.registerAdapter(new DockerComposeAdapter());
registry.registerAdapter(new CloudflaredAdapter(dataDir));
const configStore = new ConfigStore({
  rootDir,
  dataDir,
  adapterIds: ["launchd", "process", "docker-compose", "cloudflared"],
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
let systemPollBusy = false;
let servicesPollBusy = false;

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.startsWith("[::1]");
  const hostname = value.split(":")[0];
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

function isTrustedLocalOrigin(origin: string): boolean {
  if (
    origin === "tauri://localhost" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost"
  )
    return true;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function headerValue(
  value: string | string[] | undefined | null,
): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function headersNeedToken(headers: {
  host?: string | string[] | null | undefined;
  origin?: string | string[] | null | undefined;
  "tailscale-user-login"?: string | string[] | null | undefined;
}): boolean {
  const host = headerValue(headers.host);
  if (host && !isLoopbackHost(host)) return true;
  if (headerValue(headers["tailscale-user-login"])) return true;
  const origin = headerValue(headers.origin);
  if (origin && !isTrustedLocalOrigin(origin)) return true;
  return false;
}

function requestNeedsToken(request: Request): boolean {
  return headersNeedToken({
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    "tailscale-user-login": request.headers.get("tailscale-user-login"),
  });
}

function hasValidToken(headers: Headers, queryToken = ""): boolean {
  return (
    headers.get("authorization") === `Bearer ${configuredToken}` ||
    (Boolean(queryToken) && queryToken === configuredToken)
  );
}

function isAuthorized(request: Request): boolean {
  if (!configuredToken) return true;
  if (!requestNeedsToken(request)) return true;
  return hasValidToken(request.headers);
}

function actorFor(c: Context): "desktop" | "web" | "local" {
  const header = c.req.header("x-studioops-actor");
  return header === "desktop" ? "desktop" : header === "web" ? "web" : "local";
}

function recordConfigEvent(
  c: Context,
  id: string,
  success: boolean,
  error?: string,
): void {
  eventStore.record({
    serviceId: `config:${id}`,
    action: "config",
    state: "unknown",
    success,
    actor: actorFor(c),
    error,
    at: new Date().toISOString(),
  });
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // A configured token is the authentication boundary for remote access.
  if (configuredToken) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "tauri:" && url.hostname === "localhost") return true;
    if (url.hostname === "tauri.localhost") return true;
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
      url.hostname,
    );
    return loopback && url.port === String(port);
  } catch {
    return false;
  }
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

function isTailscaleProject(definition: ServiceDefinition): boolean {
  return (
    (definition.category === "project" ||
      (!definition.category && definition.kind === "process")) &&
    Number.isInteger(definition.port)
  );
}

async function removeProjectTailnet(
  definition: ServiceDefinition,
): Promise<void> {
  if (!definition.port || !definition.tailscaleServePort) return;
  const tailscale = await readTailscaleInfo();
  if (!tailscale.installed) return;
  if (!tailscale.running)
    throw new Error(
      "Tailscale 未运行，无法移除项目 Tailnet 入口；请先启动 Tailscale",
    );
  await setTailscaleServe({
    enabled: false,
    targetPort: definition.port,
    servePort: definition.tailscaleServePort,
    binary: tailscale.binary,
  });
}

function projectTailnetInfo(
  definition: ServiceDefinition,
  serve: TailscaleServeInfo,
  dnsName?: string,
) {
  const localPort = definition.port as number;
  const configuredPort = definition.tailscaleServePort;
  const proxy = configuredPort
    ? findTailscaleServeProxy(serve, localPort, configuredPort)
    : undefined;
  return {
    id: definition.id,
    name: definition.name,
    localPort,
    servePort: configuredPort,
    suggestedPort: configuredPort ?? suggestTailscaleServePort(serve),
    enabled: Boolean(proxy),
    tailnetUrl: proxy?.tailnetUrl,
    dnsName,
  };
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
  const origin = c.req.header("origin");
  if (origin && !isAllowedOrigin(origin))
    return c.json({ error: "Origin not allowed" }, 403);
  if (["POST", "PUT", "DELETE", "PATCH"].includes(c.req.method)) {
    const length = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(length) && length > 1024 * 1024)
      return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

app.get("/api/health", (c) =>
  json({ status: "ok", service: "studioops-agent", version: "0.1.3" }),
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
app.get("/api/discovered", async (c) => {
  const snapshot = await listDiscoveredProcesses(configStore.services);
  for (const processInfo of snapshot.processes)
    processInfo.iconUrl = iconStore.register(processInfo.command);
  return json(snapshot);
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
app.post("/api/projects/:id/persist", async (c) => {
  const id = c.req.param("id");
  try {
    const definition = registry.definition(id);
    if (
      definition.category !== "project" &&
      !(definition.category === undefined && definition.kind === "process")
    )
      throw new Error("Only project services can be made persistent");
    if (definition.adapter === "launchd" && !definition.persisted)
      throw new Error("This service is already managed by launchd");
    const plist = await buildProjectPlist(definition, dataDir);
    if (definition.adapter === "process") await registry.execute(id, "stop");
    await installProjectPlist(plist);
    let services;
    try {
      services = configStore.update(id, {
        ...definition,
        adapter: "launchd",
        target: plist.target,
        plistFile: plist.plistPath,
        logFile: definition.logFile ?? plist.logFile,
        persisted: true,
        persistenceLabel: plist.label,
        autostart: definition.autostart !== false,
        allowedActions: definition.allowedActions.filter(
          (action) => action !== "pause" && action !== "resume",
        ),
      });
    } catch (error) {
      await removeProjectPlist({
        ...definition,
        persistenceLabel: plist.label,
        target: plist.target,
      });
      throw error;
    }
    await applyServices(services);
    recordConfigEvent(c, id, true);
    return json({
      label: plist.label,
      plistPath: plist.plistPath,
      services,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to make project persistent";
    recordConfigEvent(c, id, false, message);
    return c.json({ error: message }, 400);
  }
});
app.post("/api/projects/:id/autostart", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await readJsonObject(c.req.raw);
    if (typeof body.enabled !== "boolean")
      throw new Error("enabled must be a boolean");
    const definition = registry.definition(id);
    if (!definition.persisted)
      throw new Error("Enable persistence before changing autostart");
    const nextDefinition = { ...definition, autostart: body.enabled };
    const plist = await buildProjectPlist(nextDefinition, dataDir);
    writeProjectPlist(plist);
    const services = configStore.update(id, {
      ...nextDefinition,
      adapter: "launchd",
      target: plist.target,
      plistFile: plist.plistPath,
      logFile: definition.logFile ?? plist.logFile,
      persisted: true,
      persistenceLabel: plist.label,
      allowedActions: definition.allowedActions.filter(
        (action) => action !== "pause" && action !== "resume",
      ),
    });
    await applyServices(services);
    recordConfigEvent(c, id, true);
    return json({ autostart: body.enabled, services });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to change autostart";
    recordConfigEvent(c, id, false, message);
    return c.json({ error: message }, 400);
  }
});
app.delete("/api/projects/:id/persist", async (c) => {
  const id = c.req.param("id");
  try {
    const definition = registry.definition(id);
    if (!definition.persisted)
      throw new Error("Service is not a persistent project");
    const label = await removeProjectPlist(definition);
    const services = configStore.update(id, {
      ...definition,
      adapter: "process",
      target: definition.cwd ?? definition.command ?? id,
      plistFile: undefined,
      persisted: undefined,
      persistenceLabel: undefined,
      autostart: undefined,
      allowedActions: ["start", "stop", "restart", "pause", "resume"],
    });
    await applyServices(services);
    recordConfigEvent(c, id, true);
    return json({ label, services });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to remove persistence";
    recordConfigEvent(c, id, false, message);
    return c.json({ error: message }, 400);
  }
});
app.get("/api/uninstall/preview", async (c) => {
  const services = await registry.list();
  const launchAgents = listStudioOpsLaunchAgents();
  const candidates = [
    join(dirname(resolve(process.argv[1] ?? "")), "uninstall-studioops.sh"),
    join(rootDir, "scripts/uninstall-studioops.sh"),
  ];
  const uninstallScript = candidates.find((candidate) => existsSync(candidate));
  return json({
    launchAgents,
    managedServices: services
      .filter(
        (service) =>
          service.adapter === "process" || isStudioOpsProject(service),
      )
      .map((service) => ({
        id: service.id,
        name: service.name,
        state: service.state,
      })),
    configPath: configStore.filePath,
    dataDir,
    agentPid: process.pid,
    uninstallScript,
  });
});
app.post("/api/uninstall/export", async (c) => {
  try {
    const archive = await createBackupArchive({
      configPath: configStore.filePath,
      dataDir,
    });
    recordConfigEvent(c, "uninstall-export", true);
    return json(archive);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to export data";
    recordConfigEvent(c, "uninstall-export", false, message);
    return c.json({ error: message }, 400);
  }
});
app.post("/api/uninstall/cleanup", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    const stopServices = body.stopServices !== false;
    const configBackup = configStore.backup();
    const stopped: string[] = [];
    const failures: string[] = [];

    if (stopServices) {
      for (const definition of configStore.services) {
        if (!["process", "cloudflared"].includes(definition.adapter)) continue;
        try {
          const snapshot = await registry.inspect(definition.id);
          if (snapshot.state !== "running" && snapshot.state !== "paused")
            continue;
          await registry.execute(definition.id, "stop");
          stopped.push(definition.id);
        } catch (error) {
          failures.push(
            `${definition.name}: ${error instanceof Error ? error.message : "stop failed"}`,
          );
        }
      }
    }

    const agents = await removeStudioOpsLaunchAgents();
    const tailscaleRemoved: string[] = [];
    const tailscaleErrors: string[] = [];
    try {
      const tailscale = await readTailscaleInfo();
      if (tailscale.installed && tailscale.running) {
        for (const definition of configStore.services) {
          if (!definition.port || !definition.tailscaleServePort) continue;
          try {
            await setTailscaleServe({
              enabled: false,
              targetPort: definition.port,
              servePort: definition.tailscaleServePort,
              binary: tailscale.binary,
            });
            tailscaleRemoved.push(
              `${definition.name}:${definition.tailscaleServePort}`,
            );
          } catch (error) {
            tailscaleErrors.push(
              `${definition.name}: ${error instanceof Error ? error.message : "remove failed"}`,
            );
          }
        }
        try {
          await setTailscaleServe({
            enabled: false,
            targetPort: port,
            servePort: 443,
            binary: tailscale.binary,
          });
          tailscaleRemoved.push(`StudioOps:443`);
        } catch (error) {
          tailscaleErrors.push(
            `StudioOps: ${error instanceof Error ? error.message : "remove failed"}`,
          );
        }
      } else if (tailscale.installed) {
        tailscaleErrors.push("Tailscale 未运行，Serve 配置未清理");
      }
    } catch (error) {
      tailscaleErrors.push(
        error instanceof Error ? error.message : "Tailscale cleanup failed",
      );
    }
    const reset: string[] = [];
    for (const definition of [...configStore.services]) {
      if (!definition.persisted) continue;
      if (!isStudioOpsProject(definition)) continue;
      try {
        configStore.update(definition.id, {
          ...resetPersistedProject(definition),
        });
        reset.push(definition.id);
      } catch (error) {
        failures.push(
          `${definition.name}: ${error instanceof Error ? error.message : "config reset failed"}`,
        );
      }
    }
    await applyServices(configStore.services);
    recordConfigEvent(
      c,
      "uninstall",
      failures.length === 0,
      failures.join("; ") || undefined,
    );
    return json({
      removedLaunchAgents: agents.removed,
      launchAgentErrors: agents.errors,
      tailscaleRemoved,
      tailscaleErrors,
      stopped,
      reset,
      failures,
      configBackup,
      dataDir,
      quitRequired: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to clean up StudioOps";
    recordConfigEvent(c, "uninstall", false, message);
    return c.json({ error: message }, 400);
  }
});
app.get("/api/project-templates", (c) => json(listProjectTemplates()));
app.get("/api/security/token", (c) =>
  json({
    required: Boolean(configuredToken),
    source: tokenSource,
    filePath: initialToken.filePath,
  }),
);
app.get("/api/security/token/value", (c) => {
  if (requestNeedsToken(c.req.raw))
    return c.json({ error: "Token 只能在本地读取" }, 401);
  if (!configuredToken) return c.json({ error: "尚未生成访问 Token" }, 400);
  if (tokenSource === "env")
    return c.json({ error: "Token 由 STUDIOOPS_TOKEN 管理" }, 400);
  return json({ token: configuredToken });
});
app.post("/api/security/token", (c) => {
  try {
    if (tokenSource === "env")
      throw new Error(
        "Token 由 STUDIOOPS_TOKEN 管理；请先移除环境变量再在 App 内生成",
      );
    const token = generateApiToken();
    const filePath = saveApiToken(dataDir, token);
    configuredToken = token;
    tokenSource = "file";
    for (const client of clients.keys())
      client.close(1008, "API token changed");
    clients.clear();
    recordConfigEvent(c, "api-token", true);
    return json({ required: true, source: "file", filePath, token });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to generate API token";
    recordConfigEvent(c, "api-token", false, message);
    return c.json({ error: message }, 400);
  }
});
app.get("/api/remote-access", async (c) => {
  const tailscale = await readTailscaleInfo();
  const serve = await readTailscaleServeInfo({
    port,
    binary: tailscale.binary,
  });
  return json({
    tailscale,
    serve,
    studioops: {
      port,
      tokenRequired: Boolean(configuredToken),
      tokenSource,
      tailnetUrl: serve.tailnetUrl,
    },
    downloadUrl: TAILSCALE_DOWNLOAD_URL,
  });
});
app.post("/api/remote-access/serve", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    if (typeof body.enabled !== "boolean")
      throw new Error("enabled must be a boolean");
    if (body.enabled && !configuredToken)
      throw new Error(
        "启用 Tailscale 私网访问前需要先生成访问 Token，避免 tailnet 内无鉴权访问",
      );
    const tailscale = await readTailscaleInfo();
    if (!tailscale.installed)
      throw new Error(
        `Tailscale 未安装。请先安装并登录：${TAILSCALE_DOWNLOAD_URL}`,
      );
    if (!tailscale.running)
      throw new Error(
        `Tailscale 未运行或未登录${tailscale.backendState ? `（${tailscale.backendState}）` : ""}`,
      );
    const serve = await setTailscaleServe({
      enabled: body.enabled,
      targetPort: port,
      servePort: 443,
      binary: tailscale.binary,
    });
    recordConfigEvent(c, "tailscale-serve", true);
    return json({ tailscale, serve });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to change Tailscale Serve";
    recordConfigEvent(c, "tailscale-serve", false, message);
    return c.json({ error: message }, 400);
  }
});
app.get("/api/security/audit", async (c) => {
  const tailscale = await readTailscaleInfo();
  const [serve, funnel] = await Promise.all([
    readTailscaleServeInfo({ port, binary: tailscale.binary }),
    readTailscaleFunnelInfo({ binary: tailscale.binary }),
  ]);
  const audit = auditRemoteAccess({
    host,
    port,
    tokenRequired: Boolean(configuredToken),
    tailscale,
    serve,
    funnel,
    services: await registry.list(),
  });
  return json({
    ...audit,
    host,
    port,
    tokenRequired: Boolean(configuredToken),
    tailscale,
    serve,
    funnel,
  });
});
app.get("/api/tailscale/projects", async (c) => {
  const tailscale = await readTailscaleInfo();
  const serve = await readTailscaleServeInfo({
    port: 0,
    binary: tailscale.binary,
  });
  return json({
    tailscale,
    serve,
    tokenRequired: Boolean(configuredToken),
    projects: configStore.services
      .filter(isTailscaleProject)
      .map((definition) =>
        projectTailnetInfo(definition, serve, tailscale.dnsName),
      ),
  });
});
app.post("/api/projects/:id/tailscale", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await readJsonObject(c.req.raw);
    if (typeof body.enabled !== "boolean")
      throw new Error("enabled must be a boolean");
    const definition = registry.definition(id);
    if (!isTailscaleProject(definition))
      throw new Error(
        "Only project services with a listening port can use Tailscale",
      );
    const localPort = definition.port as number;
    if (body.enabled && localPort === 11434)
      throw new Error(
        "Ollama 11434 不应通过 Tailscale Serve 暴露；请改用 Tailscale ACL 或专用代理",
      );
    if (body.enabled && localPort === port)
      throw new Error("Agent 端口只能由 StudioOps 管理入口使用");
    if (body.enabled && !configuredToken)
      throw new Error("启用 Tailnet 项目入口前需要先生成访问 Token");
    const tailscale = await readTailscaleInfo();
    if (!tailscale.installed)
      throw new Error(
        `Tailscale 未安装。请先安装并登录：${TAILSCALE_DOWNLOAD_URL}`,
      );
    if (!tailscale.running)
      throw new Error(
        `Tailscale 未运行或未登录${tailscale.backendState ? `（${tailscale.backendState}）` : ""}`,
      );
    const before = await readTailscaleServeInfo({
      port: localPort,
      binary: tailscale.binary,
    });
    let servePort = definition.tailscaleServePort;
    if (body.port !== undefined) {
      const requested = Number(body.port);
      if (!Number.isInteger(requested) || requested < 1024 || requested > 65535)
        throw new Error("端口必须是 1024-65535 之间的整数");
      if (requested === 443)
        throw new Error("HTTPS 443 保留给 StudioOps 管理入口");
      servePort = requested;
    }
    if (body.enabled) {
      if (servePort === 443)
        throw new Error("HTTPS 443 保留给 StudioOps 管理入口");
      if (!servePort) servePort = suggestTailscaleServePort(before);
      const existing = findTailscaleServeProxy(before, localPort, servePort);
      if (
        !existing &&
        before.proxies.some(
          (proxy) => tailscaleProxyServePort(proxy) === servePort,
        )
      ) {
        if (body.port !== undefined)
          throw new Error(`Tailscale Serve 的 HTTPS ${servePort} 已被占用`);
        servePort = suggestTailscaleServePort(before);
      }
      const serve = await setTailscaleServe({
        enabled: true,
        targetPort: localPort,
        servePort,
        binary: tailscale.binary,
      });
      try {
        if (definition.tailscaleServePort !== servePort) {
          const services = configStore.update(id, {
            ...definition,
            tailscaleServePort: servePort,
          });
          await applyServices(services);
        }
      } catch (error) {
        await setTailscaleServe({
          enabled: false,
          targetPort: localPort,
          servePort,
          binary: tailscale.binary,
        }).catch(() => {});
        throw error;
      }
      recordConfigEvent(c, id, true);
      return json({
        tailscale,
        serve,
        project: projectTailnetInfo(
          configStore.services.find((service) => service.id === id) ?? {
            ...definition,
            tailscaleServePort: servePort,
          },
          serve,
          tailscale.dnsName,
        ),
      });
    }
    if (!servePort) throw new Error("项目还没有配置 Tailnet 入口");
    const serve = await setTailscaleServe({
      enabled: false,
      targetPort: localPort,
      servePort,
      binary: tailscale.binary,
    });
    recordConfigEvent(c, id, true);
    return json({
      tailscale,
      serve,
      project: projectTailnetInfo(definition, serve, tailscale.dnsName),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to change project Tailscale entry";
    recordConfigEvent(c, id, false, message);
    return c.json({ error: message }, 400);
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
    tokenSource,
    dataDir,
    version: "0.1.3",
  }),
);
app.get("/api/config/services", (c) => json(configStore.services));
app.post("/api/config/services", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    const services = configStore.add(body);
    recordConfigEvent(c, typeof body.id === "string" ? body.id : "add", true);
    await applyServices(services);
    return json({ services });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to add service";
    recordConfigEvent(c, "add", false, message);
    return c.json({ error: message }, 400);
  }
});
app.put("/api/config/services/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const previous = registry.definition(id);
    const snapshot = await registry.inspect(id);
    const body = await readJsonObject(c.req.raw);
    const services = configStore.update(id, body);
    const updated = configStore.services.find((service) => service.id === id);
    const changedFields = updated
      ? changedRuntimeFields(previous, updated)
      : [];
    const running = snapshot.state === "running" || snapshot.state === "paused";
    let tailscaleCleanupError: string | undefined;
    if (
      previous.tailscaleServePort &&
      previous.port &&
      (!updated ||
        updated.port !== previous.port ||
        !isTailscaleProject(updated))
    ) {
      try {
        await removeProjectTailnet(previous);
      } catch (error) {
        tailscaleCleanupError =
          error instanceof Error ? error.message : "Tailnet cleanup failed";
      }
    }
    recordConfigEvent(c, id, true);
    await applyServices(services);
    return json({
      services,
      restartRequired: running && changedFields.length > 0,
      changedFields,
      persisted: Boolean(updated?.persisted),
      tailscaleCleanupError,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to update service";
    recordConfigEvent(c, id, false, message);
    return c.json({ error: message }, 400);
  }
});
app.delete("/api/config/services/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const definition = registry.definition(id);
    const snapshot = await registry.inspect(id);
    if (snapshot.state === "running" || snapshot.state === "paused")
      throw new Error(
        `Stop ${definition.name} before deleting it from the configuration`,
      );
    let tailscaleCleanupError: string | undefined;
    try {
      await removeProjectTailnet(definition);
    } catch (error) {
      tailscaleCleanupError =
        error instanceof Error ? error.message : "Tailnet cleanup failed";
    }
    const services = configStore.remove(id);
    recordConfigEvent(c, id, true);
    await applyServices(services);
    return json({ services, tailscaleCleanupError });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to delete service";
    recordConfigEvent(c, id, false, message);
    return c.json({ error: message }, 400);
  }
});
app.post("/api/config/reload", async (c) => {
  try {
    const services = configStore.reload();
    recordConfigEvent(c, "reload", true);
    await applyServices(services);
    return json({ services });
  } catch (error) {
    configError =
      error instanceof Error ? error.message : "Unable to reload config";
    recordConfigEvent(c, "reload", false, configError);
    return c.json({ error: configError }, 400);
  }
});
app.get("/api/config/backups", (c) => json(configStore.listBackups()));
app.post("/api/config/backup", (c) => {
  const backup = configStore.backup();
  if (!backup) {
    recordConfigEvent(c, "backup", false, "No services.yaml is configured");
    return c.json({ error: "No services.yaml is configured" }, 400);
  }
  recordConfigEvent(c, "backup", true);
  return json(backup);
});
app.post("/api/config/restore", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    if (typeof body.name !== "string" || !body.name.trim())
      throw new Error("Backup name is required");
    const services = configStore.restore(body.name.trim());
    recordConfigEvent(c, "restore", true);
    await applyServices(services);
    return json({ services });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to restore backup";
    recordConfigEvent(c, "restore", false, message);
    return c.json({ error: message }, 400);
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
  const webRoot = webDir.endsWith(sep) ? webDir : `${webDir}${sep}`;
  if (
    (filePath !== webDir && !filePath.startsWith(webRoot)) ||
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
  if (!configuredToken && !isAllowedOrigin(request.headers.origin)) {
    client.close(1008, "Origin not allowed");
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const queryToken = requestUrl.searchParams.get("token") ?? "";
  const needsToken = headersNeedToken(request.headers);
  if (
    configuredToken &&
    needsToken &&
    !hasValidToken(
      new Headers(request.headers as Record<string, string>),
      queryToken,
    )
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
  if (systemPollBusy) return;
  if (![...clients.values()].some((topics) => topics.has("system"))) return;
  systemPollBusy = true;
  try {
    broadcast(
      { type: "snapshot", topic: "system", data: await getSystemSnapshot() },
      "system",
    );
  } catch (error) {
    console.error("system snapshot failed", error);
  } finally {
    systemPollBusy = false;
  }
}, 2000).unref();

setInterval(async () => {
  if (servicesPollBusy) return;
  if (![...clients.values()].some((topics) => topics.has("services"))) return;
  servicesPollBusy = true;
  try {
    broadcast(
      { type: "snapshot", topic: "services", data: await registry.list() },
      "services",
    );
  } catch (error) {
    console.error("service snapshot failed", error);
  } finally {
    servicesPollBusy = false;
  }
}, 5000).unref();

process.on("exit", () => eventStore.close());
