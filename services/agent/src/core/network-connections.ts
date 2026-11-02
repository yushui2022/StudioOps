import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NetworkLocation {
  latitude: number;
  longitude: number;
  country: string;
  countryCode?: string;
  region?: string;
  city?: string;
}

export interface NetworkConnection {
  id: string;
  direction: "inbound" | "outbound";
  pid?: number;
  process: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  remoteScope: "public" | "private";
  firstSeenAt: string;
  lastSeenAt: string;
  location?: NetworkLocation;
}

export interface NetworkSnapshot {
  capturedAt: string;
  inbound: NetworkConnection[];
  outbound: NetworkConnection[];
  serverLocation?: NetworkLocation;
  publicIp?: string;
  error?: string;
}

interface LsofProcess {
  pid?: number;
  command?: string;
  names: string[];
}

export function parseLsofFields(stdout: string): LsofProcess[] {
  const processes: LsofProcess[] = [];
  let current: LsofProcess | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw) continue;
    const code = raw[0];
    const value = raw.slice(1);
    if (code === "p") {
      if (current) processes.push(current);
      current = { pid: Number(value) || undefined, names: [] };
    } else if (code === "c" && current) {
      current.command = value;
    } else if (code === "n" && current && value) {
      current.names.push(value);
    }
  }
  if (current) processes.push(current);
  return processes;
}

export function parseSocketName(
  value: string,
): { address: string; port: number } | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  let address = value.slice(0, separator);
  if (address.startsWith("[") && address.endsWith("]"))
    address = address.slice(1, -1);
  return { address, port };
}

export function isPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (!value || value === "*" || value === "localhost") return false;
  if (value.includes(":")) {
    if (value === "::" || value === "::1") return false;
    if (
      value.startsWith("fe80:") ||
      value.startsWith("fc") ||
      value.startsWith("fd")
    )
      return false;
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
    return true;
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

export function parseConnections(
  established: string,
  listening: string,
  now = Date.now(),
  previous: Map<string, string> = new Map(),
): NetworkConnection[] {
  const listeningPorts = new Set<number>();
  for (const process of parseLsofFields(listening)) {
    for (const name of process.names) {
      const socket = parseSocketName(name);
      if (socket) listeningPorts.add(socket.port);
    }
  }
  const connections = new Map<string, NetworkConnection>();
  for (const process of parseLsofFields(established)) {
    for (const name of process.names) {
      const [localName, remoteName] = name.split("->");
      if (!localName || !remoteName) continue;
      const local = parseSocketName(localName);
      const remote = parseSocketName(remoteName);
      if (!local || !remote || !isPublicAddress(remote.address)) continue;
      const direction = listeningPorts.has(local.port) ? "inbound" : "outbound";
      const id = `${direction}:${process.pid ?? "?"}:${local.address}:${local.port}:${remote.address}:${remote.port}`;
      const firstSeenAt = previous.get(id) ?? new Date(now).toISOString();
      connections.set(id, {
        id,
        direction,
        pid: process.pid,
        process: process.command ?? "unknown",
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
        remoteScope: "public",
        firstSeenAt,
        lastSeenAt: new Date(now).toISOString(),
      });
    }
  }
  return [...connections.values()].sort((left, right) => {
    if (left.direction !== right.direction)
      return left.direction === "inbound" ? -1 : 1;
    return left.process.localeCompare(right.process);
  });
}

class GeoResolver {
  private cache = new Map<
    string,
    { location: NetworkLocation; expiresAt: number }
  >();
  private server:
    | { location: NetworkLocation; publicIp?: string; expiresAt: number }
    | undefined;

  async serverLocation(): Promise<{
    location?: NetworkLocation;
    publicIp?: string;
  }> {
    if (this.server && this.server.expiresAt > Date.now()) return this.server;
    try {
      const data = await geoRequest("https://ipwho.is/");
      if (!data) return {};
      this.server = { ...data, expiresAt: Date.now() + 6 * 3_600_000 };
      return this.server;
    } catch {
      return this.server ?? {};
    }
  }

  async resolve(address: string): Promise<NetworkLocation | undefined> {
    const cached = this.cache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.location;
    try {
      const data = await geoRequest(
        `https://ipwho.is/${encodeURIComponent(address)}`,
      );
      if (!data) return undefined;
      this.cache.set(address, {
        location: data.location,
        expiresAt: Date.now() + 7 * 86_400_000,
      });
      return data.location;
    } catch {
      return undefined;
    }
  }
}

export class NetworkMonitor {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private busy = false;
  private previous = new Map<string, string>();
  private geo = new GeoResolver();
  private current: NetworkSnapshot = {
    capturedAt: new Date(0).toISOString(),
    inbound: [],
    outbound: [],
  };

  constructor(private readonly intervalMs = 4000) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh().finally(() => this.schedule());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  snapshot(): NetworkSnapshot {
    return {
      ...this.current,
      inbound: this.current.inbound.map((connection) => ({ ...connection })),
      outbound: this.current.outbound.map((connection) => ({ ...connection })),
    };
  }

  async refresh(now = Date.now()): Promise<NetworkSnapshot> {
    if (this.busy) return this.snapshot();
    this.busy = true;
    try {
      const [established, listening] = await Promise.all([
        runLsof(["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-F", "pcn"]),
        runLsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]),
      ]);
      const connections = parseConnections(
        established,
        listening,
        now,
        this.previous,
      );
      this.previous = new Map(
        connections.map((connection) => [
          connection.id,
          connection.firstSeenAt,
        ]),
      );
      const inbound = connections.filter(
        (connection) => connection.direction === "inbound",
      );
      const outbound = connections.filter(
        (connection) => connection.direction === "outbound",
      );
      const server = await this.geo.serverLocation();
      for (const connection of inbound) {
        connection.location = await this.geo.resolve(connection.remoteAddress);
      }
      this.current = {
        capturedAt: new Date(now).toISOString(),
        inbound,
        outbound,
        serverLocation: server.location,
        publicIp: server.publicIp,
      };
      return this.snapshot();
    } catch (error) {
      this.current = {
        ...this.current,
        capturedAt: new Date(now).toISOString(),
        error:
          error instanceof Error ? error.message : "Unable to read network",
      };
      return this.snapshot();
    } finally {
      this.busy = false;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, this.intervalMs);
  }
}

async function runLsof(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("lsof", args, {
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const record = error as { stdout?: string };
    if (record.stdout) return record.stdout;
    throw error;
  }
}

async function geoRequest(
  url: string,
): Promise<{ location: NetworkLocation; publicIp?: string } | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return undefined;
  const data = (await response.json()) as Record<string, unknown>;
  if (data.success === false) return undefined;
  const latitude = Number(data.latitude);
  const longitude = Number(data.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
    return undefined;
  return {
    location: {
      latitude,
      longitude,
      country: String(data.country ?? "Unknown"),
      countryCode:
        typeof data.country_code === "string" ? data.country_code : undefined,
      region: typeof data.region === "string" ? data.region : undefined,
      city: typeof data.city === "string" ? data.city : undefined,
    },
    publicIp: typeof data.ip === "string" ? data.ip : undefined,
  };
}
