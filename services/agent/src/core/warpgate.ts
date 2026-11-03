import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import { readTailscaleInfo } from "./tailscale.js";
import { resolveWarpgateConfig } from "./warpgate-config.js";

const execFileAsync = promisify(execFile);

export interface WarpgateStatus {
  mode: "vps" | "local";
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
  const {
    mode,
    host: remoteHost,
    sshPort,
    adminPort,
    container,
    target,
    user,
  } = resolveWarpgateConfig();
  const base: WarpgateStatus = {
    mode,
    installed: false,
    running: false,
    container: remoteHost ? `vps:${container}` : container,
    sshPort,
    httpPort: adminPort,
    sshListening: false,
    sshHost: remoteHost ?? "127.0.0.1",
    httpListening: false,
    adminUrl: `https://127.0.0.1:${adminPort}/@warpgate/admin`,
    target,
    user,
    directSshOpen: false,
  };

  if (remoteHost) {
    base.installed = true;
    const [sshListening, httpListening, directSshOpen] = await Promise.all([
      isPortOpen(sshPort, remoteHost),
      isPortOpen(adminPort, "127.0.0.1"),
      isDirectSshOpen(),
    ]);
    return {
      ...base,
      sshListening,
      httpListening,
      directSshOpen,
      running: sshListening && httpListening,
      error:
        sshListening || httpListening
          ? undefined
          : "VPS Warpgate 端口不可达，请检查反向隧道和管理台转发",
    };
  }

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
    isPortOpen(adminPort, "127.0.0.1"),
    isDirectSshOpen(),
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

async function isDirectSshOpen(): Promise<boolean> {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item): item is os.NetworkInterfaceInfo => item != null)
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  const results = await Promise.all(
    [...new Set(addresses)].map((address) => isPortOpen(22, address)),
  );
  return results.some(Boolean);
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
