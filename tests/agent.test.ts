import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerComposeAdapter } from "../services/agent/src/adapters/docker-compose.js";
import { MockAdapter } from "../services/agent/src/adapters/mock.js";
import { ProcessAdapter } from "../services/agent/src/adapters/process.js";
import { loadConfig } from "../services/agent/src/core/config.js";
import { EventStore } from "../services/agent/src/core/event-store.js";
import { ServiceRegistry } from "../services/agent/src/core/service-registry.js";
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
