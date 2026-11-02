import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { readTailscaleInfo } from "./tailscale.js";

const execFileAsync = promisify(execFile);

export interface WarpgateStatus {
  installed: boolean;
  running: boolean;
  container: string;
  containerState?: string;
  sshPort: number;
  httpPort: number;
  sshListening: boolean;
  sshHost: string;
  httpListening: boolean;
  adminUrl: string;
  target: string;
  user: string;
  directSshOpen: boolean;
  error?: string;
}

export async function getWarpgateStatus(): Promise<WarpgateStatus> {
  const container = process.env.WARPGATE_CONTAINER ?? "studioops-warpgate";
  const sshPort = Number(process.env.WARPGATE_SSH_PORT ?? 2222);
  const httpPort = Number(process.env.WARPGATE_HTTP_PORT ?? 8888);
  const base: WarpgateStatus = {
    installed: false,
    running: false,
    container,
    sshPort,
    httpPort,
    sshListening: false,
    sshHost: "127.0.0.1",
    httpListening: false,
    adminUrl: `https://127.0.0.1:${httpPort}/@warpgate/admin`,
    target: process.env.WARPGATE_TARGET ?? "mac-compute",
    user: process.env.WARPGATE_USER ?? "compute-guest",
    directSshOpen: false,
  };
  try {
    const result = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.State.Status}}", container],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    base.installed = true;
    base.containerState = result.stdout.trim();
  } catch (error) {
    base.error = error instanceof Error ? error.message : "Warpgate 容器不存在";
    return base;
  }
  const tailscale = await readTailscaleInfo();
  const sshHost = tailscale.ips?.[0] ?? "127.0.0.1";
  const [sshListening, httpListening, directSshOpen] = await Promise.all([
    isPortOpen(sshPort, sshHost),
    isPortOpen(httpPort, "127.0.0.1"),
    isPortOpen(22, "127.0.0.1"),
  ]);
  return {
    ...base,
    sshListening,
    sshHost,
    httpListening,
    directSshOpen,
    running: base.containerState === "running" && sshListening && httpListening,
  };
}

async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
