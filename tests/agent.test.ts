import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerComposeAdapter } from "../services/agent/src/adapters/docker-compose.js";
import { launchctlArgsFor } from "../services/agent/src/adapters/launchd.js";
import { MockAdapter } from "../services/agent/src/adapters/mock.js";
import { ProcessAdapter } from "../services/agent/src/adapters/process.js";
import {
  generateApiToken,
  loadApiToken,
  saveApiToken,
} from "../services/agent/src/core/api-token.js";
import { changedRuntimeFields } from "../services/agent/src/core/config-diff.js";
import { ConfigStore } from "../services/agent/src/core/config-store.js";
import { loadConfig } from "../services/agent/src/core/config.js";
import { getDockerSnapshot } from "../services/agent/src/core/docker-status.js";
import { EventStore } from "../services/agent/src/core/event-store.js";
import { spawn } from "node:child_process";
import os from "node:os";
import { withHealth } from "../services/agent/src/core/health.js";
import { detectRole } from "../services/agent/src/core/inference.js";
import { appBundlePath } from "../services/agent/src/core/process-icons.js";
import { buildProjectPlist } from "../services/agent/src/core/project-persistence.js";
import { terminateProcess } from "../services/agent/src/core/process-control.js";
import {
  createBackupArchive,
  listStudioOpsLaunchAgents,
  removeStudioOpsLaunchAgents,
  resetPersistedProject,
} from "../services/agent/src/core/uninstall.js";
import {
  evaluateKillability,
  listAncestorPids,
} from "../services/agent/src/core/process-list.js";
import {
  ollamaBaseUrl,
  summarizeOllamaModels,
} from "../services/agent/src/core/ollama.js";
import { listProcesses } from "../services/agent/src/core/process-list.js";
import { auditRemoteAccess } from "../services/agent/src/core/security-audit.js";
import { ServiceRegistry } from "../services/agent/src/core/service-registry.js";
import { getSystemSnapshot } from "../services/agent/src/core/system.js";
import {
  findTailscaleServeProxy,
  parseTailscaleFunnelStatus,
  parseTailscaleServeStatus,
  parseTailscaleStatus,
  setTailscaleServe,
  suggestTailscaleServePort,
  tailscaleServeArgs,
} from "../services/agent/src/core/tailscale.js";
import type { ServiceAdapter } from "../services/agent/src/adapters/adapter.js";
import type { ServiceDefinition } from "../packages/contracts/src/index.js";

test("service registry serializes concurrent actions per service", async () => {
  let active = 0;
  let maxActive = 0;
  const slow: ServiceAdapter = {
    id: "slow",
    canHandle: () => true,
    inspect: async (definition) => ({
      ...definition,
      state: "running",
      updatedAt: new Date().toISOString(),
    }),
    execute: async (definition) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return {
        ...definition,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
    },
  };
  const registry = new ServiceRegistry();
  registry.registerAdapter(slow);
  registry.register({
    id: "slow-service",
    name: "Slow Service",
    kind: "process",
    adapter: "slow",
    target: "slow-service",
    allowedActions: ["start", "stop", "restart"],
  });
  await Promise.all([
    registry.execute("slow-service", "start"),
    registry.execute("slow-service", "restart"),
    registry.execute("slow-service", "stop"),
  ]);
  assert.equal(maxActive, 1);
});

test("service registry exposes only registered actions", async () => {
  const registry = new ServiceRegistry();
  registry.registerAdapter(new MockAdapter());
  registry.register({
    id: "test-service",
    name: "Test Service",
    kind: "process",
    adapter: "mock",
    target: "test-service",
    allowedActions: ["start", "stop"],
  });

  const running = await registry.execute("test-service", "start");
  assert.equal(running.state, "running");
  await assert.rejects(
    () => registry.execute("test-service", "pause"),
    /not allowed/,
  );
});

test("YAML config loads process and launchd definitions without shell expansion", () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-config-"));
  const configPath = join(root, "services.yaml");
  writeFileSync(
    configPath,
    `services:\n  - id: local-process\n    name: Local Process\n    kind: process\n    adapter: process\n    target: ./ignored-target\n    command: node\n    args: [--version]\n    tailscaleServePort: 8443\n    allowedActions: [start, stop]\n  - id: launchd-job\n    name: Launchd Job\n    kind: launchd\n    adapter: launchd\n    target: gui/501/example.job\n    allowedActions: [start, stop]\n`,
  );
  const previous = process.env.STUDIOOPS_CONFIG;
  process.env.STUDIOOPS_CONFIG = configPath;
  try {
    const loaded = loadConfig(root);
    assert.equal(loaded.services.length, 2);
    assert.equal(loaded.services[0]?.command, "node");
    assert.equal(loaded.services[0]?.tailscaleServePort, 8443);
    assert.equal(loaded.services[1]?.target, "gui/501/example.job");
  } finally {
    if (previous === undefined) delete process.env.STUDIOOPS_CONFIG;
    else process.env.STUDIOOPS_CONFIG = previous;
  }
});

test("first run template is a loadable config with uid placeholders filled", () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-first-run-"));
  const configPath = join(root, "services.yaml");
  const template = readFileSync(
    join(import.meta.dirname, "../config/services.first-run.yaml"),
    "utf8",
  );
  assert.ok(template.includes("{{UID}}"));
  writeFileSync(configPath, template.replaceAll("{{UID}}", "501"));
  const previous = process.env.STUDIOOPS_CONFIG;
  process.env.STUDIOOPS_CONFIG = configPath;
  try {
    const loaded = loadConfig(root);
    assert.deepEqual(
      loaded.services.map((service) => service.id),
      ["ollama", "comfyui", "ollama-tunnel"],
    );
    assert.equal(loaded.services[0]?.target, "gui/501/ai.local.ollama");
    assert.equal(loaded.services[1]?.port, 8188);
    assert.ok(
      loaded.services.every((service) => service.target.startsWith("gui/501/")),
    );
  } finally {
    if (previous === undefined) delete process.env.STUDIOOPS_CONFIG;
    else process.env.STUDIOOPS_CONFIG = previous;
  }
});

test("process adapter starts, inspects, pauses and stops a configured child", async () => {
  const adapter = new ProcessAdapter();
  const definition: ServiceDefinition = {
    id: "sleeping-child",
    name: "Sleeping Child",
    kind: "process" as const,
    adapter: "process",
    target: "sleeping-child",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    allowedActions: ["start", "stop", "pause", "resume", "restart"],
  };
  const started = await adapter.execute(definition, "start");
  assert.equal(started.state, "running");
  assert.ok(started.pid);
  const paused = await adapter.execute(definition, "pause");
  assert.equal(paused.state, "paused");
  await adapter.execute(definition, "resume");
  const stopped = await adapter.execute(definition, "stop");
  assert.equal(stopped.state, "stopped");
});

test("event store persists and reads operation history", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "studioops-events-"));
  const store = new EventStore(dataDir);
  const event = store.record({
    serviceId: "demo",
    action: "start",
    state: "running",
    success: true,
    actor: "local",
    at: new Date().toISOString(),
  });
  assert.ok(event.id);
  assert.equal(store.recent(10)[0]?.serviceId, "demo");
  store.close();
});

test("docker adapter keeps command construction separate from shell", () => {
  const adapter = new DockerComposeAdapter();
  assert.equal(adapter.id, "docker-compose");
});

test("launchd stop boots the job out and start kickstarts it", () => {
  assert.deepEqual(launchctlArgsFor("stop", "gui/501/ai.local.ollama"), [
    "bootout",
    "gui/501/ai.local.ollama",
  ]);
  assert.deepEqual(launchctlArgsFor("start", "gui/501/ai.local.ollama"), [
    "kickstart",
    "-k",
    "gui/501/ai.local.ollama",
  ]);
  assert.deepEqual(launchctlArgsFor("restart", "gui/501/ai.local.ollama"), [
    "kickstart",
    "-k",
    "gui/501/ai.local.ollama",
  ]);
  assert.equal(launchctlArgsFor("pause", "gui/501/ai.local.ollama"), null);
});

test("stopped services report unknown health instead of unhealthy", async () => {
  const definition: ServiceDefinition = {
    id: "stopped-service",
    name: "Stopped Service",
    kind: "process",
    adapter: "process",
    target: "stopped-service",
    allowedActions: ["start"],
    health: { type: "http", endpoint: "http://127.0.0.1:1/health" },
  };
  const result = await withHealth(definition, {
    ...definition,
    state: "stopped",
    updatedAt: new Date().toISOString(),
  });
  assert.equal(result.healthState, "unknown");
  assert.equal(result.healthMessage, "not running");
});

test("ollama model summary merges installed and loaded models", () => {
  const summary = summarizeOllamaModels(
    "http://127.0.0.1:11434",
    {
      models: [
        {
          name: "qwen3.8:27b",
          size: 100,
          modified_at: "2026-10-01T00:00:00Z",
          details: {
            family: "qwen3",
            parameter_size: "27B",
            quantization_level: "Q4_K_M",
          },
        },
        { name: "llama3:8b", size: 200, details: {} },
      ],
    },
    {
      models: [
        { name: "qwen3.8:27b", size: 120, expires_at: "2026-11-01T10:00:00Z" },
      ],
    },
  );
  assert.equal(summary.models.length, 2);
  assert.equal(summary.loadedCount, 1);
  assert.equal(summary.models[0]?.name, "qwen3.8:27b");
  assert.equal(summary.models[0]?.loaded, true);
  assert.equal(summary.models[0]?.sizeBytes, 100);
  assert.equal(summary.models[0]?.parameterSize, "27B");
  assert.equal(summary.models[0]?.quantization, "Q4_K_M");
  assert.equal(summary.models[0]?.expiresAt, "2026-11-01T10:00:00Z");
  assert.equal(summary.models[1]?.loaded, false);
});

test("ollama base URL derives from the health endpoint", () => {
  const definition: ServiceDefinition = {
    id: "ollama",
    name: "Ollama",
    kind: "ollama",
    adapter: "launchd",
    target: "gui/501/ai.local.ollama",
    allowedActions: ["start", "stop"],
    health: { type: "http", endpoint: "http://127.0.0.1:11434/api/tags" },
  };
  assert.equal(ollamaBaseUrl(definition), "http://127.0.0.1:11434");
});

test("inference roles are detected from full command lines", () => {
  assert.equal(
    detectRole("/Applications/Ollama.app/Contents/Resources/ollama serve"),
    "ollama",
  );
  assert.equal(
    detectRole(
      "/Users/orlando/Documents/默认项目/ComfyUI/.venv/bin/python main.py --port 8188 --preview-method auto",
    ),
    "comfyui",
  );
  assert.equal(detectRole("/usr/bin/node server.js"), undefined);
  assert.equal(detectRole("/bin/bash ollama-tunnel"), undefined);
});

test("config diff marks only runtime fields as restart-required", () => {
  const previous: ServiceDefinition = {
    id: "diff-test",
    name: "Old Name",
    kind: "process",
    adapter: "process",
    target: "/tmp",
    command: "node",
    args: ["server.js"],
    port: 3000,
    allowedActions: ["start", "stop"],
    health: { type: "http", endpoint: "http://127.0.0.1:3000/" },
  };
  assert.deepEqual(
    changedRuntimeFields(previous, { ...previous, name: "New Name" }),
    [],
  );
  assert.deepEqual(
    changedRuntimeFields(previous, {
      ...previous,
      command: "python3",
      port: 8000,
    }),
    ["command", "port"],
  );
  assert.deepEqual(
    changedRuntimeFields(previous, {
      ...previous,
      health: { type: "http", endpoint: "http://127.0.0.1:3000/health" },
    }),
    [],
  );
});

test("uninstall removes only StudioOps launch agents", async () => {
  const home = mkdtempSync(join(tmpdir(), "studioops-uninstall-"));
  const launchAgents = join(home, "Library/LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  writeFileSync(
    join(launchAgents, "com.studioops.project.alpha.plist"),
    "alpha",
  );
  writeFileSync(join(launchAgents, "com.studioops.project.beta.plist"), "beta");
  writeFileSync(join(launchAgents, "com.example.other.plist"), "other");

  assert.deepEqual(
    listStudioOpsLaunchAgents(home).map((agent) => agent.label),
    ["com.studioops.project.alpha", "com.studioops.project.beta"],
  );

  const calls: string[][] = [];
  const result = await removeStudioOpsLaunchAgents({
    home,
    uid: 501,
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.errors, []);
  assert.ok(
    !existsSync(join(launchAgents, "com.studioops.project.alpha.plist")),
  );
  assert.ok(existsSync(join(launchAgents, "com.example.other.plist")));
  assert.deepEqual(calls[0], [
    "launchctl",
    "bootout",
    "gui/501/com.studioops.project.alpha",
  ]);
});

test("uninstall export archives config and data outside the data directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-export-"));
  const dataDir = join(root, "data");
  const configPath = join(root, "config/services.yaml");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(dataDir, "studioops.sqlite"), "sqlite");
  writeFileSync(configPath, "services: []\n");

  let tarArgs: string[] = [];
  const archive = await createBackupArchive({
    configPath,
    dataDir,
    destinationDir: join(root, "out"),
    now: new Date("2026-11-02T10:20:30Z"),
    run: async (file, args) => {
      assert.equal(file, "tar");
      tarArgs = args;
      writeFileSync(args[1] as string, "archive");
      return { stdout: "", stderr: "" };
    },
  });

  assert.match(archive.path, /StudioOps-backup-20261102-102030\.tar\.gz$/);
  assert.deepEqual(archive.includes, [configPath, dataDir]);
  assert.ok(archive.sizeBytes > 0);
  assert.deepEqual(tarArgs.slice(2), [
    "--exclude",
    "data/api-token",
    "-C",
    join(root, "config"),
    "services.yaml",
    "-C",
    root,
    "data",
  ]);
});

test("persisted projects are reset to process services for reinstall", () => {
  const definition: ServiceDefinition = {
    id: "project-reset",
    name: "Project Reset",
    kind: "process",
    category: "project",
    adapter: "launchd",
    target: "gui/501/com.studioops.project.project-reset",
    command: "node",
    cwd: "/tmp/project-reset",
    persisted: true,
    persistenceLabel: "com.studioops.project.project-reset",
    autostart: false,
    allowedActions: ["start", "stop", "restart"],
  };
  const reset = resetPersistedProject(definition);
  assert.equal(reset.adapter, "process");
  assert.equal(reset.target, "/tmp/project-reset");
  assert.equal(reset.persisted, undefined);
  assert.equal(reset.persistenceLabel, undefined);
  assert.equal(reset.autostart, undefined);
  assert.deepEqual(reset.allowedActions, [
    "start",
    "stop",
    "restart",
    "pause",
    "resume",
  ]);
});

test("Tailscale status exposes tailnet address and login state", () => {
  const status = parseTailscaleStatus(
    JSON.stringify({
      Version: "1.104.2",
      BackendState: "Running",
      Self: {
        HostName: "studio-mac",
        DNSName: "studio-mac.example-tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
        Online: true,
      },
      CurrentTailnet: { Name: "example-tailnet.ts.net", MagicDNSEnabled: true },
    }),
  );
  assert.equal(status.running, true);
  assert.equal(status.online, true);
  assert.equal(status.dnsName, "studio-mac.example-tailnet.ts.net");
  assert.deepEqual(status.ips, ["100.64.0.5", "fd7a:115c:a1e0::5"]);
  assert.equal(status.magicDnsEnabled, true);
});

test("Tailscale Serve status finds only the StudioOps proxy", () => {
  const raw = JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: {
      "studio-mac.example-tailnet.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:7227" } },
      },
      "studio-mac.example-tailnet.ts.net:8443": {
        Handlers: { "/other": { Proxy: "http://127.0.0.1:4399" } },
      },
    },
  });
  const serve = parseTailscaleServeStatus(raw, 7227);
  assert.equal(serve.enabled, true);
  assert.equal(serve.tailnetUrl, "https://studio-mac.example-tailnet.ts.net/");
  assert.equal(serve.proxies.length, 2);
  assert.deepEqual(parseTailscaleServeStatus("No serve config", 7227), {
    enabled: false,
    proxies: [],
    tailnetUrl: undefined,
  });
});

test("security audit flags Funnel and Ollama exposure", () => {
  const tailscale = {
    installed: true,
    running: true,
    online: true,
    ips: ["100.64.0.5"],
    dnsName: "studio.example-tailnet.ts.net",
  };
  const safe = auditRemoteAccess({
    host: "127.0.0.1",
    port: 7227,
    tokenRequired: true,
    tailscale,
    serve: parseTailscaleServeStatus(
      JSON.stringify({
        Web: {
          "studio.example-tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:7227" } },
          },
        },
      }),
      7227,
    ),
    funnel: parseTailscaleFunnelStatus("No serve config"),
    services: [
      {
        id: "ollama",
        name: "Ollama",
        kind: "ollama",
        adapter: "launchd",
        target: "gui/501/ai.local.ollama",
        port: 11434,
        allowedActions: ["start", "stop"],
      },
    ],
  });
  assert.equal(safe.level, "warning");
  assert.equal(safe.counts.critical, 0);
  assert.ok(safe.findings.some((finding) => finding.code === "agent-loopback"));
  assert.ok(safe.findings.some((finding) => finding.code === "ollama-local"));
  assert.ok(
    safe.findings.some((finding) => finding.code === "studioops-entry"),
  );

  const dangerous = auditRemoteAccess({
    host: "0.0.0.0",
    port: 7227,
    tokenRequired: false,
    tailscale,
    serve: parseTailscaleServeStatus(
      JSON.stringify({
        Web: {
          "studio.example-tailnet.ts.net:8443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:11434" } },
          },
        },
      }),
      7227,
    ),
    funnel: parseTailscaleFunnelStatus(
      JSON.stringify({
        AllowFunnel: { "studio.example-tailnet.ts.net:8443": true },
        Web: {
          "studio.example-tailnet.ts.net:8443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:11434" } },
          },
        },
      }),
    ),
    services: [],
  });
  assert.equal(dangerous.level, "critical");
  assert.ok(
    dangerous.findings.some((finding) => finding.code === "funnel-enabled"),
  );
  assert.ok(
    dangerous.findings.some((finding) => finding.code === "ollama-exposed"),
  );
  assert.ok(
    dangerous.findings.some(
      (finding) => finding.code === "agent-public-binding",
    ),
  );
});

test("security audit does not mistake the StudioOps 7227 entry for a project", () => {
  const audit = auditRemoteAccess({
    host: "127.0.0.1",
    port: 7382,
    tokenRequired: true,
    tailscale: {
      installed: true,
      running: true,
      online: true,
      ips: ["100.64.0.5"],
      dnsName: "studio.example-tailnet.ts.net",
    },
    serve: parseTailscaleServeStatus(
      JSON.stringify({
        Web: {
          "studio.example-tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:7227" } },
          },
        },
      }),
      7227,
    ),
    funnel: parseTailscaleFunnelStatus("No serve config"),
    services: [],
  });
  assert.ok(
    audit.findings.some((finding) => finding.code === "studioops-entry"),
  );
  assert.ok(
    !audit.findings.some((finding) => finding.code === "project-entries"),
  );
});

test("security audit warns that project entries bypass the API token", () => {
  const audit = auditRemoteAccess({
    host: "127.0.0.1",
    port: 7227,
    tokenRequired: true,
    tailscale: {
      installed: true,
      running: true,
      online: true,
      ips: ["100.64.0.5"],
      dnsName: "studio.example-tailnet.ts.net",
    },
    serve: parseTailscaleServeStatus(
      JSON.stringify({
        Web: {
          "studio.example-tailnet.ts.net:8443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
          },
        },
      }),
      3000,
    ),
    funnel: parseTailscaleFunnelStatus("No serve config"),
    services: [
      {
        id: "demo",
        name: "Demo",
        kind: "process",
        category: "project",
        adapter: "process",
        target: "/tmp/demo",
        port: 3000,
        tailscaleServePort: 8443,
        allowedActions: ["start", "stop"],
      },
    ],
  });
  const finding = audit.findings.find(
    (item) => item.code === "project-entries",
  );
  assert.ok(finding);
  assert.match(finding.detail, /不经过 StudioOps Token/);
});

test("Tailscale Funnel status reads AllowFunnel entries", () => {
  const funnel = parseTailscaleFunnelStatus(
    JSON.stringify({
      AllowFunnel: { "studio.example-tailnet.ts.net:8443": true },
      Web: {
        "studio.example-tailnet.ts.net:8443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    }),
  );
  assert.equal(funnel.enabled, true);
  assert.deepEqual(funnel.hosts, ["studio.example-tailnet.ts.net:8443"]);
  assert.equal(funnel.proxies.length, 1);
});

test("Tailscale Serve maps project ports and suggests a free HTTPS port", () => {
  const raw = JSON.stringify({
    Web: {
      "studio-mac.example-tailnet.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:7227" } },
      },
      "studio-mac.example-tailnet.ts.net:8443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
      },
    },
  });
  const serve = parseTailscaleServeStatus(raw, 3000);
  assert.equal(serve.enabled, true);
  assert.equal(
    findTailscaleServeProxy(serve, 3000, 8443)?.tailnetUrl,
    "https://studio-mac.example-tailnet.ts.net:8443/",
  );
  assert.equal(findTailscaleServeProxy(serve, 3000, 443), undefined);
  assert.equal(suggestTailscaleServePort(serve), 8444);
});

test("project Tailscale Serve uses an explicit HTTPS port", async () => {
  const calls: string[][] = [];
  let started = false;
  const serve = await setTailscaleServe({
    enabled: true,
    targetPort: 3000,
    servePort: 8443,
    binary: "/fake/tailscale",
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === "serve" && args[1] === "status") {
        return {
          stdout: started
            ? JSON.stringify({
                Web: {
                  "studio-mac.example-tailnet.ts.net:8443": {
                    Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
                  },
                },
              })
            : "No serve config",
          stderr: "",
        };
      }
      started = true;
      return { stdout: "Serve started", stderr: "" };
    },
  });
  assert.equal(serve.proxies.length, 1);
  assert.deepEqual(calls.at(-2), ["serve", "--bg", "--https=8443", "3000"]);
});

test("Tailscale Serve command and state transition are explicit", async () => {
  assert.deepEqual(tailscaleServeArgs(true, 7227), [
    "serve",
    "--bg",
    "--https=443",
    "7227",
  ]);
  assert.deepEqual(tailscaleServeArgs(false, 7227), [
    "serve",
    "--https=443",
    "off",
  ]);

  const calls: string[][] = [];
  let started = false;
  const serve = await setTailscaleServe({
    enabled: true,
    targetPort: 7227,
    servePort: 443,
    binary: "/fake/tailscale",
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === "serve" && args[1] === "status") {
        return {
          stdout: started
            ? JSON.stringify({
                Web: {
                  "studio-mac.example-tailnet.ts.net:443": {
                    Handlers: { "/": { Proxy: "http://127.0.0.1:7227" } },
                  },
                },
              })
            : "No serve config",
          stderr: "",
        };
      }
      started = true;
      return { stdout: "Serve started", stderr: "" };
    },
  });
  assert.equal(serve.enabled, true);
  assert.deepEqual(calls.at(-2), ["serve", "--bg", "--https=443", "7227"]);
});

test("API token persists privately and environment wins", () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-token-"));
  const token = generateApiToken();
  const tokenPath = saveApiToken(root, token);
  assert.equal(loadApiToken(root, "").token, token);
  assert.equal(loadApiToken(root, "").source, "file");
  assert.equal(loadApiToken(root, "env-token").source, "env");
  assert.equal(loadApiToken(root, "env-token").token, "env-token");
  assert.equal(tokenPath, join(root, "api-token"));
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
});

test("project plist contains launchd keepalive and escaped environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-plist-"));
  const definition: ServiceDefinition = {
    id: "plist-test",
    name: "Plist Test",
    kind: "process",
    category: "project",
    adapter: "process",
    target: root,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    env: { TEST_VALUE: "a&b" },
    port: 4399,
    allowedActions: ["start", "stop", "restart"],
  };
  const plist = await buildProjectPlist(definition, root);
  assert.equal(plist.label, "com.studioops.project.plist-test");
  assert.ok(plist.plistPath.endsWith("com.studioops.project.plist-test.plist"));
  assert.match(plist.content, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist.content, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist.content, /a&amp;b/);
  assert.match(plist.content, /<string>-e<\/string>/);
  const noAutostart = await buildProjectPlist(
    { ...definition, autostart: false },
    root,
  );
  assert.match(noAutostart.content, /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test("app bundle path is extracted from executable path", () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-icon-"));
  const app = join(root, "Fake App.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  assert.equal(appBundlePath(join(app, "Contents", "MacOS", "fake")), app);
  assert.equal(appBundlePath("/usr/bin/true"), undefined);
});

test("process adapter re-adopts a running child from its pid file", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "studioops-adopt-"));
  const definition: ServiceDefinition = {
    id: "adopt-test",
    name: "Adopt Test",
    kind: "process",
    category: "project",
    adapter: "process",
    target: dataDir,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: dataDir,
    allowedActions: ["start", "stop", "restart"],
  };
  const first = new ProcessAdapter(dataDir);
  const started = await first.execute(definition, "start");
  assert.equal(started.state, "running");
  assert.ok(started.pid);
  const pidFile = join(dataDir, "pids", "adopt-test.pid");
  assert.ok(existsSync(pidFile));
  assert.match(readFileSync(pidFile, "utf8"), /"pid"/);

  const second = new ProcessAdapter(dataDir);
  const resumed = await second.inspect(definition);
  assert.equal(resumed.state, "running");
  assert.equal(resumed.pid, started.pid);
  await second.execute(definition, "stop");
  assert.equal(existsSync(pidFile), false);
  const after = await second.inspect(definition);
  assert.equal(after.state, "stopped");
});

test("process kill guard rejects system and other users", () => {
  const user = os.userInfo().username;
  const base = {
    pid: 5000,
    ppid: 1,
    user,
    cpuPercent: 0,
    memoryPercent: 0,
    memoryBytes: 0,
    command: "/usr/bin/sleep",
  };
  assert.equal(evaluateKillability(base, user, []).killable, true);
  assert.equal(
    evaluateKillability({ ...base, pid: process.pid }, user, []).killable,
    false,
  );
  assert.equal(
    evaluateKillability({ ...base, user: "root" }, user, []).protectedReason,
    "非当前用户进程",
  );
  assert.equal(
    evaluateKillability({ ...base, command: "WindowServer" }, user, [])
      .protectedReason,
    "系统关键进程",
  );
});

test("ancestor chain is protected from termination", async () => {
  const ancestors = await listAncestorPids(process.pid);
  assert.ok(ancestors.includes(process.pid));
  assert.ok(ancestors.length >= 2);
  const grandParent = ancestors.find(
    (pid) => pid !== process.pid && pid !== process.ppid,
  );
  if (grandParent) {
    const guard = evaluateKillability(
      {
        pid: grandParent,
        ppid: 1,
        user: os.userInfo().username,
        cpuPercent: 0,
        memoryPercent: 0,
        memoryBytes: 0,
        command: "zsh",
      },
      os.userInfo().username,
      ancestors,
    );
    assert.equal(guard.killable, false);
    assert.equal(guard.protectedReason, "StudioOps 进程链");
  }
});

test("terminateProcess stops an owned child process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  assert.ok(child.pid);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await terminateProcess(child.pid);
  assert.equal(result.exited, true);
  assert.equal(result.signal, "SIGTERM");
  child.kill("SIGKILL");
});

test("config store validates, backs up, saves and reloads services", () => {
  const root = mkdtempSync(join(tmpdir(), "studioops-store-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "services.yaml");
  writeFileSync(
    configPath,
    `services:\n  - id: local-launchd\n    name: Local Launchd\n    kind: launchd\n    adapter: launchd\n    target: gui/501/example.job\n    allowedActions: [start, stop]\n`,
  );
  const store = new ConfigStore({
    rootDir: root,
    dataDir: join(root, "data"),
    filePath: configPath,
    adapterIds: ["launchd", "process", "docker-compose"],
  });
  assert.equal(store.load().length, 1);

  const nodeService = {
    id: "node-app",
    name: "Node App",
    kind: "process",
    category: "project",
    adapter: "process",
    target: "/tmp/node-app",
    command: "node",
    args: ["--version"],
    allowedActions: ["start", "stop"],
    health: { type: "none" as const },
  };
  const added = store.add(nodeService);
  assert.equal(added.length, 2);
  assert.equal(
    added.find((service) => service.id === "node-app")?.category,
    "project",
  );
  assert.match(readFileSync(configPath, "utf8"), /node-app/);
  assert.throws(
    () =>
      store.add({
        ...nodeService,
        id: "bad-category",
        category: "unknown",
      }),
    /Unsupported category/,
  );
  assert.ok(existsSync(join(root, "data", "backups")));
  assert.ok(readdirSync(join(root, "data", "backups")).length > 0);

  assert.throws(() => store.add(nodeService), /already exists/);
  assert.throws(
    () => store.add({ ...nodeService, id: "bad", adapter: "missing" }),
    /Unknown adapter/,
  );
  assert.throws(
    () =>
      store.add({
        id: "no-command",
        name: "No Command",
        kind: "process",
        adapter: "process",
        target: "no-command",
        allowedActions: ["start"],
      }),
    /needs a command/,
  );

  const updated = store.update("node-app", {
    ...nodeService,
    name: "Node Dev",
  });
  assert.equal(
    updated.find((service) => service.id === "node-app")?.name,
    "Node Dev",
  );

  const backups = store.listBackups();
  assert.ok(backups.length >= 1);
  assert.throws(() => store.restore("../evil.yaml"), /Invalid backup name/);
  const restored = store.restore(backups[0]!.name);
  assert.equal(
    restored.find((service) => service.id === "node-app")?.name,
    "Node App",
  );

  assert.equal(store.remove("node-app").length, 1);
  writeFileSync(configPath, "services: nope\n");
  assert.throws(() => store.reload(), /must contain a services array/);
  assert.equal(
    store.services.length,
    1,
    "a failed reload must keep the last good registry",
  );
  assert.throws(
    () => store.add(nodeService),
    /restore a backup or fix the file/,
  );
  const recovered = store.restore(backups[0]!.name);
  assert.ok(recovered.length >= 1);
  assert.ok(store.listBackups().length >= 1);
});

test("process list is sorted and exposes numeric usage fields", async () => {
  const list = await listProcesses("cpu", 5);
  assert.equal(list.sort, "cpu");
  assert.ok(list.total >= list.processes.length);
  assert.ok(list.processes.length > 0);
  assert.equal(list.processes.length, Math.min(5, list.total));
  for (const process of list.processes) {
    assert.ok(process.pid > 0);
    assert.ok(Number.isFinite(process.cpuPercent));
    assert.ok(Number.isFinite(process.memoryBytes));
  }
  for (let index = 1; index < list.processes.length; index += 1)
    assert.ok(
      list.processes[index - 1]!.cpuPercent >=
        list.processes[index]!.cpuPercent,
    );
});

test("docker status always returns a stable, safe shape", async () => {
  const docker = await getDockerSnapshot();
  assert.equal(typeof docker.cliInstalled, "boolean");
  assert.equal(typeof docker.available, "boolean");
  assert.ok(Array.isArray(docker.containers));
  for (const container of docker.containers) {
    assert.ok(container.id);
    assert.ok(container.name);
  }
});

test("system snapshot reports used memory and CPU count", async () => {
  const system = await getSystemSnapshot();
  assert.ok(system.memory.totalBytes > 0);
  assert.ok((system.memory.usedBytes ?? 0) > 0);
  assert.ok((system.cpuCount ?? 0) > 0);
  assert.ok(system.disk);
  assert.ok(system.hardware);
  assert.ok(system.hardware.totalCores > 0);
  assert.equal(
    system.hardware.totalCores,
    system.hardware.superCores + system.hardware.performanceCores,
  );
  assert.ok((system.silicon?.activeCores ?? 0) >= 0);
});
