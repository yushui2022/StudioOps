import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";
import type {
  TailscaleFunnelInfo,
  TailscaleInfo,
  TailscaleServeInfo,
} from "./tailscale.js";
import { tailscaleProxyTargetPort } from "./tailscale.js";

export type SecurityLevel = "ok" | "warning" | "critical";

export interface SecurityFinding {
  level: SecurityLevel;
  code: string;
  title: string;
  detail: string;
}

export interface SecurityAuditResult {
  level: SecurityLevel;
  findings: SecurityFinding[];
  counts: Record<SecurityLevel, number>;
}

export interface SecurityAuditInput {
  host: string;
  port: number;
  tokenRequired: boolean;
  tailscale: TailscaleInfo;
  serve: TailscaleServeInfo;
  funnel: TailscaleFunnelInfo;
  services: Array<ServiceDefinition & { state?: string }>;
}

const STUDIOOPS_PORT = 7227;
const OLLAMA_PORT = 11434;

/**
 * Produce a deterministic, user-readable risk report. This is intentionally a
 * pure function so every finding can be unit tested without touching launchd,
 * Tailscale or the network.
 */
export function auditRemoteAccess(
  input: SecurityAuditInput,
): SecurityAuditResult {
  const findings: SecurityFinding[] = [];
  const push = (
    level: SecurityLevel,
    code: string,
    title: string,
    detail: string,
  ) => findings.push({ level, code, title, detail });

  if (isLoopbackHost(input.host)) {
    push(
      "ok",
      "agent-loopback",
      "Agent 仅监听回环地址",
      `${input.host}:${input.port} 只能从本机访问，Tailscale Serve 负责私网转发。`,
    );
  } else if (input.tokenRequired) {
    push(
      "warning",
      "agent-lan-binding",
      "Agent 监听非回环地址",
      `${input.host}:${input.port} 能被局域网访问；已启用 Token，但仍建议只监听回环。`,
    );
  } else {
    push(
      "critical",
      "agent-public-binding",
      "Agent 监听非回环地址且没有 Token",
      "这会让同网段设备直接访问控制接口。必须启用 Token 或改回 127.0.0.1。",
    );
  }

  if (input.tokenRequired) {
    push(
      "ok",
      "token-enabled",
      "访问 Token 已启用",
      "通过 Tailscale 或非回环地址进入的 HTTP/WebSocket 请求必须携带 Token。",
    );
  } else {
    push(
      "warning",
      "token-disabled",
      "访问 Token 未启用",
      "本机桌面端仍可用，但远程入口无法安全开放；开放 Tailscale Serve 前会强制生成 Token。",
    );
  }

  if (!input.tailscale.installed) {
    push(
      "warning",
      "tailscale-missing",
      "Tailscale 未安装",
      "私网远程访问不可用；安装并登录后才能开放 Tailnet 入口。",
    );
  } else if (!input.tailscale.running) {
    push(
      "warning",
      "tailscale-stopped",
      "Tailscale 未运行",
      `Tailscale 已安装但未登录或未运行${input.tailscale.backendState ? `（${input.tailscale.backendState}）` : ""}。`,
    );
  } else {
    push(
      "ok",
      "tailscale-running",
      "Tailscale 运行中",
      `${input.tailscale.dnsName ?? input.tailscale.hostname ?? "本机"} · ${input.tailscale.ips.join("、") || "无 IP"}`,
    );
  }

  if (input.funnel.enabled) {
    push(
      "critical",
      "funnel-enabled",
      "Tailscale Funnel 已开启",
      `Funnel 会把服务暴露到公网：${input.funnel.hosts.join("、")}。StudioOps 从不启用 Funnel，请立即在 Tailscale 中关闭。`,
    );
  } else if (input.funnel.error) {
    push(
      "warning",
      "funnel-unknown",
      "无法确认 Funnel 状态",
      input.funnel.error,
    );
  } else {
    push(
      "ok",
      "funnel-disabled",
      "Tailscale Funnel 未开启",
      "当前只有 tailnet 私网入口，没有公网 Funnel 入口。",
    );
  }

  const studioopsProxy = input.serve.proxies.find((proxy) => {
    const target = tailscaleProxyTargetPort(proxy);
    return target === input.port || target === STUDIOOPS_PORT;
  });
  if (studioopsProxy) {
    push(
      input.tokenRequired ? "ok" : "warning",
      "studioops-entry",
      "StudioOps 管理入口仅对 tailnet 开放",
      input.tokenRequired
        ? `${studioopsProxy.tailnetUrl} · 已要求 Token`
        : `${studioopsProxy.tailnetUrl} · 尚未启用 Token，远程请求会被拒绝`,
    );
  }

  const sensitiveProxies = input.serve.proxies.filter(
    (proxy) => tailscaleProxyTargetPort(proxy) === OLLAMA_PORT,
  );
  if (sensitiveProxies.length > 0) {
    push(
      "critical",
      "ollama-exposed",
      "Ollama 11434 被 Tailscale Serve 暴露",
      `${sensitiveProxies.map((proxy) => proxy.tailnetUrl).join("、")} 可直接访问模型服务，请移除该入口。`,
    );
  }

  const projectProxies = input.serve.proxies.filter((proxy) => {
    const target = tailscaleProxyTargetPort(proxy);
    return (
      target !== undefined &&
      target !== input.port &&
      target !== STUDIOOPS_PORT &&
      target !== OLLAMA_PORT
    );
  });
  if (projectProxies.length > 0) {
    push(
      "warning",
      "project-entries",
      `${projectProxies.length} 个项目 Tailnet 入口正在运行`,
      `${projectProxies.map((proxy) => proxy.tailnetUrl).join("、")} 直接代理项目端口，不经过 StudioOps Token。项目自身必须有登录保护。`,
    );
  }

  const configuredProjects = input.services.filter(
    (service) =>
      Number.isInteger(service.port) &&
      Number.isInteger(service.tailscaleServePort),
  );
  if (configuredProjects.length > 0 && projectProxies.length === 0) {
    push(
      "warning",
      "project-entries-inactive",
      "项目配置了 Tailnet 端口但当前未启用",
      `${configuredProjects.map((service) => service.name).join("、")} 已保存 tailscaleServePort，重新开放前不会产生入口。`,
    );
  }

  const ollamaService = input.services.find(
    (service) => service.kind === "ollama" || service.port === OLLAMA_PORT,
  );
  if (ollamaService && sensitiveProxies.length === 0) {
    push(
      "ok",
      "ollama-local",
      "Ollama 未通过 Tailscale Serve 暴露",
      "11434 仍只在本机或原有 launchd 监听范围内，不要手动添加 Serve/Funnel 入口。",
    );
  }

  if (input.serve.error) {
    push(
      "warning",
      "serve-unknown",
      "无法完整读取 Tailscale Serve 状态",
      input.serve.error,
    );
  }

  const cloudflaredTunnels = input.services.filter(
    (service) => service.adapter === "cloudflared",
  );
  const runningTunnels = cloudflaredTunnels.filter(
    (service) => service.state === "running",
  );
  const quickTunnels = runningTunnels.filter((service) => {
    const mode =
      service.tunnelMode ??
      (service.tunnelConfig ? "config" : service.tokenEnv ? "token" : "quick");
    return mode === "quick";
  });
  if (quickTunnels.length > 0) {
    push(
      "critical",
      "cloudflared-quick-public",
      "cloudflared quick tunnel 正在公网运行",
      `${quickTunnels.map((service) => service.publicUrl ?? service.name).join("、")} 是无账号、无身份验证的临时公网地址，请演示后立即停止。`,
    );
  } else if (runningTunnels.length > 0) {
    push(
      "warning",
      "cloudflared-public",
      "cloudflared 公网隧道正在运行",
      `${runningTunnels.map((service) => service.publicUrl ?? service.name).join("、")} 对公网开放；请确认已配置 Cloudflare Access 或项目自身登录。`,
    );
  } else if (cloudflaredTunnels.length > 0) {
    push(
      "warning",
      "cloudflared-configured",
      "已配置 cloudflared 公网隧道但当前未运行",
      "启动前请确认 Cloudflare Access、项目登录和入口域名。",
    );
  }

  push(
    "warning",
    "acl-unverified",
    "Tailscale ACL 需要在管理后台确认",
    "本机 CLI 无法验证 ACL。请确认只有自己的设备能访问这台 Mac，必要时按端口限制项目入口。",
  );

  const counts = { ok: 0, warning: 0, critical: 0 };
  for (const finding of findings) counts[finding.level] += 1;
  return {
    level: counts.critical ? "critical" : counts.warning ? "warning" : "ok",
    findings,
    counts,
  };
}

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.startsWith("[::1]");
  return ["127.0.0.1", "localhost", "::1"].includes(value.split(":")[0]);
}

// Keep the constant visible to tests and future adapters.
export const DEFAULT_STUDIOOPS_PORT = STUDIOOPS_PORT;
