import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { stringify } from "yaml";
import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";
import { parseServices, resolveConfigPath } from "./config.js";

const MAX_BACKUPS = 30;

export interface ConfigBackup {
  name: string;
  createdAt: string;
  sizeBytes: number;
}

export interface ConfigStoreOptions {
  rootDir: string;
  dataDir: string;
  filePath?: string;
  adapterIds: string[];
}

/**
 * Owns the writable services.yaml. Every write is validated, backed up and
 * replaced atomically so a failed save never leaves a broken config behind.
 */
export class ConfigStore {
  readonly filePath: string;
  private readonly backupsDir: string;
  private readonly adapterIds: Set<string>;
  private current: ServiceDefinition[] = [];
  private loadError: string | undefined;

  constructor(options: ConfigStoreOptions) {
    this.filePath = options.filePath ?? resolveConfigPath(options.rootDir);
    this.backupsDir = join(options.dataDir, "backups");
    this.adapterIds = new Set(options.adapterIds);
  }

  get services(): ServiceDefinition[] {
    return this.current;
  }

  load(): ServiceDefinition[] {
    if (!existsSync(this.filePath)) {
      this.current = [];
      this.loadError = undefined;
      return this.current;
    }
    try {
      const services = parseServices(
        readFileSync(this.filePath, "utf8"),
        this.filePath,
      );
      this.assertReady(services);
      this.current = services;
      this.loadError = undefined;
      return this.current;
    } catch (error) {
      this.loadError =
        error instanceof Error ? error.message : "Invalid services.yaml";
      throw error;
    }
  }

  add(input: Record<string, unknown>): ServiceDefinition[] {
    this.assertWritable();
    const service = parseServices(
      { services: [input] },
      this.filePath,
    )[0] as ServiceDefinition;
    if (this.current.some((item) => item.id === service.id))
      throw new Error(`Service id '${service.id}' already exists`);
    const next = [...this.current, service];
    this.commit(next);
    return next;
  }

  update(id: string, input: Record<string, unknown>): ServiceDefinition[] {
    this.assertWritable();
    if (!this.current.some((item) => item.id === id))
      throw new Error(`Unknown service: ${id}`);
    if (typeof input.id === "string" && input.id !== id)
      throw new Error("Service id cannot be changed");
    const service = parseServices(
      { services: [{ ...input, id }] },
      this.filePath,
    )[0] as ServiceDefinition;
    const next = this.current.map((item) => (item.id === id ? service : item));
    this.commit(next);
    return next;
  }

  remove(id: string): ServiceDefinition[] {
    this.assertWritable();
    if (!this.current.some((item) => item.id === id))
      throw new Error(`Unknown service: ${id}`);
    const next = this.current.filter((item) => item.id !== id);
    this.commit(next);
    return next;
  }

  reload(): ServiceDefinition[] {
    return this.load();
  }

  backup(): ConfigBackup | undefined {
    if (!existsSync(this.filePath)) return undefined;
    this.backupCurrent();
    return this.listBackups()[0];
  }

  listBackups(): ConfigBackup[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => {
        const path = join(this.backupsDir, name);
        const stats = statSync(path);
        return {
          name,
          createdAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
        };
      })
      .sort((left, right) => right.name.localeCompare(left.name))
      .slice(0, MAX_BACKUPS);
  }

  restore(name: string): ServiceDefinition[] {
    if (basename(name) !== name) throw new Error("Invalid backup name");
    const backup = this.listBackups().find((item) => item.name === name);
    if (!backup) throw new Error(`Unknown backup: ${name}`);
    const services = parseServices(
      readFileSync(join(this.backupsDir, backup.name), "utf8"),
      this.filePath,
    );
    this.assertReady(services);
    this.commit(services);
    return this.current;
  }

  private commit(services: ServiceDefinition[]): void {
    this.assertReady(services);
    const body =
      "# Managed by StudioOps. Backups live in the StudioOps data directory.\n" +
      stringify({ services }, { lineWidth: 0 });
    // Parse the generated document once more so a serialization bug can never
    // replace a working config with invalid YAML.
    parseServices(body, this.filePath);

    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    if (existsSync(this.filePath)) this.backupCurrent();
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    this.current = services;
    this.loadError = undefined;
  }

  private assertWritable(): void {
    if (this.loadError)
      throw new Error(
        `services.yaml is invalid; restore a backup or fix the file before editing: ${this.loadError}`,
      );
  }

  private backupCurrent(): void {
    mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      this.backupsDir,
      `${stamp}-${basename(this.filePath)}`,
    );
    copyFileSync(this.filePath, backupPath);
    chmodSync(backupPath, 0o600);
    this.pruneBackups();
  }

  private pruneBackups(): void {
    const backups = readdirSync(this.backupsDir)
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .reverse();
    for (const name of backups.slice(MAX_BACKUPS))
      rmSync(join(this.backupsDir, name), { force: true });
  }

  private assertReady(services: ServiceDefinition[]): void {
    const seen = new Set<string>();
    for (const service of services) {
      if (seen.has(service.id))
        throw new Error(`Duplicate service id '${service.id}'`);
      seen.add(service.id);
      if (!this.adapterIds.has(service.adapter))
        throw new Error(`Unknown adapter '${service.adapter}'`);
      if (service.adapter === "process" && !service.command)
        throw new Error(`Process service '${service.id}' needs a command`);
      if (service.adapter === "docker-compose" && !service.composeFile)
        throw new Error(`Compose service '${service.id}' needs a composeFile`);
      if (
        ["launchd", "docker-compose"].includes(service.adapter) &&
        service.allowedActions.some((action) =>
          ["pause", "resume"].includes(action),
        )
      )
        throw new Error(
          `${service.adapter} service '${service.id}' does not support pause/resume`,
        );
      if (
        service.adapter === "launchd" &&
        !/^(gui|user|system)\//.test(service.target)
      )
        throw new Error(
          `launchd service '${service.id}' needs a target like gui/501/label`,
        );
      if (
        (service.health?.type === "http" || service.health?.type === "tcp") &&
        !service.health.endpoint
      )
        throw new Error(
          `Service '${service.id}' needs a health endpoint for ${service.health.type}`,
        );
    }
  }
}
