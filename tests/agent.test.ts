import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerComposeAdapter } from "../services/agent/src/adapters/docker-compose.js";
import { launchctlArgsFor } from "../services/agent/src/adapters/launchd.js";
import { MockAdapter } from "../services/agent/src/adapters/mock.js";
import { ProcessAdapter } from "../services/agent/src/adapters/process.js";
import { ConfigStore } from "../services/agent/src/core/config-store.js";
import { loadConfig } from "../services/agent/src/core/config.js";
import { getDockerSnapshot } from "../services/agent/src/core/docker-status.js";
import { EventStore } from "../services/agent/src/core/event-store.js";
import { withHealth } from "../services/agent/src/core/health.js";
import { listProcesses } from "../services/agent/src/core/process-list.js";
import { ServiceRegistry } from "../services/agent/src/core/service-registry.js";
import { getSystemSnapshot } from "../services/agent/src/core/system.js";
import type { ServiceDefinition } from "../packages/contracts/src/index.js";

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
    `services:\n  - id: local-process\n    name: Local Process\n    kind: process\n    adapter: process\n    target: ./ignored-target\n    command: node\n    args: [--version]\n    allowedActions: [start, stop]\n  - id: launchd-job\n    name: Launchd Job\n    kind: launchd\n    adapter: launchd\n    target: gui/501/example.job\n    allowedActions: [start, stop]\n`,
  );
  const previous = process.env.STUDIOOPS_CONFIG;
  process.env.STUDIOOPS_CONFIG = configPath;
  try {
    const loaded = loadConfig(root);
    assert.equal(loaded.services.length, 2);
    assert.equal(loaded.services[0]?.command, "node");
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
    adapter: "process",
    target: "/tmp/node-app",
    command: "node",
    args: ["--version"],
    allowedActions: ["start", "stop"],
    health: { type: "none" as const },
  };
  assert.equal(store.add(nodeService).length, 2);
  assert.match(readFileSync(configPath, "utf8"), /node-app/);
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
});
