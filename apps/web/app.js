const $ = (id) => document.getElementById(id);
// Release builds load the web assets from Tauri (tauri://localhost), so a
// relative /api request would never reach the agent. Point every request at the
// agent explicitly when the page is not served by the agent itself.
const agentOrigin =
  location.protocol === "http:" || location.protocol === "https:"
    ? location.origin
    : "http://127.0.0.1:7227";
const api = async (path, options) => {
  const response = await fetch(`${agentOrigin}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body.data;
};

const fmtUptime = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

const fmtBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character],
  );

function renderSystem(system) {
  $("hostname").textContent = system.hostname;
  $("platform").textContent = `${system.platform} · ${system.arch}`;
  $("uptime").textContent = fmtUptime(system.uptimeSeconds);
  $("load").textContent = system.load[0].toFixed(2);
  const used = 1 - system.memory.freeBytes / system.memory.totalBytes;
  $("memory").textContent = `${Math.round(used * 100)}%`;
  if (system.silicon?.gpuPercent !== undefined)
    $("load").textContent =
      `${system.load[0].toFixed(2)} · ${system.silicon.gpuPercent.toFixed(0)}%`;
  if (system.disk) {
    $("platform").textContent =
      `${system.platform} · ${system.arch} · 磁盘余量 ${fmtBytes(system.disk.freeBytes)}`;
  }
}

function renderServices(services) {
  $("service-list").innerHTML = services
    .map((service) => {
      const detail =
        service.kind === "ollama" && service.details?.modelCount !== undefined
          ? `${service.details.modelCount} 个模型`
          : service.kind === "comfyui" && service.details?.devices?.length
            ? `GPU: ${service.details.devices.join(", ")}`
            : service.healthMessage || "";
      const usage =
        service.cpuPercent !== undefined || service.memoryBytes !== undefined
          ? `${service.cpuPercent?.toFixed(1) ?? "—"}% CPU · ${fmtBytes(service.memoryBytes)}`
          : "";
      return `
    <article class="service-row">
      <div><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.kind)} · ${escapeHtml(service.description || service.target)}</small><small>${escapeHtml(detail)}${detail && usage ? " · " : ""}${escapeHtml(usage)}</small></div>
      <span class="state state-${escapeHtml(service.state)}">${escapeHtml(service.state)}</span>
      <span class="health health-${escapeHtml(service.healthState || "unknown")}">${escapeHtml(service.healthState || "unknown")}</span>
      <div class="actions"><button data-log-service="${escapeHtml(service.id)}">日志</button>${service.allowedActions.map((action) => `<button data-service="${escapeHtml(service.id)}" data-action="${escapeHtml(action)}">${escapeHtml(action)}</button>`).join("")}</div>
    </article>
  `;
    })
    .join("");
  document.querySelectorAll("[data-action]").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(
          `/api/services/${button.dataset.service}/${button.dataset.action}`,
          { method: "POST", headers: { "x-studioops-actor": "web" } },
        );
        await refresh();
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    }),
  );
  document
    .querySelectorAll("[data-log-service]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        openLogs(button.dataset.logService),
      ),
    );
}

function renderEvents(events) {
  $("event-list").innerHTML = events.length
    ? events
        .slice(0, 8)
        .map(
          (event) =>
            `<div class="event-row"><span class="event-result ${event.success ? "success" : "failure"}">${event.success ? "成功" : "失败"}</span><strong>${escapeHtml(event.serviceId)}</strong><span>${escapeHtml(event.action)}</span><small>${new Date(event.at).toLocaleString()}</small></div>`,
        )
        .join("")
    : '<p class="muted">暂无操作记录</p>';
}

async function openLogs(serviceId) {
  $("log-card").classList.remove("hidden");
  $("log-title").textContent = `${serviceId} 日志`;
  $("log-output").textContent = "加载中…";
  try {
    const log = await api(
      `/api/services/${encodeURIComponent(serviceId)}/logs?tail=200`,
    );
    $("log-output").textContent = log.lines.join("\n") || "暂无日志";
  } catch (error) {
    $("log-output").textContent = error.message;
  }
}

async function refresh() {
  const [system, services, events, config] = await Promise.all([
    api("/api/system"),
    api("/api/services"),
    api("/api/events?limit=8"),
    api("/api/config"),
  ]);
  renderSystem(system);
  renderServices(services);
  renderEvents(events);
  $("config-source").textContent = config.usingFallback
    ? "使用内置示例服务"
    : `${config.serviceCount} 个已配置服务`;
}

function connect() {
  const socketUrl = new URL(agentOrigin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.pathname = "/ws";
  const socket = new WebSocket(socketUrl.toString());
  socket.addEventListener("open", () => {
    $("connection-dot").className = "online";
    $("connection-text").textContent = "已连接";
    socket.send(
      JSON.stringify({ type: "subscribe", topics: ["system", "services"] }),
    );
  });
  socket.addEventListener("close", () => {
    $("connection-dot").className = "offline";
    $("connection-text").textContent = "已断开";
    setTimeout(connect, 2000);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.topic === "system") renderSystem(message.data);
    if (message.topic === "services") renderServices(message.data);
  });
}

$("refresh").addEventListener("click", refresh);
$("backup-config").addEventListener("click", async () => {
  try {
    const result = await api("/api/config/backup", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    alert(`配置已备份到\n${result.path}`);
  } catch (error) {
    alert(error.message);
  }
});
$("close-logs").addEventListener("click", () =>
  $("log-card").classList.add("hidden"),
);
refresh().catch((error) => {
  $("service-list").innerHTML = `<p class="error">${error.message}</p>`;
});
connect();
