export type ServiceKind =
  | "process"
  | "launchd"
  | "docker-compose"
  | "ollama"
  | "comfyui"
  | "tunnel"
  | "generic";

export type ServiceState =
  | "unknown"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "paused"
  | "error";

export type HealthState = "unknown" | "healthy" | "unhealthy";

export type ServiceAction = "start" | "stop" | "restart" | "pause" | "resume";

export interface ServiceDefinition {
  id: string;
  name: string;
  kind: ServiceKind;
  description?: string;
  group?: string;
  adapter: string;
  target: string;
  allowedActions: ServiceAction[];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  pidFile?: string;
  plistFile?: string;
  composeFile?: string;
  projectName?: string;
  logFile?: string;
  port?: number;
  health?: {
    type: "http" | "tcp" | "process" | "none";
    endpoint?: string;
  };
}

export interface ServiceSnapshot extends ServiceDefinition {
  state: ServiceState;
  pid?: number;
  uptimeSeconds?: number;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryPercent?: number;
  lastError?: string;
  healthState?: HealthState;
  healthMessage?: string;
  details?: Record<string, unknown>;
  updatedAt: string;
}

export interface ServiceLog {
  serviceId: string;
  lines: string[];
  source: string;
  truncated: boolean;
  fetchedAt: string;
}

export interface OperationEvent {
  id?: number;
  serviceId: string;
  action: ServiceAction | "terminate";
  state: ServiceState;
  success: boolean;
  actor: "desktop" | "web" | "local";
  error?: string;
  at: string;
}

export interface SystemSnapshot {
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  load: number[];
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes?: number;
  };
  cpuCount?: number;
  disk?: {
    totalBytes: number;
    freeBytes: number;
  };
  silicon?: {
    cpuPercent?: number;
    pcpuPercent?: number;
    ecpuPercent?: number;
    gpuPercent?: number;
    gpuFrequencyMhz?: number;
    anePercent?: number;
    powerWatts?: number;
    fanRpm?: number;
    cpuTemperatureC?: number;
    gpuTemperatureC?: number;
  };
  updatedAt: string;
}

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  command: string;
  killable?: boolean;
  protectedReason?: string;
}

export interface ProcessListSnapshot {
  processes: ProcessSnapshot[];
  total: number;
  sort: "cpu" | "memory";
  capturedAt: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface DockerSnapshot {
  cliInstalled: boolean;
  available: boolean;
  serverVersion?: string;
  error?: string;
  containers: DockerContainer[];
  capturedAt: string;
}

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  loaded: boolean;
  expiresAt?: string;
}

export interface OllamaModelsSnapshot {
  baseUrl: string;
  models: OllamaModel[];
  loadedCount: number;
  capturedAt: string;
}

export type Topic = "system" | "services" | "logs" | "events";

export type ClientMessage =
  | { type: "subscribe"; topics: Topic[] }
  | { type: "unsubscribe"; topics: Topic[] }
  | { type: "ping" };

export type ServerMessage =
  | { type: "snapshot"; topic: "system"; data: SystemSnapshot }
  | { type: "snapshot"; topic: "services"; data: ServiceSnapshot[] }
  | {
      type: "event";
      topic: "events";
      data: {
        action: ServiceAction;
        serviceId: string;
        state: ServiceState;
        at: string;
      };
    }
  | { type: "pong"; at: string };

export interface ApiResponse<T> {
  data: T;
  requestId: string;
}
