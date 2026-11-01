import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import type {
  ServiceAction,
  ServiceDefinition,
  ServiceKind,
} from "../../../../packages/contracts/src/index.js";

const serviceKinds = new Set<ServiceKind>([
  "process",
  "launchd",
  "docker-compose",
  "ollama",
  "comfyui",
  "tunnel",
  "generic",
]);
const serviceActions = new Set<ServiceAction>([
  "start",
  "stop",
  "restart",
  "pause",
  "resume",
]);

export interface LoadedConfig {
  filePath?: string;
  services: ServiceDefinition[];
}

export function resolveConfigPath(rootDir: string): string {
  const configured = process.env.STUDIOOPS_CONFIG;
  if (configured)
    return isAbsolute(configured) ? configured : resolve(rootDir, configured);
  const existing = [
    resolve(rootDir, "config/services.yaml"),
    resolve(rootDir, "config/services.local.yaml"),
  ].find((candidate) => existsSync(candidate));
  return existing ?? resolve(rootDir, "config/services.yaml");
}

export function loadConfig(rootDir: string): LoadedConfig {
  const configured = process.env.STUDIOOPS_CONFIG;
  const candidates = configured
    ? [isAbsolute(configured) ? configured : resolve(rootDir, configured)]
    : [
        resolve(rootDir, "config/services.yaml"),
        resolve(rootDir, "config/services.local.yaml"),
      ];
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (!filePath) return { services: [] };
  return {
    filePath,
    services: parseServices(readFileSync(filePath, "utf8"), filePath),
  };
}

export function parseServices(
  source: unknown,
  filePath: string,
): ServiceDefinition[] {
  const document =
    typeof source === "string" ? (parse(source) as unknown) : source;
  const services = (document as { services?: unknown } | null)?.services;
  if (!Array.isArray(services))
    throw new Error(`Config ${filePath} must contain a services array`);
  const normalized = services.map((value, index) =>
    validateService(value, index, filePath),
  );
  const seen = new Set<string>();
  for (const service of normalized) {
    if (seen.has(service.id))
      throw new Error(`Duplicate service id '${service.id}' in ${filePath}`);
    seen.add(service.id);
  }
  return normalized;
}

function validateService(
  value: unknown,
  index: number,
  filePath: string,
): ServiceDefinition {
  if (!value || typeof value !== "object")
    throw new Error(`Invalid service at ${filePath}:${index + 1}`);
  const record = value as Record<string, unknown>;
  const id = stringField(record, "id", filePath, index);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
    throw new Error(
      `Invalid service id '${id}': use letters, numbers, '.', '_' or '-'`,
    );
  const name = stringField(record, "name", filePath, index);
  const kind = stringField(record, "kind", filePath, index) as ServiceKind;
  const adapter = stringField(record, "adapter", filePath, index);
  const target = stringField(record, "target", filePath, index);
  if (!serviceKinds.has(kind))
    throw new Error(`Unsupported kind '${kind}' for service ${id}`);
  const allowedActions = arrayField(
    record,
    "allowedActions",
    filePath,
    index,
  ).map((action) => {
    if (
      typeof action !== "string" ||
      !serviceActions.has(action as ServiceAction)
    )
      throw new Error(`Unsupported action for service ${id}`);
    return action as ServiceAction;
  });
  const health =
    record.health && typeof record.health === "object"
      ? (record.health as Record<string, unknown>)
      : undefined;
  return {
    id,
    name,
    kind,
    adapter,
    target:
      adapter === "launchd" || target.includes("://")
        ? target
        : resolveTarget(target, rootDirFrom(filePath)),
    description: optionalString(record, "description"),
    group: optionalString(record, "group"),
    allowedActions,
    command: optionalString(record, "command"),
    args: optionalStringArray(record, "args"),
    cwd: optionalPath(record, "cwd", rootDirFrom(filePath)),
    env: optionalStringRecord(record, "env"),
    pidFile: optionalPath(record, "pidFile", rootDirFrom(filePath)),
    composeFile: optionalPath(record, "composeFile", rootDirFrom(filePath)),
    projectName: optionalString(record, "projectName"),
    logFile: optionalPath(record, "logFile", rootDirFrom(filePath)),
    port: optionalPort(record, "port"),
    health: health
      ? {
          type: (health.type as "http" | "tcp" | "process" | "none") ?? "none",
          endpoint:
            typeof health.endpoint === "string" ? health.endpoint : undefined,
        }
      : undefined,
  };
}

function rootDirFrom(filePath: string): string {
  return resolve(filePath, "..", "..");
}

function resolveTarget(target: string, rootDir: string): string {
  return target.startsWith("/") ||
    target.startsWith("~") ||
    target.includes("://")
    ? target
    : resolve(rootDir, target);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  index: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${key} for service at ${filePath}:${index + 1}`);
  return value.trim();
}

function arrayField(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  index: number,
): unknown[] {
  const value = record[key];
  if (!Array.isArray(value))
    throw new Error(`Missing ${key} for service at ${filePath}:${index + 1}`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (record[key] === undefined) return undefined;
  if (
    !Array.isArray(record[key]) ||
    record[key].some((value) => typeof value !== "string")
  )
    throw new Error(`${key} must be an array of strings`);
  return record[key] as string[];
}

function optionalStringRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  if (record[key] === undefined) return undefined;
  if (!record[key] || typeof record[key] !== "object")
    throw new Error(`${key} must be a map of strings`);
  const value = record[key] as Record<string, unknown>;
  for (const item of Object.values(value))
    if (typeof item !== "string")
      throw new Error(`${key} must be a map of strings`);
  return value as Record<string, string>;
}

function optionalPath(
  record: Record<string, unknown>,
  key: string,
  rootDir: string,
): string | undefined {
  const value = optionalString(record, key);
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

function optionalPort(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  if (record[key] === undefined) return undefined;
  const value = Number(record[key]);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`${key} must be a valid TCP port`);
  return value;
}
