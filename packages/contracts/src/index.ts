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
  health?: {
    type: "http" | "tcp" | "process" | "none";
    endpoint?: string;
  };
}

export interface ServiceSnapshot extends ServiceDefinition {
  state: ServiceState;
  pid?: number;
  uptimeSeconds?: number;
  lastError?: string;
  updatedAt: string;
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
  };
  updatedAt: string;
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
