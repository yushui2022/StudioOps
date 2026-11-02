const $ = (id) => document.getElementById(id);

// Release builds load the web assets from Tauri (tauri://localhost), so a
// relative /api request would never reach the agent. Point every request at the
// agent explicitly when the page is not served by the agent itself.
const agentOrigin =
  location.protocol === "http:" || location.protocol === "https:"
    ? location.origin
    : "http://127.0.0.1:7227";

const viewMeta = {
  overview: { title: "总览" },
  services: { title: "服务" },
  projects: { title: "项目" },
  processes: { title: "进程" },
  containers: { title: "容器" },
  logs: { title: "日志" },
  history: { title: "历史" },
  network: { title: "网络" },
  settings: { title: "设置" },
};

const actionLabels = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  pause: "暂停",
  resume: "继续",
  terminate: "终止进程",
  config: "配置变更",
  "model-load": "加载模型",
  "model-unload": "卸载模型",
  "comfy-cancel": "取消任务",
};

const stateLabels = {
  running: "running",
  stopped: "stopped",
  starting: "starting",
  stopping: "stopping",
  paused: "paused",
  error: "error",
  unknown: "unknown",
};

const healthLabels = {
  healthy: "healthy",
  unhealthy: "unhealthy",
  unknown: "unknown",
};

const state = {
  view: "overview",
  system: null,
  services: [],
  events: [],
  processes: [],
  processTotal: 0,
  processSort: "cpu",
  docker: null,
  config: null,
  uninstall: null,
  remoteAccess: null,
  projectTailnet: null,
  securityAudit: null,
  serviceSearch: "",
  serviceFilter: "all",
  projectSearch: "",
  processSearch: "",
  expandedServiceId: null,
  ollamaModels: {},
  inlineLogs: {},
  inference: null,
  logServiceId: null,
  logLines: [],
  logAuto: true,
  logSearch: "",
  logSource: "",
  logError: "",
  logTruncated: false,
  historyRange: "5m",
  historyData: null,
  historyServiceId: null,
  network: null,
  networkDirection: "inbound",
  networkBusy: false,
  metricsSettings: null,
  alerts: null,
  launchdAgents: null,
  comfyuiQueues: {},
  formServiceId: null,
  lastUpdated: null,
  connected: false,
  history: {
    cpu: [],
    gpu: [],
    memory: [],
    disk: [],
    power: [],
    temp: [],
  },
};

/* ---------- helpers ---------- */

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

const fmtBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 3 ? 2 : unit ? 1 : 0)} ${units[unit]}`;
};

const fmtPercent = (value, digits = 1) =>
  Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";

const fmtUptime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
};

const fmtClock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour12: false }) : "—";

const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";

const baseName = (command) => {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return "—";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

function processIconHtml(processInfo, fallbackLetter) {
  const letter = (
    fallbackLetter ??
    baseName(processInfo.command)[0] ??
    "?"
  ).toUpperCase();
  if (processInfo.iconUrl) {
    const src = processInfo.iconUrl.startsWith("http")
      ? processInfo.iconUrl
      : `${agentOrigin}${processInfo.iconUrl}`;
    return `<img class="process-icon" src="${escapeHtml(src)}" alt="" loading="lazy" data-fallback="${escapeHtml(letter)}" />`;
  }
  return `<span class="process-icon process-icon-fallback">${escapeHtml(letter)}</span>`;
}

/* ---------- api ---------- */

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  const token = localStorage.getItem("studioops.token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response;
  try {
    response = await fetch(`${agentOrigin}${path}`, { ...options, headers });
  } catch {
    throw new Error("Agent 未启动或端口 7227 不可达");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error || `请求失败 (${response.status})`);
  return body.data;
}

/* ---------- history / sparklines ---------- */

function pushHistory(system) {
  const memoryUsed = system.memory.usedBytes ?? 0;
  const memoryPct = system.memory.totalBytes
    ? (memoryUsed / system.memory.totalBytes) * 100
    : 0;
  const diskPct = system.disk?.totalBytes
    ? ((system.disk.totalBytes - system.disk.freeBytes) /
        system.disk.totalBytes) *
      100
    : 0;
  const cpuFallback = system.cpuCount
    ? ((system.load?.[0] ?? 0) / system.cpuCount) * 100
    : undefined;
  const values = {
    cpu: system.silicon?.cpuPercent ?? cpuFallback,
    gpu: system.silicon?.gpuPercent,
    memory: memoryPct,
    disk: diskPct,
    power: system.silicon?.powerWatts,
    temp: system.silicon?.cpuTemperatureC,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) {
      if (state.history[key].length)
        state.history[key].push(state.history[key].at(-1));
    } else state.history[key].push(value);
    if (state.history[key].length > 48) state.history[key].shift();
  }
}

function renderSparklines() {
  const slots = 48;
  const svgNs = "http://www.w3.org/2000/svg";
  for (const [key, values] of Object.entries(state.history)) {
    const group = document.querySelector(`#spark-${key} .bars`);
    if (!group) continue;
    while (group.firstChild) group.removeChild(group.firstChild);
    const baseline = document.createElementNS(svgNs, "rect");
    baseline.setAttribute("class", "base");
    baseline.setAttribute("x", "0");
    baseline.setAttribute("y", "29.2");
    baseline.setAttribute("width", "100");
    baseline.setAttribute("height", "0.8");
    group.appendChild(baseline);
    if (!values.length) continue;
    const scaleCaps = { cpu: 100, gpu: 100, memory: 100, disk: 100, temp: 100 };
    const max = scaleCaps[key] ?? Math.max(...values, 1) * 1.1;
    const slot = 100 / slots;
    values.forEach((value, index) => {
      const height = Math.max(Math.min(value / max, 1) * 28, 0.6);
      const rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("class", "bar");
      rect.setAttribute("x", (index * slot + slot * 0.12).toFixed(2));
      rect.setAttribute("y", (30 - height).toFixed(2));
      rect.setAttribute("width", (slot * 0.7).toFixed(2));
      rect.setAttribute("height", height.toFixed(2));
      group.appendChild(rect);
    });
  }
}

function applyMetricTone(element, value, warn, critical) {
  const card = element?.closest(".metric-card");
  if (!card) return;
  card.style.setProperty(
    "--metric-color",
    !Number.isFinite(value)
      ? "var(--muted)"
      : value >= critical
        ? "var(--red)"
        : value >= warn
          ? "var(--amber)"
          : "var(--green)",
  );
}

function decoratePanels() {
  document.querySelectorAll(".panel").forEach((panel) => {
    const title = panel.querySelector(":scope > .panel-head h2");
    if (!title) return;
    if (title.id === "log-title") panel.dataset.title = "日志";
    else panel.dataset.title = title.textContent.trim();
  });
}

/* ---------- system ---------- */

function renderSystem(system) {
  if (!system) return;
  state.system = system;
  state.lastUpdated = new Date();
  pushHistory(system);

  $("side-host").textContent = system.hostname;
  $("side-platform").textContent = `${system.platform} · ${system.arch}`;
  if ($("runtime-host")) {
    $("runtime-host").textContent = system.hostname;
    $("runtime-uptime").textContent = fmtUptime(system.uptimeSeconds);
  }
  $("last-updated").textContent = state.lastUpdated.toLocaleTimeString(
    "zh-CN",
    { hour12: false },
  );

  const cpu = system.silicon?.cpuPercent;
  $("metric-cpu").textContent = Number.isFinite(cpu) ? cpu.toFixed(0) : "—";
  $("cpu-cores").textContent = system.cpuCount ? `${system.cpuCount} 核` : "—";
  $("metric-cpu-sub").textContent =
    `负载 ${(system.load?.[0] ?? 0).toFixed(2)} · ${(system.load?.[1] ?? 0).toFixed(2)} · ${(system.load?.[2] ?? 0).toFixed(2)}`;

  const gpu = system.silicon?.gpuPercent;
  $("metric-gpu").textContent = Number.isFinite(gpu) ? gpu.toFixed(0) : "—";
  const ane = system.silicon?.anePercent;
  $("metric-gpu-sub").textContent = Number.isFinite(ane)
    ? `ANE ${ane.toFixed(1)}%`
    : system.silicon
      ? "ANE —"
      : "传感器不可用";

  const memoryPct = system.memory.totalBytes
    ? (system.memory.usedBytes ?? 0)
      ? ((system.memory.usedBytes ?? 0) / system.memory.totalBytes) * 100
      : (1 - system.memory.freeBytes / system.memory.totalBytes) * 100
    : 0;
  $("metric-memory").textContent = memoryPct.toFixed(0);
  $("memory-total").textContent = fmtBytes(system.memory.totalBytes);
  $("metric-memory-sub").textContent =
    `已用 ${fmtBytes(system.memory.usedBytes ?? system.memory.totalBytes - system.memory.freeBytes)}`;

  const diskPct = system.disk?.totalBytes
    ? ((system.disk.totalBytes - system.disk.freeBytes) /
        system.disk.totalBytes) *
      100
    : undefined;
  $("metric-disk").textContent = Number.isFinite(diskPct)
    ? diskPct.toFixed(0)
    : "—";
  $("metric-disk-sub").textContent = system.disk
    ? `可用 ${fmtBytes(system.disk.freeBytes)} / ${fmtBytes(system.disk.totalBytes)}`
    : "磁盘信息不可用";

  const power = system.silicon?.powerWatts;
  $("metric-power").textContent = Number.isFinite(power)
    ? power.toFixed(1)
    : "—";

  const temp = system.silicon?.cpuTemperatureC;
  $("metric-temp").textContent = Number.isFinite(temp) ? temp.toFixed(0) : "—";
  const gpuTemp = system.silicon?.gpuTemperatureC;
  $("metric-temp-sub").textContent = Number.isFinite(gpuTemp)
    ? `GPU ${gpuTemp.toFixed(0)}°C`
    : "GPU —";

  applyMetricTone($("metric-cpu"), cpu, 70, 90);
  applyMetricTone($("metric-gpu"), gpu, 80, 95);
  applyMetricTone($("metric-disk"), diskPct, 80, 92);
  applyMetricTone($("metric-power"), power, 60, 90);
  applyMetricTone($("metric-temp"), temp, 70, 85);

  const silicon = system.silicon;
  const setChip = (valueId, barId, value, scale = 100) => {
    const valueElement = $(valueId);
    const barElement = $(barId);
    if (!valueElement || !barElement) return;
    if (Number.isFinite(value)) {
      valueElement.textContent = value.toFixed(0);
      barElement.style.width = `${Math.min(Math.max(value / scale, 0), 1) * 100}%`;
    } else {
      valueElement.textContent = "—";
      barElement.style.width = "0";
    }
  };
  const hardware = system.hardware;
  if (hardware) {
    const gpu = hardware.gpuCores ? ` + ${hardware.gpuCores}GPU` : "";
    $("hw-chip").textContent = hardware.chip;
    $("hw-cores").textContent =
      `${hardware.performanceCores}P + ${hardware.superCores}S${gpu}`;
    $("hw-memory").textContent = `${Math.round(
      system.memory.totalBytes / 1024 ** 3,
    )} GB`;
    $("hw-total").textContent = String(hardware.totalCores);
    $("gpu-cores").textContent = hardware.gpuCores
      ? `${hardware.gpuCores} 核`
      : "Apple Silicon";
    $("label-pcpu").textContent = `P-CPU ${hardware.performanceCores}c`;
    $("label-ecpu").textContent = `S-CPU ${hardware.superCores}c`;
  }
  const activeCores = Number.isFinite(silicon?.activeCores)
    ? Math.min(silicon.activeCores, hardware?.totalCores ?? Infinity)
    : undefined;
  $("hw-active").textContent = Number.isFinite(activeCores)
    ? activeCores.toFixed(1)
    : "—";
  $("hw-active-detail").textContent = silicon
    ? `P ${(silicon.performanceActiveCores ?? 0).toFixed(1)} · S ${(silicon.superActiveCores ?? 0).toFixed(1)}`
    : "";
  setChip("val-pcpu", "bar-pcpu", silicon?.performancePercent);
  setChip("val-ecpu", "bar-ecpu", silicon?.superPercent);
  setChip("val-gpu", "bar-gpu", silicon?.gpuPercent);
  setChip("val-ane", "bar-ane", silicon?.anePercent);
  setChip("val-fan", "bar-fan", silicon?.fanRpm, 4000);
  $("val-fan").textContent = Number.isFinite(silicon?.fanRpm)
    ? `${silicon.fanRpm.toFixed(0)} rpm`
    : "—";
  $("val-sample").textContent = fmtClock(system.updatedAt);
  if ($("status-state"))
    $("status-state").textContent = `live · ${fmtClock(system.updatedAt)}`;

  renderSparklines();
  renderSettingsFacts();
}

/* ---------- services ---------- */

function filteredServices() {
  const search = state.serviceSearch.trim().toLowerCase();
  return state.services.filter((service) => {
    if (state.serviceFilter === "running" && service.state !== "running")
      return false;
    if (
      state.serviceFilter === "stopped" &&
      !["stopped", "unknown"].includes(service.state)
    )
      return false;
    if (
      state.serviceFilter === "unhealthy" &&
      service.healthState !== "unhealthy"
    )
      return false;
    if (!search) return true;
    return [
      service.name,
      service.id,
      service.kind,
      service.group,
      service.target,
      service.description,
      service.port,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search);
  });
}

function serviceDetailLine(service) {
  if (service.kind === "ollama" && service.details?.modelCount !== undefined)
    return `${service.details.modelCount} 个模型`;
  if (service.kind === "comfyui" && service.details?.devices?.length)
    return `设备 ${service.details.devices.join(", ")}`;
  if (service.kind === "tunnel")
    return (
      service.publicUrl ||
      service.lastError ||
      service.description ||
      service.target
    );
  return service.description || service.target;
}

// Only offer actions that make sense for the current state. The agent still
// enforces the configured allow list; this just avoids dead buttons.
function visibleActions(service) {
  return service.allowedActions.filter((action) => {
    if (service.state === "running")
      return ["stop", "restart", "pause"].includes(action);
    if (service.state === "paused") return ["stop", "resume"].includes(action);
    if (["stopped", "error", "unknown"].includes(service.state))
      return action === "start";
    return false;
  });
}

function renderServices() {
  const services = state.services;
  $("nav-service-count").textContent = String(services.length);
  const running = services.filter((service) => service.state === "running");
  const unhealthy = services.filter(
    (service) => service.healthState === "unhealthy",
  );
  $("overview-service-summary").textContent =
    `${running.length} / ${services.length} 运行中${unhealthy.length ? ` · ${unhealthy.length} 个健康异常` : " · 没有健康异常"}`;

  $("overview-service-list").innerHTML = services.length
    ? services
        .slice(0, 6)
        .map(
          (service) => `
          <div class="compact-service" data-service="${escapeHtml(service.id)}">
            <span class="state-dot ${escapeHtml(service.state)}"></span>
            <div>
              <strong>${escapeHtml(service.name)}</strong>
              <small>${escapeHtml(service.kind)} · ${escapeHtml(serviceDetailLine(service))}</small>
            </div>
            <span class="state-pill ${escapeHtml(service.state)}">${escapeHtml(stateLabels[service.state] ?? service.state)}</span>
          </div>`,
        )
        .join("")
    : '<p class="muted" style="padding: 12px">还没有登记服务</p>';

  const filtered = filteredServices();
  $("service-count").textContent =
    `${filtered.length} / ${services.length} 个服务`;
  $("services-empty").classList.toggle("hidden", filtered.length > 0);
  $("services-body").innerHTML = filtered
    .map((service) => {
      const actions = visibleActions(service)
        .map(
          (action) => `
          <button class="${action === "stop" ? "danger" : ""}" data-action="${escapeHtml(action)}" data-service-id="${escapeHtml(service.id)}" title="${escapeHtml(actionLabels[action] ?? action)}">${escapeHtml(actionLabels[action] ?? action)}</button>`,
        )
        .join("");
      const health = service.healthState ?? "unknown";
      return `
      <tr data-service="${escapeHtml(service.id)}">
        <td>
          <div class="service-name" data-service="${escapeHtml(service.id)}">
            <span class="chevron ${state.expandedServiceId === service.id ? "open" : ""}">▸</span>
            <span class="state-dot ${escapeHtml(service.state)}"></span>
            <div>
              <strong>${escapeHtml(service.name)}</strong>
              <span class="cell-sub">${escapeHtml(serviceDetailLine(service))}</span>
            </div>
          </div>
        </td>
        <td><span class="kind-tag">${escapeHtml(service.kind)}</span></td>
        <td><span class="state-pill ${escapeHtml(service.state)}">${escapeHtml(stateLabels[service.state] ?? service.state)}</span></td>
        <td><span class="health-text ${escapeHtml(health)}" title="${escapeHtml(service.healthMessage ?? "")}">${escapeHtml(healthLabels[health] ?? health)}</span><span class="health-message">${escapeHtml(service.healthMessage ?? "")}</span></td>
        <td class="num mono">${service.pid ?? "—"}</td>
        <td class="num mono">${service.port ?? "—"}</td>
        <td class="num">${fmtPercent(service.cpuPercent)}</td>
        <td class="num">${fmtBytes(service.memoryBytes)}</td>
        <td>
          <div class="row-actions">
            <button data-edit-service="${escapeHtml(service.id)}">编辑</button>
            <button data-log-service="${escapeHtml(service.id)}">日志</button>
            ${actions}
          </div>
        </td>
      </tr>
      ${state.expandedServiceId === service.id ? inlineDetailHtml(service) : ""}`;
    })
    .join("");

  const logList = $("log-service-list");
  if (logList)
    logList.innerHTML = services
      .map(
        (service) => `
        <button class="log-service-item ${state.logServiceId === service.id ? "active" : ""}" data-log-service="${escapeHtml(service.id)}">
          <span class="state-dot ${escapeHtml(service.state)}"></span>
          <span>${escapeHtml(service.name)}</span>
        </button>`,
      )
      .join("");

  if (
    state.view === "logs" &&
    services.length &&
    (!state.logServiceId ||
      !services.some((item) => item.id === state.logServiceId))
  ) {
    state.logServiceId = services[0].id;
    loadLogs();
  }

  if (
    state.expandedServiceId &&
    !services.some((item) => item.id === state.expandedServiceId)
  )
    state.expandedServiceId = null;
  renderProjects();
}

/* ---------- projects ---------- */

function isProjectService(service) {
  return (
    service.category === "project" ||
    (!service.category && service.kind === "process")
  );
}

function projectServices() {
  return state.services.filter(isProjectService);
}

function renderProjects() {
  const all = projectServices();
  const search = state.projectSearch.trim().toLowerCase();
  const filtered = search
    ? all.filter((service) =>
        [
          service.name,
          service.group,
          service.port,
          service.target,
          service.description,
          service.details?.compose?.containers
            ?.map(
              (container) =>
                `${container.name} ${container.service} ${container.state}`,
            )
            .join(" "),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search),
      )
    : all;
  const running = all.filter((service) => service.state === "running").length;
  const ports = all
    .map((service) => service.port)
    .filter((port) => Number.isFinite(port));
  $("nav-project-count").textContent = String(all.length);
  $("project-count").textContent = `${filtered.length} / ${all.length} 个项目`;
  $("project-summary").textContent = all.length
    ? `${all.length} 个项目 · ${running} 运行中${ports.length ? ` · 端口 ${ports.join(", ")}` : ""}`
    : "还没有登记项目服务";
  const list = $("project-list");
  if (!filtered.length) {
    list.innerHTML = `<div class="project-empty">
      <strong>${all.length ? "没有匹配的项目" : "还没有项目服务"}</strong>
      <span>${all.length ? "换一个搜索词试试。" : "把 Node、Python 或其他常驻服务登记到这里，和系统进程分开管理。"}</span>
      ${all.length ? "" : '<button class="btn btn-small" id="add-project-empty">新增项目服务</button>'}
    </div>`;
    return;
  }
  list.innerHTML = filtered
    .map((service) => {
      const actions = visibleActions(service)
        .map(
          (action) =>
            `<button class="btn btn-small" data-action="${escapeHtml(action)}" data-service-id="${escapeHtml(service.id)}">${escapeHtml(actionLabels[action] ?? action)}</button>`,
        )
        .join("");
      const compose = service.details?.compose;
      const isCompose = service.adapter === "docker-compose";
      const tailnet = state.projectTailnet?.projects?.find(
        (item) => item.id === service.id,
      );
      const tailnetAction =
        state.projectTailnet?.tailscale?.running && service.port
          ? tailnet?.enabled
            ? `<button class="btn btn-small" data-tailnet-project="${escapeHtml(service.id)}" data-tailnet-enabled="false">关闭 Tailnet</button>`
            : `<button class="btn btn-small" data-tailnet-project="${escapeHtml(service.id)}" data-tailnet-enabled="true">开放 Tailnet</button>`
          : "";
      return `<article class="project-card">
        <header class="project-card-head">
          <div class="project-title">
            <span class="state-dot ${escapeHtml(service.state)}"></span>
            <div>
              <strong>${escapeHtml(service.name)}</strong>
              <small>${escapeHtml(service.group ?? "项目服务")} · ${escapeHtml(service.kind)}</small>
            </div>
          </div>
          <span class="project-badges">
            ${service.persisted ? '<span class="persist-badge">常驻</span>' : ""}
            <span class="state-pill ${escapeHtml(service.state)}">${escapeHtml(stateLabels[service.state] ?? service.state)}</span>
          </span>
        </header>
        <p class="project-target" title="${escapeHtml(service.target)}">${escapeHtml(service.description || service.target)}</p>
        ${tailnet?.enabled ? `<p class="project-tailnet">Tailnet · <span>${escapeHtml(tailnet.tailnetUrl)}</span></p>` : ""}
        ${
          isCompose
            ? `<div class="project-facts">
                 <div><span>服务</span><strong>${compose?.runningCount ?? 0} / ${compose?.serviceCount ?? "—"}</strong></div>
                 <div><span>容器</span><strong>${compose?.containers.length ?? 0}</strong></div>
                 <div><span>项目</span><strong>${escapeHtml(compose?.projectName ?? service.projectName ?? "—")}</strong></div>
                 <div><span>状态</span><strong>${escapeHtml(stateLabels[service.state] ?? service.state)}</strong></div>
               </div>
               ${
                 compose?.containers.length
                   ? `<p class="project-containers">${compose.containers
                       .map(
                         (container) =>
                           `${escapeHtml(container.service || container.name)}: ${escapeHtml(container.state)}`,
                       )
                       .join(" · ")}</p>`
                   : ""
               }`
            : `<div class="project-facts">
                 <div><span>端口</span><strong>${service.port ?? "—"}</strong></div>
                 <div><span>PID</span><strong>${service.pid ?? "—"}</strong></div>
                 <div><span>CPU</span><strong>${fmtPercent(service.cpuPercent)}</strong></div>
                 <div><span>内存</span><strong>${fmtBytes(service.memoryBytes)}</strong></div>
               </div>`
        }
        ${service.lastError ? `<p class="project-error">${escapeHtml(service.lastError)}</p>` : ""}
        <footer class="project-actions">
          ${
            isCompose
              ? '<span class="muted">由 Docker Compose 管理</span>'
              : service.persisted
                ? `<button class="btn btn-small" data-autostart-project="${escapeHtml(service.id)}" data-autostart-enabled="${service.autostart === false ? "true" : "false"}">开机启动：${service.autostart === false ? "关" : "开"}</button><button class="btn btn-small" data-persist-project="${escapeHtml(service.id)}">更新常驻</button><button class="btn btn-small" data-unpersist-project="${escapeHtml(service.id)}">取消常驻</button>`
                : `<button class="btn btn-small" data-persist-project="${escapeHtml(service.id)}">设为常驻</button>`
          }
          ${tailnetAction}
          <button class="btn btn-small" data-log-service="${escapeHtml(service.id)}">日志</button>
          <button class="btn btn-small" data-edit-service="${escapeHtml(service.id)}">编辑</button>
          ${actions}
        </footer>
      </article>`;
    })
    .join("");
}

function renderDiscovered() {
  const snapshot = state.discovered;
  if (!snapshot) return;
  const list = $("discovered-list");
  const processes = snapshot.processes;
  $("discovered-summary").textContent = processes.length
    ? `发现 ${processes.length} 个正在监听的开发服务；没有登记的可以一键纳入项目。`
    : "没有发现新的开发服务。";
  if (!processes.length) {
    list.innerHTML =
      '<p class="muted" style="padding: 8px 2px">启动本地 Node/Python/Go/Rust 服务并监听端口后，这里会自动出现。</p>';
    return;
  }
  list.innerHTML = processes
    .map(
      (processInfo) => `<div class="discovered-row">
        ${processIconHtml(processInfo)}
        <div class="discovered-main">
          <strong>${escapeHtml(processInfo.name)}</strong>
          <small title="${escapeHtml(`${processInfo.command} ${processInfo.args.join(" ")}`)}">${escapeHtml(processInfo.command)} ${escapeHtml(processInfo.args.join(" "))} · ${escapeHtml(processInfo.cwd)}</small>
        </div>
        <div class="discovered-port">
          <span>端口</span><strong>${processInfo.port}</strong>
        </div>
        <div class="discovered-memory">
          <span>内存</span><strong>${fmtBytes(processInfo.memoryBytes)}</strong>
        </div>
        <div class="discovered-actions">
          <button class="btn btn-small" data-adopt-discovered="${processInfo.pid}">纳入项目</button>
          ${
            processInfo.killable
              ? `<button class="btn btn-small btn-danger" data-terminate-pid="${processInfo.pid}" data-terminate-name="${escapeHtml(processInfo.name)}">终止</button>`
              : `<span class="muted" title="${escapeHtml(processInfo.protectedReason ?? "")}">—</span>`
          }
        </div>
      </div>`,
    )
    .join("");
}

async function loadDiscovered() {
  try {
    state.discovered = await api("/api/discovered");
    renderDiscovered();
  } catch {
    // Keep the last discovery result on transient failures.
  }
}

async function loadProjectTailnet() {
  try {
    state.projectTailnet = await api("/api/tailscale/projects");
    renderProjects();
  } catch {
    state.projectTailnet = null;
  }
}

async function changeProjectTailnet(serviceId, enabled, button) {
  const service = state.services.find((item) => item.id === serviceId);
  if (!service?.port) return;
  if (enabled) {
    if (!state.projectTailnet?.tailscale?.running) {
      toast("Tailscale 未运行或未登录", true);
      return;
    }
    if (!state.config?.tokenRequired) {
      if (!confirm("启用 Tailnet 项目入口前需要先生成访问 Token。现在生成？"))
        return;
      const generated = await generateAccessToken({ confirmRotation: false });
      if (!generated) return;
    }
    if (
      !confirm(
        `把 ${service.name} 的 127.0.0.1:${service.port} 通过 Tailscale Serve 开放给 tailnet？\n\n只有 tailnet 设备可访问；项目自身如果没有登录，tailnet 内其他设备也能直接访问。`,
      )
    )
      return;
  } else if (
    !confirm(`关闭 ${service.name} 的 Tailnet 入口？本机端口访问不受影响。`)
  )
    return;
  if (button) button.disabled = true;
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(serviceId)}/tailscale`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studioops-actor": "web",
        },
        body: JSON.stringify({ enabled }),
      },
    );
    toast(
      enabled
        ? `已开放 ${result.project.tailnetUrl ?? "Tailnet 入口"}`
        : "Tailnet 项目入口已关闭",
    );
    await loadProjectTailnet();
    await refreshAll({ quiet: true });
  } catch (error) {
    toast(error.message, true);
    await loadProjectTailnet();
  } finally {
    if (button) button.disabled = false;
  }
}

function adoptDiscovered(processInfo) {
  openServiceForm({
    id: processInfo.suggestedId || `project-${processInfo.port}`,
    name: processInfo.name,
    kind: "process",
    category: "project",
    group: "项目服务",
    adapter: "process",
    target: processInfo.cwd,
    command: processInfo.command,
    args: processInfo.args,
    cwd: processInfo.cwd,
    port: processInfo.port,
    allowedActions: ["start", "stop", "restart", "pause", "resume"],
    health: { type: "none" },
  });
  state.formServiceId = null;
  $("form-id").readOnly = false;
  $("config-title").textContent = "纳入项目";
  $("config-delete").classList.add("hidden");
  setFormError("");
}

async function changeProjectAutostart(serviceId, enabled, button) {
  const service = state.services.find((item) => item.id === serviceId);
  const name = service?.name ?? serviceId;
  if (
    !confirm(
      enabled
        ? `开启 ${name} 的开机启动？\n下次登录会自动启动该服务。`
        : `关闭 ${name} 的开机启动？\n当前运行的服务会保持运行，但下次登录不会自动启动。`,
    )
  )
    return;
  if (button) button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(serviceId)}/autostart`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studioops-actor": "web",
      },
      body: JSON.stringify({ enabled }),
    });
    toast(`${name} 开机启动已${enabled ? "开启" : "关闭"}`);
    await refreshAll({ quiet: true });
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function changeProjectPersistence(serviceId, enabled, button) {
  const service = state.services.find((item) => item.id === serviceId);
  const name = service?.name ?? serviceId;
  const message = enabled
    ? service?.persisted
      ? `更新 ${name} 的常驻配置？\nlaunchd 会重新加载 plist 并重启服务。`
      : `将 ${name} 设为常驻？\n当前进程会停止，改由 launchd 在登录和重启后自动启动。`
    : `取消 ${name} 的常驻？\nlaunchd 会自动停止该服务，之后由 StudioOps 手动启动。`;
  if (!confirm(message)) return;
  if (button) button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(serviceId)}/persist`, {
      method: enabled ? "POST" : "DELETE",
      headers: { "x-studioops-actor": "web" },
    });
    toast(enabled ? `${name} 已设为常驻` : `${name} 已取消常驻`);
    await refreshAll({ quiet: true });
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- processes ---------- */

function renderProcesses() {
  const search = state.processSearch.trim().toLowerCase();
  const processes = state.processes.filter((process) => {
    if (!search) return true;
    return `${process.command} ${process.pid} ${process.user}`
      .toLowerCase()
      .includes(search);
  });
  $("process-count").textContent =
    `top ${processes.length} / ${state.processTotal} 个进程 · ${state.processSort === "memory" ? "按内存" : "按 CPU"}`;
  $("processes-empty").classList.toggle("hidden", processes.length > 0);
  $("processes-body").innerHTML = processes
    .map(
      (process) => `
      <tr>
        <td class="num mono">${process.pid}</td>
        <td>
          <div class="process-name">
            ${processIconHtml(process)}
            <div>
              <strong class="strong mono" title="${escapeHtml(process.command)}">${escapeHtml(baseName(process.command))}</strong>
              <span class="cell-sub">${escapeHtml(process.command)}</span>
            </div>
          </div>
        </td>
        <td>${escapeHtml(process.user)}</td>
        <td class="num"><div class="usage-cell"><span class="meter"><i style="width:${Math.min(Math.max(process.cpuPercent, 0), 100)}%"></i></span>${fmtPercent(process.cpuPercent)}</div></td>
        <td class="num"><div class="usage-cell"><span class="meter memory"><i style="width:${Math.min(Math.max(process.memoryPercent, 0), 100)}%"></i></span>${fmtPercent(process.memoryPercent)}</div></td>
        <td class="num">${fmtBytes(process.memoryBytes)}</td>
        <td class="num mono">${process.ppid}</td>
        <td>
          <div class="row-actions">
            ${
              process.killable
                ? `<button class="danger" data-terminate-pid="${process.pid}" data-terminate-name="${escapeHtml(baseName(process.command))}">终止</button>`
                : `<span class="muted" title="${escapeHtml(process.protectedReason ?? "")}">—</span>`
            }
          </div>
        </td>
      </tr>`,
    )
    .join("");

  $("overview-process-body").innerHTML = state.processes
    .slice(0, 8)
    .map(
      (process) => `
      <tr>
        <td class="num mono">${process.pid}</td>
        <td>
          <div class="process-name">
            ${processIconHtml(process)}
            <div>
              <strong class="strong mono" title="${escapeHtml(process.command)}">${escapeHtml(baseName(process.command))}</strong>
              <span class="cell-sub">${escapeHtml(process.user)}</span>
            </div>
          </div>
        </td>
        <td class="num"><div class="usage-cell"><span class="meter"><i style="width:${Math.min(Math.max(process.cpuPercent, 0), 100)}%"></i></span>${fmtPercent(process.cpuPercent)}</div></td>
        <td class="num">${fmtBytes(process.memoryBytes)}</td>
      </tr>`,
    )
    .join("");
}

/* ---------- events ---------- */

function renderEvents() {
  const events = state.events.slice(0, 12);
  $("overview-event-body").innerHTML = events.length
    ? events
        .map(
          (event) => `
        <tr>
          <td class="mono">${escapeHtml(fmtClock(event.at))}</td>
          <td><span class="strong">${escapeHtml(event.serviceId)}</span></td>
          <td>${escapeHtml(actionLabels[event.action] ?? event.action)}</td>
          <td><span class="health-text ${event.success ? "healthy" : "unhealthy"}">${event.success ? "ok" : "fail"}</span></td>
          <td>
            <span class="strong">${escapeHtml(event.actor ?? "local")}</span>
            ${
              event.remoteUser
                ? `<span class="cell-sub" title="${escapeHtml(event.remoteName ?? event.remoteUser)}">${escapeHtml(event.remoteUser)}</span>`
                : ""
            }
          </td>
        </tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="muted">暂无操作记录</td></tr>';
}

/* ---------- docker ---------- */

function renderDocker() {
  const docker = state.docker;
  if (!docker) return;
  const dot = $("docker-dot");
  dot.className = `status-dot ${docker.available ? "online" : "offline"}`;
  $("docker-version").textContent = docker.serverVersion
    ? `v${docker.serverVersion}`
    : docker.cliInstalled
      ? "CLI 已安装"
      : "未安装";

  if (!docker.cliInstalled) {
    $("docker-title").textContent = "未安装 Docker CLI";
    $("docker-detail").textContent =
      "安装 Docker Desktop 或 colima 后，这里会显示容器。";
  } else if (!docker.available) {
    $("docker-title").textContent = "Docker CLI 已安装，daemon 未运行";
    $("docker-detail").textContent =
      docker.error || "启动 Docker Desktop 或 colima 后重新检查。";
  } else {
    $("docker-title").textContent = "Docker daemon 运行中";
    $("docker-detail").textContent = docker.error
      ? docker.error
      : `共 ${docker.containers.length} 个容器`;
  }

  $("container-summary").textContent = docker.available
    ? `${docker.containers.filter((item) => item.state === "running").length} 个运行中 · 共 ${docker.containers.length} 个`
    : "Docker daemon 可用后显示容器列表";

  const hasContainers = docker.containers.length > 0;
  $("containers-body").innerHTML = docker.containers
    .map((container) => {
      const running = container.state === "running";
      return `
      <tr>
        <td><span class="strong">${escapeHtml(container.name)}</span><span class="cell-sub">${escapeHtml(container.status)}</span></td>
        <td class="mono">${escapeHtml(container.image)}</td>
        <td><span class="state-pill ${running ? "running" : "stopped"}">${escapeHtml(container.state)}</span></td>
        <td class="mono">${escapeHtml(container.ports || "—")}</td>
        <td>
          <div class="row-actions">
            ${running ? "" : `<button data-container-action="start" data-container-id="${escapeHtml(container.id)}">启动</button>`}
            ${running ? `<button data-container-action="stop" data-container-id="${escapeHtml(container.id)}">停止</button>` : ""}
            <button data-container-action="restart" data-container-id="${escapeHtml(container.id)}">重启</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
  const empty = $("containers-empty");
  empty.classList.toggle("hidden", hasContainers);
  const dockerError = docker.available && docker.error;
  empty.querySelector("strong").textContent = dockerError
    ? "无法读取容器列表"
    : docker.available
      ? "还没有容器"
      : docker.cliInstalled
        ? "Docker daemon 未运行"
        : "未安装 Docker CLI";
  $("containers-empty-text").textContent = dockerError
    ? docker.error
    : docker.available
      ? "运行 docker run 或 compose up 后，容器会出现在这里。"
      : docker.cliInstalled
        ? "启动 Docker Desktop 或 colima，然后点击“重新检查”。"
        : "安装 Docker Desktop 或 colima 后，这里会显示容器并可启停。";
}

/* ---------- network connections ---------- */

const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 500;

function worldPoint(latitude, longitude) {
  return {
    x: ((longitude + 180) / 360) * WORLD_WIDTH,
    y: ((90 - latitude) / 180) * WORLD_HEIGHT,
  };
}

function networkArc(from, to) {
  const midX = (from.x + to.x) / 2;
  const midY =
    Math.min(from.y, to.y) - Math.max(24, Math.abs(from.x - to.x) * 0.18);
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${midX.toFixed(1)},${midY.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}

function renderWorldMap(data) {
  const overlay = $("network-map");
  const empty = $("network-empty");
  if (!overlay || !empty) return;
  const direction = state.networkDirection;
  const server = data.serverLocation
    ? worldPoint(data.serverLocation.latitude, data.serverLocation.longitude)
    : undefined;
  const activeInbound = data.inbound ?? [];
  const activeOutbound = data.outbound ?? [];
  const inbound = activeInbound.filter((connection) => connection.location);
  const outbound = activeOutbound.filter((connection) => connection.location);
  const inboundArcs =
    server && direction !== "outbound"
      ? inbound
          .map((connection) => {
            const source = worldPoint(
              connection.location.latitude,
              connection.location.longitude,
            );
            return `<path class="world-map-arc inbound" d="${networkArc(source, server)}"><title>${escapeHtml(
              `${connection.process} · ${connection.location.city ?? connection.location.country}`,
            )}</title></path>
            <circle class="world-map-point inbound" cx="${source.x.toFixed(1)}" cy="${source.y.toFixed(1)}" r="3.2"><title>${escapeHtml(
              `${connection.remoteAddress} · ${connection.location.city ?? connection.location.country}`,
            )}</title></circle>`;
          })
          .join("")
      : "";
  const outboundArcs =
    server && direction !== "inbound"
      ? outbound
          .map((connection) => {
            const target = worldPoint(
              connection.location.latitude,
              connection.location.longitude,
            );
            return `<path class="world-map-arc outbound" d="${networkArc(server, target)}"><title>${escapeHtml(
              `${connection.process} → ${connection.remoteAddress} · ${connection.location.city ?? connection.location.country}`,
            )}</title></path>
            <circle class="world-map-point outbound" cx="${target.x.toFixed(1)}" cy="${target.y.toFixed(1)}" r="2.8"><title>${escapeHtml(
              `${connection.remoteAddress} · ${connection.location.city ?? connection.location.country}`,
            )}</title></circle>`;
          })
          .join("")
      : "";
  const marker = server
    ? `<circle class="world-map-server" cx="${server.x.toFixed(1)}" cy="${server.y.toFixed(1)}" r="4.5" />
       <circle class="world-map-server-ring" cx="${server.x.toFixed(1)}" cy="${server.y.toFixed(1)}" r="9" />`
    : "";
  overlay.innerHTML = inboundArcs + outboundArcs + marker;
  if (!data.serverLocation) {
    empty.textContent = "服务器公网位置尚未解析";
    empty.classList.remove("hidden");
  } else if (direction === "inbound") {
    empty.textContent = activeInbound.length
      ? "检测到入站连接，地理定位暂不可用"
      : "暂无公网入站连接";
    empty.classList.toggle("hidden", inbound.length > 0);
  } else if (direction === "outbound") {
    empty.textContent = activeOutbound.length
      ? "出站连接暂未完成地理定位"
      : "暂无公网出站连接";
    empty.classList.toggle("hidden", outbound.length > 0);
  } else {
    empty.textContent = "暂无带地理位置的公网连接";
    empty.classList.toggle("hidden", inbound.length + outbound.length > 0);
  }
}

function renderNetworkList(data) {
  const direction = state.networkDirection;
  const source =
    direction === "inbound"
      ? (data.inbound ?? [])
      : direction === "outbound"
        ? (data.outbound ?? [])
        : [...(data.inbound ?? []), ...(data.outbound ?? [])];
  const grouped = new Map();
  for (const connection of source) {
    const key = `${connection.direction}:${connection.process}:${connection.remoteAddress}:${connection.remotePort}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = connection.lastSeenAt;
    } else {
      grouped.set(key, {
        ...connection,
        count: 1,
      });
    }
  }
  const rows = [...grouped.values()].sort((left, right) => {
    if (left.direction !== right.direction)
      return left.direction === "inbound" ? -1 : 1;
    const leftSsh = left.remotePort === 22 || left.process === "ssh";
    const rightSsh = right.remotePort === 22 || right.process === "ssh";
    if (leftSsh !== rightSsh) return leftSsh ? -1 : 1;
    return right.count - left.count;
  });
  const list = $("network-list");
  if (!rows.length) {
    list.innerHTML = `<p class="network-empty">${direction === "inbound" ? "当前没有公网入站连接。" : direction === "outbound" ? "当前没有公网出站连接。" : "当前没有公网连接。"} Tailscale 和私有网段不会显示在这里。</p>`;
    return;
  }
  list.innerHTML = rows
    .slice(0, 40)
    .map(
      (connection) => `<div class="network-row">
        <span class="network-dir ${connection.direction}">${connection.direction === "inbound" ? "入站" : "出站"}</span>
        <div class="network-main">
          <strong>${escapeHtml(connection.process)}${connection.pid ? ` · ${connection.pid}` : ""}</strong>
          <small>本地 :${connection.localPort} → ${escapeHtml(connection.remoteAddress)}:${connection.remotePort}</small>
        </div>
        <span class="network-place">${escapeHtml(
          connection.location
            ? [connection.location.city, connection.location.country]
                .filter(Boolean)
                .join(", ")
            : "—",
        )}</span>
        <span class="network-count">${connection.count > 1 ? `x${connection.count}` : ""}</span>
      </div>`,
    )
    .join("");
}

function renderNetwork() {
  const data = state.network;
  if (!data) return;
  const location = data.serverLocation;
  $("network-server").textContent = location
    ? `${location.city ?? location.region ?? location.country} · ${location.countryCode ?? ""}`
    : "未知";
  $("network-inbound").textContent = String(data.inbound?.length ?? 0);
  $("network-outbound").textContent = String(data.outbound?.length ?? 0);
  renderWorldMap(data);
  renderNetworkList(data);
  if (data.error) toast(data.error, true);
}

async function loadNetwork({ refresh = false, quiet = false } = {}) {
  if (state.networkBusy) return;
  state.networkBusy = true;
  try {
    state.network = refresh
      ? await api("/api/network/refresh", {
          method: "POST",
          headers: { "x-studioops-actor": "web" },
        })
      : await api("/api/network/connections");
    renderNetwork();
  } catch (error) {
    if (!quiet) toast(error.message, true);
  } finally {
    state.networkBusy = false;
  }
}

/* ---------- metrics history ---------- */

const historyMetrics = [
  {
    metric: "cpu.percent",
    label: "CPU",
    unit: "%",
    color: "green",
    min: 0,
    max: 100,
  },
  {
    metric: "gpu.percent",
    label: "GPU",
    unit: "%",
    color: "green",
    min: 0,
    max: 100,
  },
  {
    metric: "memory.percent",
    label: "内存",
    unit: "%",
    color: "amber",
    min: 0,
    max: 100,
  },
  {
    metric: "disk.free.percent",
    label: "磁盘余量",
    unit: "%",
    color: "green",
    min: 0,
    max: 100,
  },
  { metric: "power.watts", label: "功耗", unit: "W", color: "amber" },
  { metric: "temp.cpu.c", label: "CPU 温度", unit: "°C", color: "red" },
];

function formatMetricValue(value, unit) {
  if (!Number.isFinite(value)) return "—";
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "bytes") return fmtBytes(value);
  if (unit === "W") return `${value.toFixed(1)} W`;
  if (unit === "°C") return `${value.toFixed(1)} °C`;
  if (unit === "rpm") return `${value.toFixed(0)} rpm`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function historyChartHtml(series, options) {
  const points = series?.points ?? [];
  if (!points.length) {
    return `<article class="history-card">
      <header><span>${escapeHtml(options.label)}</span><strong>—</strong></header>
      <div class="history-empty">暂无数据</div>
    </article>`;
  }
  const width = 320;
  const height = 90;
  const pad = 6;
  const values = points.map((point) => point.value);
  const minValue = options.min ?? Math.min(...values);
  const maxValue = options.max ?? Math.max(...values);
  const span = maxValue - minValue || 1;
  const lastTs = points.at(-1)?.ts;
  const firstTs = points[0]?.ts;
  const timeSpan = lastTs && firstTs ? lastTs - firstTs || 1 : 1;
  const path = points
    .map((point, index) => {
      const x = pad + ((point.ts - firstTs) / timeSpan) * (width - pad * 2);
      const y =
        height - pad - ((point.value - minValue) / span) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${path} L${width - pad},${height - pad} L${pad},${height - pad} Z`;
  const latest = values.at(-1);
  return `<article class="history-card">
    <header>
      <span>${escapeHtml(options.label)}</span>
      <strong>${escapeHtml(formatMetricValue(latest, options.unit))}</strong>
    </header>
    <svg class="history-svg ${options.color ?? "green"}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="${escapeHtml(options.label)} 曲线">
      <path class="history-area ${options.color ?? "green"}" d="${area}" />
      <path class="history-line ${options.color ?? "green"}" d="${path}" vector-effect="non-scaling-stroke" />
    </svg>
    <footer>
      <span>低 ${escapeHtml(formatMetricValue(minValue, options.unit))}</span>
      <span>高 ${escapeHtml(formatMetricValue(maxValue, options.unit))}</span>
    </footer>
  </article>`;
}

function findMetricSeries(data, scope, scopeId, metric) {
  return data.series.find(
    (series) =>
      series.scope === scope &&
      series.scopeId === scopeId &&
      series.metric === metric,
  );
}

function renderHistory() {
  const data = state.historyData;
  if (!data) return;
  const rangeLabels = { "5m": "5 分钟", "1h": "1 小时", "24h": "24 小时" };
  $("history-meta").textContent =
    `${rangeLabels[data.range] ?? data.range} · ${data.series.length} 个序列 · ${fmtClock(new Date(data.to).toISOString())}`;
  $("history-system").innerHTML = historyMetrics
    .map((definition) =>
      historyChartHtml(
        findMetricSeries(data, "system", "local", definition.metric),
        definition,
      ),
    )
    .join("");

  const serviceSeries = data.series.filter(
    (series) => series.scope === "service",
  );
  const serviceIds = [
    ...new Set(serviceSeries.map((series) => series.scopeId)),
  ];
  const select = $("history-service");
  if (!serviceIds.length) {
    select.innerHTML = '<option value="">暂无服务数据</option>';
    $("history-service-meta").textContent = "启动服务并等待采样后显示";
    $("history-service-charts").innerHTML = "";
    return;
  }
  const selected =
    state.historyServiceId && serviceIds.includes(state.historyServiceId)
      ? state.historyServiceId
      : serviceIds[0];
  state.historyServiceId = selected;
  select.innerHTML = serviceIds
    .map((id) => {
      const service = state.services.find((item) => item.id === id);
      return `<option value="${escapeHtml(id)}">${escapeHtml(service?.name ?? id)}</option>`;
    })
    .join("");
  select.value = selected;
  const service = state.services.find((item) => item.id === selected);
  $("history-service-meta").textContent =
    `${service?.name ?? selected} · ${serviceSeries.filter((series) => series.scopeId === selected).length} 个指标`;
  $("history-service-charts").innerHTML = [
    {
      metric: "cpu.percent",
      label: "服务 CPU",
      unit: "%",
      color: "green",
      min: 0,
      max: 100,
    },
    {
      metric: "memory.bytes",
      label: "服务内存",
      unit: "bytes",
      color: "amber",
    },
  ]
    .map((definition) =>
      historyChartHtml(
        findMetricSeries(data, "service", selected, definition.metric),
        definition,
      ),
    )
    .join("");
}

async function loadHistory({ quiet = false } = {}) {
  if (!quiet && state.view !== "history") return;
  try {
    state.historyData = await api(
      `/api/metrics/history?range=${encodeURIComponent(state.historyRange)}`,
    );
    renderHistory();
  } catch (error) {
    if (!quiet) toast(error.message, true);
  }
}

function setHistoryRange(range) {
  if (!["5m", "1h", "24h"].includes(range)) return;
  state.historyRange = range;
  document
    .querySelectorAll("#history-range [data-history-range]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.historyRange === range),
    );
  loadHistory();
}

async function loadLaunchdAgents() {
  $("launchd-summary").textContent = "扫描中…";
  try {
    state.launchdAgents = await api("/api/launchd/agents");
    renderLaunchdAgents();
  } catch (error) {
    $("launchd-summary").textContent = error.message;
    $("launchd-list").innerHTML =
      '<p class="launchd-empty">无法读取 LaunchAgent</p>';
  }
}

function renderLaunchdAgents() {
  const agents = state.launchdAgents ?? [];
  const configured = agents.filter((agent) => agent.configuredServiceId).length;
  $("launchd-summary").textContent = agents.length
    ? `${agents.length} 个 · 已配置 ${configured} 个`
    : "没有发现用户 LaunchAgent";
  if (!agents.length) {
    $("launchd-list").innerHTML =
      '<p class="launchd-empty">没有发现用户 LaunchAgent</p>';
    return;
  }
  $("launchd-list").innerHTML = agents
    .map((agent) => {
      const command = [agent.program, ...(agent.args ?? [])]
        .filter(Boolean)
        .join(" ");
      return `<div class="launchd-row">
        <div class="launchd-main">
          <strong title="${escapeHtml(agent.label)}">${escapeHtml(agent.label)}</strong>
          <small title="${escapeHtml(agent.plistPath)}">${escapeHtml(command || agent.plistPath)}</small>
        </div>
        <span class="launchd-state ${agent.loaded ? "loaded" : "stopped"}">
          ${agent.loaded ? `PID ${agent.pid ?? "—"}` : "未加载"}
        </span>
        <span class="launchd-configured">${agent.configuredServiceId ? "已配置" : ""}</span>
        <button
          class="btn btn-small"
          data-launchd-import="${escapeHtml(agent.label)}"
          ${agent.configuredServiceId ? "disabled" : ""}
        >${agent.configuredServiceId ? "已导入" : "导入"}</button>
      </div>`;
    })
    .join("");
}

function openLaunchdImport(agent) {
  if (!agent) return;
  openServiceForm({
    id: agent.suggestedId,
    name: agent.suggestedName,
    kind: "launchd",
    adapter: "launchd",
    target: agent.target,
    plistFile: agent.plistPath,
    logFile: agent.stdoutPath,
    group: "LaunchAgent",
    category: "system",
    description: [agent.program, ...(agent.args ?? [])]
      .filter(Boolean)
      .join(" "),
    allowedActions: ["start", "stop", "restart"],
    health: { type: "none" },
  });
  state.formServiceId = null;
  $("form-id").readOnly = false;
  $("config-title").textContent = "导入 LaunchAgent";
  $("config-delete").classList.add("hidden");
  setFormError("");
}

async function loadAlertsStatus({
  populateSettings = false,
  quiet = false,
} = {}) {
  try {
    const data = await api("/api/alerts/status");
    const firstLoad = !state.alerts;
    state.alerts = data;
    if (populateSettings || firstLoad) {
      $("alerts-enabled").checked = data.settings.enabled;
      $("alerts-desktop").checked = data.settings.desktopNotifications;
      $("alerts-service-down").value = String(data.settings.serviceDownSeconds);
      $("alerts-sustain").value = String(data.settings.sustainSeconds);
      $("alerts-repeat").value = String(data.settings.repeatMinutes);
      $("alerts-memory").value = String(data.settings.memoryPercent);
      $("alerts-disk").value = String(data.settings.diskFreePercent);
      $("alerts-temp").value = String(data.settings.temperatureC);
    }
    renderAlertsStatus();
  } catch (error) {
    if (!quiet) toast(error.message, true);
  }
}

function renderAlertsStatus() {
  const data = state.alerts;
  if (!data) return;
  const active = $("alerts-active");
  active.innerHTML = data.active.length
    ? data.active
        .map(
          (
            alert,
          ) => `<article class="alert-item ${alert.severity} ${alert.status}">
            <div class="alert-item-head">
              <strong>${escapeHtml(alert.title)}</strong>
              <span class="alert-status">${alert.status === "firing" ? "告警" : "确认中"}</span>
            </div>
            <p>${escapeHtml(alert.detail)}</p>
            <small>开始 ${escapeHtml(fmtDateTime(alert.since))}</small>
          </article>`,
        )
        .join("")
    : '<p class="alert-empty">没有活动告警</p>';

  const events = $("alerts-events");
  events.innerHTML = data.events.length
    ? data.events
        .slice(0, 10)
        .map(
          (event) => `<div class="alert-event ${event.status}">
            <span class="alert-event-status">${event.status === "resolved" ? "恢复" : event.status === "firing" ? "告警" : "确认"}</span>
            <div>
              <strong>${escapeHtml(event.title)}</strong>
              <p>${escapeHtml(event.detail)}</p>
            </div>
            <small>${escapeHtml(fmtDateTime(event.at))}</small>
          </div>`,
        )
        .join("")
    : '<p class="alert-empty">还没有告警记录</p>';

  const result = $("alerts-result");
  if (data.notificationError) {
    result.textContent = `桌面通知失败：${data.notificationError}`;
    result.classList.remove("hidden");
  } else if (!result.textContent) {
    result.classList.add("hidden");
  }
}

async function saveAlertSettings() {
  const button = $("alerts-save");
  button.disabled = true;
  try {
    await api("/api/alerts/settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-studioops-actor": "web",
      },
      body: JSON.stringify({
        enabled: $("alerts-enabled").checked,
        desktopNotifications: $("alerts-desktop").checked,
        serviceDownSeconds: Number($("alerts-service-down").value),
        sustainSeconds: Number($("alerts-sustain").value),
        repeatMinutes: Number($("alerts-repeat").value),
        memoryPercent: Number($("alerts-memory").value),
        diskFreePercent: Number($("alerts-disk").value),
        temperatureC: Number($("alerts-temp").value),
      }),
    });
    const result = $("alerts-result");
    result.textContent = "告警设置已保存";
    result.classList.remove("hidden");
    toast("告警设置已保存");
    await loadAlertsStatus({ populateSettings: true });
  } catch (error) {
    const result = $("alerts-result");
    result.textContent = error.message;
    result.classList.remove("hidden");
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function testAlertNotification() {
  try {
    await api("/api/alerts/test", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    toast("测试通知已发送");
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadMetricsSettings() {
  try {
    const settings = await api("/api/metrics/settings");
    state.metricsSettings = settings;
    $("metrics-interval").value = String(settings.intervalMs / 1000);
    $("metrics-raw-days").value = String(
      Math.round(settings.rawRetentionMs / 86400000),
    );
    $("metrics-minute-days").value = String(
      Math.round(settings.minuteRetentionMs / 86400000),
    );
    $("metrics-hour-days").value = String(
      Math.round(settings.hourRetentionMs / 86400000),
    );
  } catch (error) {
    const result = $("metrics-result");
    result.textContent = error.message;
    result.classList.remove("hidden");
  }
}

async function saveMetricsSettings() {
  const button = $("metrics-save");
  button.disabled = true;
  try {
    const settings = await api("/api/metrics/settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-studioops-actor": "web",
      },
      body: JSON.stringify({
        intervalMs: Number($("metrics-interval").value) * 1000,
        rawRetentionDays: Number($("metrics-raw-days").value),
        minuteRetentionDays: Number($("metrics-minute-days").value),
        hourRetentionDays: Number($("metrics-hour-days").value),
      }),
    });
    state.metricsSettings = settings;
    const result = $("metrics-result");
    result.textContent = "指标设置已保存";
    result.classList.remove("hidden");
    toast("指标历史设置已保存");
    if (state.view === "history") loadHistory({ quiet: true });
  } catch (error) {
    const result = $("metrics-result");
    result.textContent = error.message;
    result.classList.remove("hidden");
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

/* ---------- settings ---------- */

function renderSettingsFacts() {
  const config = state.config;
  const system = state.system;
  if (config) {
    $("settings-config-path").textContent = config.filePath ?? "未找到";
    $("settings-service-count").textContent = String(config.serviceCount);
    $("settings-config-source").textContent = config.usingFallback
      ? "未找到 services.yaml"
      : "本地配置";
    const configErrorElement = $("config-error");
    if (configErrorElement) {
      configErrorElement.textContent = config.configError ?? "";
      configErrorElement.classList.toggle("hidden", !config.configError);
    }
    $("settings-origin").textContent = agentOrigin;
    $("settings-bind").textContent = `${config.host}:${config.port}`;
    $("settings-token").textContent = config.tokenRequired
      ? config.tokenSource === "env"
        ? "已启用（STUDIOOPS_TOKEN）"
        : "已启用（本机生成）"
      : "未启用（仅本机回环）";
    $("settings-data-dir").textContent = config.dataDir ?? "—";
    $("settings-version").textContent = `v${config.version}`;
    if ($("brand-version"))
      $("brand-version").textContent = `v${config.version}`;
    const hint = $("token-hint");
    if (hint)
      hint.textContent = config.tokenRequired
        ? "已启用；HTTP 与 WebSocket 自动携带。Tailscale 私网访问也需要它。"
        : "仅监听本机回环；启用 Tailscale 私网访问时会引导生成 Token。";
    if ($("runtime-agent"))
      $("runtime-agent").textContent = `${config.host}:${config.port}`;
    if ($("runtime-config"))
      $("runtime-config").textContent = config.usingFallback
        ? "未找到"
        : `${config.serviceCount} services`;
  }
  if (system) {
    $("settings-host").textContent = system.hostname;
    $("settings-platform").textContent =
      `${system.platform} · ${system.arch} · ${system.cpuCount ?? "—"} 核`;
    $("settings-uptime").textContent = fmtUptime(system.uptimeSeconds);
  }
}

function loadTokenField() {
  const input = $("token-input");
  if (input) input.value = localStorage.getItem("studioops.token") ?? "";
}

/* ---------- drawer ---------- */

function comfyTaskHtml(task, serviceId) {
  const action =
    task.state === "running"
      ? `<button class="btn btn-small btn-danger" data-cancel-comfy="${escapeHtml(serviceId)}" data-prompt-id="${escapeHtml(task.promptId)}" data-running="true">中断</button>`
      : task.state === "pending"
        ? `<button class="btn btn-small" data-cancel-comfy="${escapeHtml(serviceId)}" data-prompt-id="${escapeHtml(task.promptId)}" data-running="false">取消</button>`
        : "";
  const meta = [
    task.classTypes.slice(0, 4).join(" · "),
    task.startedAt ? `开始 ${fmtClock(task.startedAt)}` : "",
    task.durationMs ? `耗时 ${(task.durationMs / 1000).toFixed(1)}s` : "",
    task.images ? `${task.images} 张图` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="comfy-task ${escapeHtml(task.state)}">
    <div class="comfy-task-head">
      <strong>${escapeHtml(task.state === "running" ? "运行中" : task.state === "pending" ? "等待中" : task.state === "success" ? "完成" : "失败")} · ${escapeHtml(task.promptId.slice(0, 8))}</strong>
      <small>#${task.number ?? "—"}</small>
      ${action}
    </div>
    <p>${escapeHtml(task.preview || meta || "无任务描述")}</p>
    <small>${escapeHtml(meta)}</small>
  </div>`;
}

function comfySectionHtml(service) {
  const snapshot = state.comfyuiQueues[service.id];
  const silicon = state.system?.silicon;
  if (!snapshot) {
    return `<section class="inline-section" id="comfy-section-${escapeHtml(service.id)}">
      <div class="inline-head"><h3>ComfyUI 队列</h3><span class="muted">加载中…</span></div>
    </section>`;
  }
  if (snapshot.error) {
    return `<section class="inline-section" id="comfy-section-${escapeHtml(service.id)}">
      <div class="inline-head"><h3>ComfyUI 队列</h3><button class="link" data-inline-comfy="${escapeHtml(service.id)}">刷新</button></div>
      <p class="model-empty">${escapeHtml(snapshot.error)}</p>
    </section>`;
  }
  const device = snapshot.device;
  const memory = device
    ? `${escapeHtml(device.name.toUpperCase())} · VRAM ${fmtBytes(device.vramUsedBytes)} / ${fmtBytes(device.vramTotalBytes)} · 可用 ${fmtBytes(device.vramFreeBytes)}`
    : "MPS 设备信息不可用";
  const mps = [
    memory,
    `GPU ${fmtPercent(silicon?.gpuPercent)}`,
    `温度 ${Number.isFinite(silicon?.cpuTemperatureC) ? `${silicon.cpuTemperatureC.toFixed(1)}°C` : "—"}`,
  ].join(" · ");
  const tasks = [
    ...snapshot.running.map((task) => comfyTaskHtml(task, service.id)),
    ...snapshot.pending.map((task) => comfyTaskHtml(task, service.id)),
  ].join("");
  const history = snapshot.history
    .slice(0, 6)
    .map((task) => comfyTaskHtml(task, service.id))
    .join("");
  return `<section class="inline-section" id="comfy-section-${escapeHtml(service.id)}">
    <div class="inline-head">
      <h3>ComfyUI 队列</h3>
      <span class="muted" id="inline-comfy-count-${escapeHtml(service.id)}">运行 ${snapshot.running.length} · 等待 ${snapshot.pending.length} · 历史 ${snapshot.history.length}</span>
      <button class="link" data-inline-comfy="${escapeHtml(service.id)}">刷新</button>
    </div>
    <div class="comfy-metrics" id="inline-comfy-metrics-${escapeHtml(service.id)}">${mps}</div>
    <div class="comfy-queue" id="inline-comfy-${escapeHtml(service.id)}">
      ${tasks || '<p class="model-empty">当前队列为空</p>'}
      ${history ? `<div class="comfy-history-head">最近历史</div>${history}` : ""}
    </div>
  </section>`;
}

async function loadInlineComfy(serviceId) {
  const service = state.services.find((item) => item.id === serviceId);
  if (!service || service.state !== "running") {
    state.comfyuiQueues[serviceId] = {
      error: "启动 ComfyUI 后可查看和取消队列任务",
      running: [],
      pending: [],
      history: [],
    };
    renderComfyInline(serviceId);
    return;
  }
  try {
    state.comfyuiQueues[serviceId] = await api(
      `/api/services/${encodeURIComponent(serviceId)}/comfyui`,
    );
  } catch (error) {
    state.comfyuiQueues[serviceId] = {
      error: error.message,
      running: [],
      pending: [],
      history: [],
    };
  }
  renderComfyInline(serviceId);
}

function renderComfyInline(serviceId) {
  if (state.expandedServiceId !== serviceId) return;
  const service = state.services.find((item) => item.id === serviceId);
  if (!service) return;
  const wrapper = $(`comfy-section-${serviceId}`);
  if (!wrapper) return;
  const replacement = document.createElement("div");
  replacement.innerHTML = comfySectionHtml(service);
  wrapper.replaceWith(replacement.firstElementChild);
}

async function cancelComfyTask(serviceId, promptId, running) {
  if (
    !confirm(
      running
        ? "中断正在运行的 ComfyUI 任务？当前生成会停止。"
        : "从队列中取消这个等待任务？",
    )
  )
    return;
  try {
    const result = await api(
      `/api/services/${encodeURIComponent(serviceId)}/comfyui/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studioops-actor": "web",
        },
        body: JSON.stringify({ promptId }),
      },
    );
    state.comfyuiQueues[serviceId] = result.snapshot;
    toast(running ? "已中断 ComfyUI 任务" : "已取消等待任务");
    renderComfyInline(serviceId);
    await refreshEvents();
    await loadInference();
  } catch (error) {
    toast(error.message, true);
    await loadInlineComfy(serviceId);
  }
}

function modelsToHtml(snapshot, service) {
  if (!snapshot.models.length)
    return '<p class="model-empty">没有已下载的模型</p>';
  const canManage = service?.state === "running";
  return snapshot.models
    .map((model) => {
      const memory = model.loaded
        ? [
            model.vramBytes ? `VRAM ${fmtBytes(model.vramBytes)}` : "",
            model.loadedBytes ? `内存 ${fmtBytes(model.loadedBytes)}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : `磁盘 ${fmtBytes(model.sizeBytes)}`;
      const meta = [
        model.family,
        model.parameterSize,
        model.quantization,
        memory,
      ]
        .filter(Boolean)
        .join(" · ");
      const expires =
        model.loaded && model.expiresAt
          ? ` · 到期 ${fmtClock(model.expiresAt)}`
          : "";
      const action = canManage
        ? model.loaded
          ? `<button class="btn btn-small" data-unload-model="${escapeHtml(service.id)}" data-model-name="${escapeHtml(model.name)}">卸载</button>`
          : `<button class="btn btn-small" data-load-model="${escapeHtml(service.id)}" data-model-name="${escapeHtml(model.name)}">加载</button>`
        : "";
      return `<div class="model-row">
        <div>
          <strong title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</strong>
          <small>${escapeHtml(meta)}${escapeHtml(expires)}</small>
        </div>
        ${model.loaded ? '<span class="model-badge">loaded</span>' : ""}
        ${action}
      </div>`;
    })
    .join("");
}

function inlineDetailHtml(service) {
  const models = state.ollamaModels[service.id];
  const log = state.inlineLogs[service.id];
  const health = service.healthState ?? "unknown";
  const comfySection =
    service.kind === "comfyui" ? comfySectionHtml(service) : "";
  const modelSection =
    service.kind === "ollama"
      ? `<section class="inline-section">
           <div class="inline-head">
             <h3>模型</h3>
             <span class="muted" id="inline-model-count-${escapeHtml(service.id)}">${
               models
                 ? `已加载 ${models.loadedCount} / 共 ${models.models.length}`
                 : ""
             }</span>
             <button class="link" data-inline-models="${escapeHtml(service.id)}">刷新</button>
           </div>
           <div class="model-list" id="inline-models-${escapeHtml(service.id)}">${
             models
               ? modelsToHtml(models, service)
               : '<p class="model-empty">加载中…</p>'
           }</div>
         </section>`
      : "";
  const actions = visibleActions(service)
    .map(
      (action) =>
        `<button class="btn btn-small" data-action="${escapeHtml(action)}" data-service-id="${escapeHtml(service.id)}">${escapeHtml(actionLabels[action] ?? action)}</button>`,
    )
    .join("");
  return `
    <tr class="service-detail-row">
      <td colspan="9">
        <div class="service-detail">
          <div class="inline-facts">
            <div class="inline-fact"><span>运行状态</span><strong>${escapeHtml(stateLabels[service.state] ?? service.state)}</strong></div>
            <div class="inline-fact"><span>健康检查</span><strong>${escapeHtml(healthLabels[health] ?? health)}</strong></div>
            <div class="inline-fact"><span>PID</span><strong>${service.pid ?? "—"}</strong></div>
            <div class="inline-fact"><span>端口</span><strong>${service.port ?? "—"}</strong></div>
            ${
              service.adapter === "docker-compose"
                ? `<div class="inline-fact"><span>Compose 服务</span><strong>${service.details?.compose?.runningCount ?? 0} / ${service.details?.compose?.serviceCount ?? "—"}</strong></div>`
                : ""
            }
            <div class="inline-fact"><span>CPU</span><strong>${fmtPercent(service.cpuPercent)}</strong></div>
            <div class="inline-fact"><span>内存</span><strong>${fmtBytes(service.memoryBytes)}</strong></div>
            <div class="inline-fact"><span>适配器</span><strong>${escapeHtml(service.adapter)}</strong></div>
            <div class="inline-fact"><span>更新时间</span><strong>${escapeHtml(fmtClock(service.updatedAt))}</strong></div>
            <div class="inline-fact wide"><span>目标</span><strong>${escapeHtml(service.target)}</strong></div>
            ${
              service.kind === "tunnel"
                ? `<div class="inline-fact wide"><span>公网入口</span><strong>${escapeHtml(service.publicUrl ?? "等待 cloudflared 分配")}</strong></div>
                   <div class="inline-fact wide"><span>最后错误</span><strong>${escapeHtml(service.lastError ?? "无")}</strong></div>
                   <div class="inline-fact wide"><span>隧道模式</span><strong>${escapeHtml(service.details?.tunnelMode ?? service.tunnelMode ?? "—")}</strong></div>`
                : ""
            }
            <div class="inline-fact wide"><span>允许动作</span><strong>${escapeHtml(service.allowedActions.join(" · "))}</strong></div>
          </div>
          ${comfySection}
          ${modelSection}
          ${
            service.adapter === "docker-compose" && service.details?.compose
              ? `<section class="inline-section">
                   <div class="inline-head"><h3>Compose 容器</h3><span class="muted">${escapeHtml(service.details.compose.projectName ?? "")}</span></div>
                   <div class="compose-list">
                     ${
                       service.details.compose.containers.length
                         ? service.details.compose.containers
                             .map(
                               (container) =>
                                 `<div class="compose-item"><span>${escapeHtml(container.service || container.name)}</span><strong>${escapeHtml(container.state)}</strong><small>${escapeHtml(container.status || container.image)}</small></div>`,
                             )
                             .join("")
                         : '<p class="muted">没有容器记录</p>'
                     }
                   </div>
                 </section>`
              : ""
          }
          <section class="inline-section">
            <div class="inline-head">
              <h3>最近日志</h3>
              <span class="muted">${escapeHtml(log?.source ?? "")}</span>
              <button class="link" data-inline-log="${escapeHtml(service.id)}">刷新</button>
            </div>
            <pre class="inline-log" id="inline-log-${escapeHtml(service.id)}">${escapeHtml(
              log ? log.lines.join("\n") : "加载中…",
            )}</pre>
          </section>
          <div class="inline-actions">
            <button class="btn btn-small" data-edit-service="${escapeHtml(service.id)}">编辑配置</button>
            ${
              service.pid && service.adapter === "process"
                ? `<button class="btn btn-small btn-danger" data-terminate-pid="${service.pid}" data-terminate-name="${escapeHtml(service.name)}">终止进程</button>`
                : ""
            }
            ${actions}
          </div>
        </div>
      </td>
    </tr>`;
}

function toggleServiceDetail(serviceId) {
  if (state.expandedServiceId === serviceId) {
    state.expandedServiceId = null;
    renderServices();
    return;
  }
  const service = state.services.find((item) => item.id === serviceId);
  if (!service) return;
  state.expandedServiceId = serviceId;
  renderServices();
  if (service.kind === "ollama") loadInlineModels(serviceId);
  if (service.kind === "comfyui") loadInlineComfy(serviceId);
  loadInlineLog(serviceId);
}

async function changeOllamaModel(serviceId, modelName, action, button) {
  if (button) button.disabled = true;
  try {
    await api(
      `/api/services/${encodeURIComponent(serviceId)}/models/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studioops-actor": "web",
        },
        body: JSON.stringify({ name: modelName }),
      },
    );
    toast(`${modelName} ${action === "load" ? "已加载" : "已卸载"}`);
    delete state.ollamaModels[serviceId];
    await loadInlineModels(serviceId);
    await loadInference();
    await refreshEvents();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadInlineModels(serviceId) {
  try {
    const data = await api(
      `/api/services/${encodeURIComponent(serviceId)}/models`,
    );
    state.ollamaModels[serviceId] = data;
    if (state.expandedServiceId !== serviceId) return;
    const target = $(`inline-models-${serviceId}`);
    const count = $(`inline-model-count-${serviceId}`);
    const service = state.services.find((item) => item.id === serviceId);
    if (target) target.innerHTML = modelsToHtml(data, service);
    if (count)
      count.textContent = `已加载 ${data.loadedCount} / 共 ${data.models.length}`;
  } catch (error) {
    if (state.expandedServiceId !== serviceId) return;
    const target = $(`inline-models-${serviceId}`);
    if (target)
      target.innerHTML = `<p class="model-empty">${escapeHtml(error.message)}</p>`;
  }
}

async function loadInlineLog(serviceId) {
  try {
    const log = await api(
      `/api/services/${encodeURIComponent(serviceId)}/logs?tail=60`,
    );
    state.inlineLogs[serviceId] = log;
    if (state.expandedServiceId !== serviceId) return;
    const target = $(`inline-log-${serviceId}`);
    if (target) target.textContent = log.lines.join("\n") || "暂无日志";
  } catch (error) {
    if (state.expandedServiceId !== serviceId) return;
    const target = $(`inline-log-${serviceId}`);
    if (target) target.textContent = error.message;
  }
}

/* ---------- service form ---------- */

function updateFormVisibility() {
  const adapter = $("form-adapter").value;
  $("fields-process").classList.toggle("hidden", adapter !== "process");
  $("fields-compose").classList.toggle("hidden", adapter !== "docker-compose");
  $("fields-launchd").classList.toggle("hidden", adapter !== "launchd");
  $("fields-cloudflared").classList.toggle("hidden", adapter !== "cloudflared");
}

function setFormError(message) {
  const element = $("form-error");
  element.textContent = message ?? "";
  element.classList.toggle("hidden", !message);
}

function resetServiceForm() {
  for (const id of [
    "form-id",
    "form-name",
    "form-group",
    "form-description",
    "form-target",
    "form-command",
    "form-args",
    "form-cwd",
    "form-log-file",
    "form-plist-file",
    "form-env",
    "form-pid-file",
    "form-port",
    "form-compose-file",
    "form-project-name",
    "form-tunnel-name",
    "form-tunnel-config",
    "form-token-env",
    "form-public-url",
    "form-health-endpoint",
  ])
    $(id).value = "";
  $("form-kind").value = "process";
  $("form-adapter").value = "process";
  $("form-tunnel-mode").value = "quick";
  $("form-category").value = "";
  $("form-health-type").value = "none";
  document
    .querySelectorAll("#config-form .check-row input")
    .forEach((input) => {
      input.checked = ["start", "stop", "restart"].includes(input.value);
    });
  $("config-delete").classList.add("hidden");
  $("form-id").readOnly = false;
  setFormError("");
  updateFormVisibility();
}

function openServiceForm(service) {
  resetServiceForm();
  $("template-field").classList.add("hidden");
  state.formServiceId = service?.id ?? null;
  $("config-title").textContent = service ? "编辑服务" : "新增服务";
  if (service) {
    $("form-id").value = service.id;
    $("form-id").readOnly = true;
    $("form-name").value = service.name;
    $("form-kind").value = service.kind;
    $("form-adapter").value = service.adapter;
    $("form-group").value = service.group ?? "";
    $("form-category").value = service.category ?? "";
    $("form-description").value = service.description ?? "";
    $("form-target").value = service.target;
    $("form-command").value = service.command ?? "";
    $("form-args").value = (service.args ?? []).join("\n");
    $("form-cwd").value = service.cwd ?? "";
    $("form-log-file").value = service.logFile ?? "";
    $("form-env").value = Object.entries(service.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    $("form-pid-file").value = service.pidFile ?? "";
    $("form-plist-file").value = service.plistFile ?? "";
    $("form-port").value = service.port ?? "";
    $("form-compose-file").value = service.composeFile ?? "";
    $("form-project-name").value = service.projectName ?? "";
    $("form-tunnel-mode").value = service.tunnelMode ?? "quick";
    $("form-tunnel-name").value = service.tunnelName ?? "";
    $("form-tunnel-config").value = service.tunnelConfig ?? "";
    $("form-token-env").value = service.tokenEnv ?? "";
    $("form-public-url").value = service.publicUrl ?? "";
    $("form-health-type").value = service.health?.type ?? "none";
    $("form-health-endpoint").value = service.health?.endpoint ?? "";
    document
      .querySelectorAll("#config-form .check-row input")
      .forEach((input) => {
        input.checked = service.allowedActions.includes(input.value);
      });
    $("config-delete").classList.remove("hidden");
  }
  updateFormVisibility();
  $("config-drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");
  $("form-name").focus();
}

async function loadProjectTemplates() {
  if (state.templates) return state.templates;
  try {
    state.templates = await api("/api/project-templates");
  } catch {
    state.templates = [];
  }
  return state.templates;
}

function templateLabel(template) {
  return template.requires
    ? `${template.name}（需要 ${template.requires}）`
    : template.name;
}

function applyProjectTemplate(templateId) {
  const template = state.templates?.find((item) => item.id === templateId);
  if (!template) return;
  $("form-kind").value = "process";
  $("form-adapter").value = "process";
  $("form-category").value = "project";
  if (!$("form-group").value.trim()) $("form-group").value = "项目服务";
  $("form-command").value = template.command;
  $("form-args").value = template.args.join("\n");
  $("form-port").value = String(template.port);
  if (template.healthPath) {
    $("form-health-type").value = "http";
    $("form-health-endpoint").value =
      `http://127.0.0.1:${template.port}${template.healthPath}`;
  } else {
    $("form-health-type").value = "none";
    $("form-health-endpoint").value = "";
  }
  $("template-hint").textContent = template.requires
    ? `${template.description} · 需要本机已安装 ${template.requires}`
    : template.description;
  updateFormVisibility();
}

async function openProjectForm() {
  resetServiceForm();
  state.formServiceId = null;
  $("config-title").textContent = "新增项目服务";
  $("form-category").value = "project";
  $("form-group").value = "项目服务";
  $("template-field").classList.remove("hidden");
  const templates = await loadProjectTemplates();
  const select = $("form-template");
  select.innerHTML = templates
    .map(
      (template) =>
        `<option value="${escapeHtml(template.id)}">${escapeHtml(templateLabel(template))}</option>`,
    )
    .join("");
  if (templates[0]) applyProjectTemplate(templates[0].id);
  updateFormVisibility();
  $("config-drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");
  $("form-template").focus();
}

function closeServiceForm() {
  state.formServiceId = null;
  $("config-drawer").classList.add("hidden");
  $("drawer-backdrop").classList.add("hidden");
}

function collectServiceForm() {
  const id = $("form-id").value.trim();
  const name = $("form-name").value.trim();
  const adapter = $("form-adapter").value;
  if (!id) throw new Error("服务 ID 不能为空");
  if (!name) throw new Error("服务名称不能为空");
  const target = $("form-target").value.trim();
  if (!target && adapter !== "cloudflared") throw new Error("目标不能为空");

  const service = {
    id,
    name,
    kind: $("form-kind").value,
    adapter,
    target: target || "cloudflared",
    allowedActions: [
      ...document.querySelectorAll("#config-form .check-row input:checked"),
    ].map((input) => input.value),
  };
  if (!service.allowedActions.length) throw new Error("至少选择一个允许动作");

  const optional = {
    group: $("form-group").value,
    category: $("form-category").value,
    description: $("form-description").value,
    logFile: $("form-log-file").value,
  };
  for (const [key, value] of Object.entries(optional))
    if (String(value).trim()) service[key] = String(value).trim();

  if (adapter === "cloudflared") {
    service.kind = "tunnel";
    service.tunnelMode = $("form-tunnel-mode").value;
    if ($("form-tunnel-name").value.trim())
      service.tunnelName = $("form-tunnel-name").value.trim();
    if ($("form-tunnel-config").value.trim())
      service.tunnelConfig = $("form-tunnel-config").value.trim();
    if ($("form-token-env").value.trim())
      service.tokenEnv = $("form-token-env").value.trim();
    if ($("form-public-url").value.trim())
      service.publicUrl = $("form-public-url").value.trim();
    const port = Number($("form-port").value);
    if (service.tunnelMode === "quick" && !Number.isInteger(port) && target)
      if (!/^https?:\/\//.test(target))
        throw new Error("quick 模式需要端口，或 target 使用 http(s) URL");
    if (service.tunnelMode === "config" && !service.tunnelConfig)
      throw new Error("config 模式需要填写配置文件路径");
  }

  const existing = state.formServiceId
    ? state.services.find((item) => item.id === state.formServiceId)
    : undefined;
  if (existing?.tailscaleServePort)
    service.tailscaleServePort = existing.tailscaleServePort;
  if (existing?.persisted) {
    service.adapter = "launchd";
    service.target = existing.target;
    service.plistFile = existing.plistFile;
    service.persisted = true;
    service.persistenceLabel = existing.persistenceLabel;
    service.autostart = existing.autostart;
    service.command = existing.command;
    service.args = existing.args;
    service.cwd = existing.cwd;
    service.env = existing.env;
    service.pidFile = existing.pidFile;
    service.allowedActions = service.allowedActions.filter(
      (action) => action !== "pause" && action !== "resume",
    );
  }
  if (adapter === "process") {
    service.command = $("form-command").value.trim();
    if (!service.command) throw new Error("process 服务需要命令");
    const args = $("form-args")
      .value.split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (args.length) service.args = args;
    if ($("form-cwd").value.trim()) service.cwd = $("form-cwd").value.trim();
    if ($("form-pid-file").value.trim())
      service.pidFile = $("form-pid-file").value.trim();
    const envLines = $("form-env")
      .value.split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (envLines.length) {
      service.env = {};
      for (const line of envLines) {
        const separator = line.indexOf("=");
        if (separator <= 0) throw new Error(`环境变量格式错误：${line}`);
        service.env[line.slice(0, separator)] = line.slice(separator + 1);
      }
    }
  }
  if (adapter === "launchd" && $("form-plist-file").value.trim())
    service.plistFile = $("form-plist-file").value.trim();
  if (adapter === "docker-compose") {
    service.composeFile = $("form-compose-file").value.trim();
    if (!service.composeFile) throw new Error("Compose 服务需要 composeFile");
    if ($("form-project-name").value.trim())
      service.projectName = $("form-project-name").value.trim();
  }
  if ($("form-port").value.trim()) {
    const port = Number($("form-port").value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("端口必须是 1-65535 的整数");
    service.port = port;
  }
  if (service.args && service.args.length)
    service.args = service.args.map((arg) =>
      arg.replaceAll("{port}", String(service.port ?? "")),
    );
  const healthType = $("form-health-type").value;
  if (healthType !== "none") {
    service.health = { type: healthType };
    const endpoint = $("form-health-endpoint").value.trim();
    if (["http", "tcp"].includes(healthType) && !endpoint)
      throw new Error("HTTP/TCP 健康检查需要端点");
    if (endpoint) service.health.endpoint = endpoint;
  }
  return service;
}

const runtimeFieldLabels = {
  adapter: "适配器",
  target: "目标",
  command: "命令",
  args: "参数",
  cwd: "工作目录",
  env: "环境变量",
  port: "端口",
  pidFile: "PID 文件",
  plistFile: "plist 文件",
  composeFile: "Compose 文件",
  projectName: "项目名",
};

async function offerRestart(serviceId, result) {
  const fields = (result.changedFields ?? [])
    .map((field) => runtimeFieldLabels[field] ?? field)
    .join("、");
  const persisted = Boolean(result.persisted);
  const action = persisted ? "更新常驻配置并重启" : "重启服务";
  if (
    !confirm(
      `配置已保存。${fields || "运行参数"}已修改，需要${action}后生效。\n现在执行吗？`,
    )
  ) {
    toast(
      persisted
        ? "配置已保存；点“更新常驻”后生效"
        : "配置已保存；重启服务后生效",
    );
    return;
  }
  try {
    await api(
      persisted
        ? `/api/projects/${encodeURIComponent(serviceId)}/persist`
        : `/api/services/${encodeURIComponent(serviceId)}/restart`,
      {
        method: "POST",
        headers: { "x-studioops-actor": "web" },
      },
    );
    toast(persisted ? "常驻配置已更新并重启" : "服务已重启");
    await refreshAll({ quiet: true });
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveServiceForm() {
  const button = $("config-save");
  button.disabled = true;
  setFormError("");
  try {
    const service = collectServiceForm();
    const editing = state.formServiceId;
    const result = await api(
      editing
        ? `/api/config/services/${encodeURIComponent(editing)}`
        : "/api/config/services",
      {
        method: editing ? "PUT" : "POST",
        headers: {
          "content-type": "application/json",
          "x-studioops-actor": "web",
        },
        body: JSON.stringify(service),
      },
    );
    closeServiceForm();
    toast(editing ? "服务配置已更新" : "服务已添加");
    const targetId = editing ?? service.id;
    delete state.inlineLogs[targetId];
    delete state.ollamaModels[targetId];
    await refreshAll({ quiet: true });
    if (state.expandedServiceId === targetId) {
      loadInlineLog(targetId);
      const current = state.services.find((item) => item.id === targetId);
      if (current?.kind === "ollama") loadInlineModels(targetId);
    }
    if (state.view === "settings") loadBackups();
    if (result?.restartRequired) await offerRestart(targetId, result);
  } catch (error) {
    setFormError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteService() {
  const id = state.formServiceId;
  if (!id) return;
  if (!confirm(`删除服务 ${id}？此操作会立即写入配置。`)) return;
  const button = $("config-delete");
  button.disabled = true;
  try {
    const result = await api(`/api/config/services/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-studioops-actor": "web" },
    });
    closeServiceForm();
    toast(
      result.tailscaleCleanupError
        ? `已删除 ${id}；Tailnet 入口未清理：${result.tailscaleCleanupError}`
        : `已删除服务 ${id}`,
      Boolean(result.tailscaleCleanupError),
    );
    await refreshAll({ quiet: true });
  } catch (error) {
    setFormError(error.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- config backups ---------- */

async function loadBackups() {
  const list = $("backup-list");
  if (!list) return;
  try {
    const backups = await api("/api/config/backups");
    list.innerHTML = backups.length
      ? backups
          .slice(0, 8)
          .map(
            (backup) => `
            <div class="backup-item">
              <span title="${escapeHtml(backup.name)}">${escapeHtml(fmtDateTime(backup.createdAt))}</span>
              <small>${escapeHtml(fmtBytes(backup.sizeBytes))}</small>
              <button class="link" data-restore-backup="${escapeHtml(backup.name)}">恢复</button>
            </div>`,
          )
          .join("")
      : '<p class="backup-empty">暂无备份</p>';
  } catch (error) {
    list.innerHTML = `<p class="backup-empty">${escapeHtml(error.message)}</p>`;
  }
}

async function restoreBackup(name) {
  if (!confirm("恢复这个备份？当前配置会先自动备份。")) return;
  try {
    await api("/api/config/restore", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
      body: JSON.stringify({ name }),
    });
    toast("配置已恢复并重新加载");
    await refreshAll({ quiet: true });
    await loadBackups();
  } catch (error) {
    toast(error.message, true);
    await refreshAll({ quiet: true });
  }
}

async function syncLocalAccessToken() {
  if (localStorage.getItem("studioops.token")) return;
  const remote = state.remoteAccess;
  if (!remote?.studioops?.tokenRequired) return;
  if (remote.studioops.tokenSource === "env") return;
  try {
    const result = await api("/api/security/token/value");
    localStorage.setItem("studioops.token", result.token);
    $("token-input").value = result.token;
    reconnectSocket();
  } catch {
    // Remote clients cannot read the local token; they must enter it manually.
  }
}

async function loadRemoteAccess() {
  try {
    state.remoteAccess = await api("/api/remote-access");
    await syncLocalAccessToken();
    renderRemoteAccess();
  } catch (error) {
    $("tailscale-state").textContent = error.message;
  }
}

function renderRemoteAccess() {
  const data = state.remoteAccess;
  if (!data) return;
  const tailscale = data.tailscale;
  const serve = data.serve;
  const stateText = !tailscale.installed
    ? "未安装"
    : tailscale.running
      ? `运行中${tailscale.version ? ` · v${tailscale.version}` : ""}`
      : `未运行${tailscale.backendState ? ` · ${tailscale.backendState}` : ""}`;
  $("tailscale-state").textContent = stateText;
  $("tailscale-ip").textContent = tailscale.ips?.join("、") || "—";
  $("tailscale-dns").textContent = tailscale.dnsName || "—";
  $("tailscale-tailnet").textContent =
    [
      tailscale.tailnet,
      tailscale.magicDnsEnabled === false
        ? "MagicDNS 关闭"
        : tailscale.magicDnsEnabled
          ? "MagicDNS 已启用"
          : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "—";

  const toggle = $("tailscale-serve-toggle");
  if (serve.enabled) {
    $("tailscale-serve").textContent = serve.tailnetUrl ?? "已开启";
    toggle.textContent = "关闭 Tailnet 入口";
  } else {
    $("tailscale-serve").textContent = serve.error
      ? `未开启 · ${serve.error}`
      : "未开启";
    toggle.textContent = "仅 Tailnet 开放 StudioOps";
  }
  toggle.disabled = !tailscale.installed || !tailscale.running;

  const tokenButton = $("tailscale-token");
  tokenButton.textContent = data.studioops.tokenRequired
    ? "轮换访问 Token"
    : "生成访问 Token";
  tokenButton.classList.toggle("hidden", data.studioops.tokenSource === "env");
  $("tailscale-copy-token").disabled = !localStorage.getItem("studioops.token");

  const hint = $("tailscale-hint");
  if (!tailscale.installed) {
    hint.textContent = `Tailscale 未安装。先安装并登录：${data.downloadUrl}`;
  } else if (!tailscale.running) {
    hint.textContent = `Tailscale 已安装，但当前未登录或未运行${
      tailscale.backendState ? `（${tailscale.backendState}）` : ""
    }。打开 Tailscale 登录后点“重新检查”。`;
  } else if (serve.enabled) {
    hint.textContent = `管理入口只对 tailnet 可见：${serve.tailnetUrl ?? "已开启"}。远程设备首次访问时，在“设置 → 访问 Token”粘贴 Token。`;
  } else if (data.studioops.tokenRequired) {
    hint.textContent =
      "点击“仅 Tailnet 开放 StudioOps”会通过 Tailscale Serve 暴露本机 7227；不会启用 Funnel，公网无法直接访问。";
  } else {
    hint.textContent =
      "开放前会先自动生成访问 Token，再启用 Tailscale Serve；Tailscale 仍需安装并登录。";
  }
  if (data.studioops.tokenSource === "env" && tailscale.running) {
    hint.textContent += " 访问 Token 当前由 STUDIOOPS_TOKEN 管理。";
  }
}

function showTailscaleResult(message) {
  const result = $("tailscale-result");
  result.textContent = message;
  result.classList.remove("hidden");
}

async function generateAccessToken({ confirmRotation = true } = {}) {
  const current = state.remoteAccess;
  if (current?.studioops?.tokenSource === "env") {
    toast("Token 由 STUDIOOPS_TOKEN 管理，不能在 App 内生成", true);
    return false;
  }
  if (
    confirmRotation &&
    current?.studioops?.tokenRequired &&
    !confirm(
      "生成新 Token 会让其他设备当前的 Token 立即失效，需要重新输入。继续？",
    )
  )
    return false;
  try {
    const result = await api("/api/security/token", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    localStorage.setItem("studioops.token", result.token);
    $("token-input").value = result.token;
    showTailscaleResult(
      "访问 Token 已生成并保存在当前浏览器。其他设备首次访问时，在“设置 → 访问 Token”粘贴同一个 Token。",
    );
    reconnectSocket();
    await refreshAll({ quiet: true });
    await loadRemoteAccess();
    loadSecurityAudit();
    toast("访问 Token 已生成");
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

async function copyAccessToken() {
  let token = localStorage.getItem("studioops.token");
  if (!token) {
    try {
      const result = await api("/api/security/token/value");
      token = result.token;
      localStorage.setItem("studioops.token", token);
      $("token-input").value = token;
      reconnectSocket();
    } catch (error) {
      toast(error.message, true);
      return;
    }
  }
  try {
    await navigator.clipboard.writeText(token);
    toast("Token 已复制");
  } catch {
    const input = $("token-input");
    input.type = "text";
    input.value = token;
    input.select();
    const copied = document.execCommand("copy");
    input.type = "password";
    toast(copied ? "Token 已复制" : "无法自动复制，请手动选择", !copied);
  }
}

async function toggleTailscaleServe(button) {
  let current = state.remoteAccess;
  if (!current) return;
  const enable = !current.serve.enabled;
  if (enable && !current.studioops.tokenRequired) {
    if (
      !confirm("远程访问需要先启用访问 Token。现在自动生成并保存到当前浏览器？")
    )
      return;
    const generated = await generateAccessToken({ confirmRotation: false });
    if (!generated) return;
    current = state.remoteAccess;
    if (!current) return;
  }
  if (
    !confirm(
      enable
        ? "通过 Tailscale Serve 把 StudioOps 管理面板开放给 tailnet？\n\n只有已登录同一 tailnet 的设备可访问；不会启用 Funnel。"
        : "关闭 Tailscale Serve 的 StudioOps 入口？本机仍可继续用 127.0.0.1:7227 访问。",
    )
  )
    return;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/remote-access/serve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studioops-actor": "web",
      },
      body: JSON.stringify({ enabled: enable }),
    });
    state.remoteAccess = {
      ...current,
      tailscale: result.tailscale,
      serve: result.serve,
    };
    renderRemoteAccess();
    loadSecurityAudit();
    showTailscaleResult(
      enable
        ? `已开放：${result.serve.tailnetUrl ?? "Tailscale Serve 入口"}（仅 tailnet）`
        : "Tailnet 管理入口已关闭，本机回环访问不受影响。",
    );
    toast(enable ? "已仅对 tailnet 开放 StudioOps" : "已关闭 Tailnet 入口");
  } catch (error) {
    toast(error.message, true);
    showTailscaleResult(error.message);
    await loadRemoteAccess();
  } finally {
    renderRemoteAccess();
  }
}

const securityLevelLabels = {
  ok: "正常",
  warning: "警告",
  critical: "高风险",
};

async function loadSecurityAudit() {
  try {
    state.securityAudit = await api("/api/security/audit");
    renderSecurityAudit();
  } catch (error) {
    const summary = $("security-summary");
    summary.textContent = error.message;
    summary.className = "security-summary critical";
  }
}

function renderSecurityAudit() {
  const audit = state.securityAudit;
  if (!audit) return;
  const summary = $("security-summary");
  summary.className = `security-summary ${audit.level}`;
  summary.textContent = `${securityLevelLabels[audit.level] ?? audit.level} · 严重 ${audit.counts.critical} · 警告 ${audit.counts.warning} · 正常 ${audit.counts.ok}`;
  $("security-findings").innerHTML = audit.findings
    .map(
      (finding) => `<div class="security-finding ${finding.level}">
        <span class="security-level">${escapeHtml(securityLevelLabels[finding.level] ?? finding.level)}</span>
        <div>
          <strong>${escapeHtml(finding.title)}</strong>
          <p>${escapeHtml(finding.detail)}</p>
        </div>
      </div>`,
    )
    .join("");
}

async function loadUninstallPreview() {
  try {
    const preview = await api("/api/uninstall/preview");
    state.uninstall = preview;
    const labels = preview.launchAgents.map((agent) => agent.label);
    $("uninstall-agents").textContent = labels.length
      ? `${labels.length} 个：${labels.join("、")}`
      : "无残留";
    const running = preview.managedServices.filter(
      (service) => service.state === "running" || service.state === "paused",
    );
    $("uninstall-services").textContent = preview.managedServices.length
      ? `${preview.managedServices.length} 个（运行中 ${running.length}）`
      : "无";
    $("uninstall-data-dir").textContent = preview.dataDir;
    $("uninstall-script").textContent =
      preview.uninstallScript ??
      "开发模式未安装脚本；使用仓库 scripts/uninstall-studioops.sh";
  } catch (error) {
    $("uninstall-agents").textContent = error.message;
  }
}

async function exportUninstallData(button) {
  if (button) button.disabled = true;
  try {
    const archive = await api("/api/uninstall/export", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    const result = $("uninstall-result");
    result.textContent = `已导出：${archive.path}（${fmtBytes(archive.sizeBytes)}）`;
    result.classList.remove("hidden");
    toast("配置与数据已导出到 Downloads");
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function quitStudioOpsDesktop() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return false;
  try {
    await invoke("quit_app");
    return true;
  } catch {
    return false;
  }
}

async function cleanupStudioOps(button) {
  const preview = state.uninstall ?? {};
  const agentCount = preview.launchAgents?.length ?? 0;
  const managed = preview.managedServices?.length ?? 0;
  if (
    !confirm(
      `停止由 StudioOps 管理的 ${managed} 个服务，并移除 ${agentCount} 个 com.studioops.* LaunchAgent？\n\n配置、SQLite、日志和备份会保留。StudioOps 随后退出；App 本体需要手动移到废纸篓。`,
    )
  )
    return;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/uninstall/cleanup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studioops-actor": "web",
      },
      body: JSON.stringify({ stopServices: true }),
    });
    const failures = [
      ...(result.launchAgentErrors ?? []),
      ...(result.tailscaleErrors ?? []),
      ...(result.failures ?? []),
    ];
    const output = $("uninstall-result");
    output.textContent = [
      `已移除 ${result.removedLaunchAgents.length} 个 LaunchAgent`,
      `清理 ${result.tailscaleRemoved?.length ?? 0} 个 Tailnet 入口`,
      `停止 ${result.stopped.length} 个托管服务`,
      result.configBackup
        ? `配置已自动备份：${result.configBackup.name}`
        : "配置未变更，无需备份",
      ...failures.map((failure) => `失败：${failure}`),
    ].join(" · ");
    output.classList.remove("hidden");
    await loadUninstallPreview();
    if (failures.length) {
      toast("部分清理失败，请查看设置页详情", true);
      return;
    }
    const quitting = await quitStudioOpsDesktop();
    if (!quitting)
      toast("清理完成；请从菜单栏退出 StudioOps，并将 App 移到废纸篓");
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function reloadConfig() {
  try {
    await api("/api/config/reload", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    toast("配置已重新加载");
    await refreshAll({ quiet: true });
  } catch (error) {
    toast(error.message, true);
    await refreshAll({ quiet: true });
  }
}

/* ---------- logs view ---------- */

function logSocketSend(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function unsubscribeLogs(serviceId = state.logServiceId) {
  if (serviceId) logSocketSend({ type: "log-unsubscribe", serviceId });
}

function subscribeLogs(serviceId = state.logServiceId) {
  if (!serviceId) return;
  const ok = logSocketSend({
    type: "log-subscribe",
    serviceId,
    tail: Number($("log-tail").value),
  });
  if (!ok) loadLogSnapshot(serviceId);
}

function renderLogMeta() {
  const lines = state.logLines.length;
  const query = state.logSearch.trim();
  const matching = query
    ? state.logLines.filter((line) =>
        line.toLowerCase().includes(query.toLowerCase()),
      ).length
    : lines;
  const parts = [
    state.logSource || "—",
    query ? `${matching} / ${lines} 行匹配` : `${lines} 行`,
    state.logAuto ? "实时" : "已暂停",
  ];
  if (state.logTruncated) parts.push("已截断");
  if (state.logError) parts.push(state.logError);
  $("log-meta").textContent = parts.join(" · ");
}

function highlightLogLine(line, query) {
  if (!query) return escapeHtml(line);
  const lower = line.toLowerCase();
  const needle = query.toLowerCase();
  let output = "";
  let cursor = 0;
  let index = lower.indexOf(needle);
  while (index >= 0) {
    output += escapeHtml(line.slice(cursor, index));
    output += `<mark>${escapeHtml(line.slice(index, index + needle.length))}</mark>`;
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  return output + escapeHtml(line.slice(cursor));
}

function renderLogOutput({ scroll = true } = {}) {
  const query = state.logSearch.trim();
  const lines = query
    ? state.logLines.filter((line) =>
        line.toLowerCase().includes(query.toLowerCase()),
      )
    : state.logLines;
  if (!lines.length) {
    $("log-output").innerHTML = state.logError
      ? `<span class="log-error">${escapeHtml(state.logError)}</span>`
      : `<span class="muted">${query ? "没有匹配的日志" : "暂无日志"}</span>`;
  } else {
    $("log-output").innerHTML = lines
      .map((line) => {
        const severity = /\b(error|failed|fatal|exception)\b/i.test(line)
          ? "log-error"
          : /\b(warn|warning)\b/i.test(line)
            ? "log-warn"
            : "";
        return `<span class="log-line ${severity}">${highlightLogLine(line, query)}</span>`;
      })
      .join("\n");
    if (scroll && state.logAuto)
      $("log-output").scrollTop = $("log-output").scrollHeight;
  }
  renderLogMeta();
}

function handleLogFrame(data) {
  if (!data || data.serviceId !== state.logServiceId) return;
  state.logSource = data.source || state.logSource;
  state.logError = data.error || "";
  state.logTruncated = Boolean(data.truncated);
  if (data.reset) state.logLines = [...(data.lines ?? [])];
  else state.logLines.push(...(data.lines ?? []));
  const maxLines = Math.max(Number($("log-tail").value) * 5, 2000);
  if (state.logLines.length > maxLines)
    state.logLines = state.logLines.slice(-maxLines);
  renderLogOutput();
}

async function loadLogSnapshot(serviceId) {
  try {
    const tail = Number($("log-tail").value);
    const log = await api(
      `/api/services/${encodeURIComponent(serviceId)}/logs?tail=${tail}`,
    );
    state.logLines = log.lines;
    state.logSource = log.source;
    state.logTruncated = Boolean(log.truncated);
    state.logError = "";
    renderLogOutput();
  } catch (error) {
    state.logError = error.message;
    state.logLines = [];
    renderLogOutput();
  }
}

async function loadLogs(serviceId = state.logServiceId) {
  if (!serviceId) return;
  if (state.logServiceId && state.logServiceId !== serviceId)
    unsubscribeLogs(state.logServiceId);
  state.logServiceId = serviceId;
  const service = state.services.find((item) => item.id === serviceId);
  const logTitle = service ? `${service.name} 日志` : serviceId;
  $("log-title").textContent = logTitle;
  const logPanel = $("log-title").closest(".panel");
  if (logPanel) logPanel.dataset.title = logTitle;
  document
    .querySelectorAll(".log-service-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.logService === serviceId),
    );
  state.logLines = [];
  state.logSource = "";
  state.logError = "";
  state.logTruncated = false;
  $("log-output").textContent = state.logAuto ? "连接实时日志…" : "加载中…";
  if (state.logAuto) subscribeLogs(serviceId);
  else await loadLogSnapshot(serviceId);
}

/* ---------- data loading ---------- */

async function refreshAll({ quiet = false } = {}) {
  const results = await Promise.allSettled([
    api("/api/system"),
    api("/api/services"),
    api("/api/events?limit=20"),
    api("/api/config"),
    api("/api/inference"),
  ]);
  const [system, services, events, config, inference] = results;
  if (system.status === "fulfilled") renderSystem(system.value);
  if (services.status === "fulfilled") {
    state.services = services.value;
    renderServices();
  }
  if (events.status === "fulfilled") {
    state.events = events.value;
    renderEvents();
  }
  if (config.status === "fulfilled") {
    state.config = config.value;
    renderSettingsFacts();
  }
  if (inference.status === "fulfilled") state.inference = inference.value;
  renderInference();
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    showError(failed.reason?.message ?? "无法读取 Agent 数据");
  } else {
    hideError();
    state.connected = true;
    $("connection-dot").className = "dot online";
    $("connection-text").textContent = "已连接";
    if (!quiet) toast("数据已刷新");
  }
}

function roleLabel(role) {
  return role === "ollama" ? "Ollama" : "ComfyUI";
}

function renderInference() {
  const snapshot = state.inference;
  if (!snapshot) return;
  const list = $("inference-list");
  if (!list) return;
  const totals = new Map();
  for (const processInfo of snapshot.processes)
    totals.set(
      processInfo.role,
      (totals.get(processInfo.role) ?? 0) + processInfo.memoryBytes,
    );
  const sumText = [...totals.entries()]
    .map(([role, bytes]) => `${roleLabel(role)} ${fmtBytes(bytes)}`)
    .join(" · ");
  $("inference-summary").textContent = snapshot.processes.length
    ? `${sumText} · 合计 ${fmtBytes(snapshot.totalMemoryBytes)}`
    : "未检测到 Ollama / ComfyUI 进程";

  const systemMemory = state.system?.memory;
  const systemUsedPercent = systemMemory
    ? ((systemMemory.usedBytes ??
        systemMemory.totalBytes - systemMemory.freeBytes) /
        systemMemory.totalBytes) *
      100
    : 0;
  const inferenceShare =
    (snapshot.totalMemoryBytes / snapshot.systemMemoryBytes) * 100;
  const pressure =
    systemUsedPercent >= 90 || inferenceShare >= 60
      ? "high"
      : systemUsedPercent >= 80 || inferenceShare >= 45
        ? "elevated"
        : "normal";
  const badge = $("inference-pressure");
  badge.className = `pressure-badge ${pressure}`;
  badge.textContent =
    pressure === "high"
      ? "内存紧张"
      : pressure === "elevated"
        ? "内存偏高"
        : "正常";

  if (!snapshot.processes.length) {
    list.innerHTML =
      '<p class="muted" style="padding: 8px 2px">Ollama 和 ComfyUI 当前没有运行。</p>';
    return;
  }

  list.innerHTML = snapshot.processes
    .map((processInfo) => {
      const action =
        processInfo.serviceRoot && processInfo.serviceId
          ? `<button data-inference-stop="${escapeHtml(processInfo.serviceId)}" data-inference-name="${escapeHtml(processInfo.name)}">停止服务</button>`
          : processInfo.killable
            ? `<button data-terminate-pid="${processInfo.pid}" data-terminate-name="${escapeHtml(processInfo.name)}">终止</button>`
            : `<span class="muted" title="${escapeHtml(processInfo.protectedReason ?? "")}">—</span>`;
      return `<div class="inference-row">
        ${processIconHtml(processInfo, processInfo.role === "comfyui" ? "C" : "O")}
        <div class="inference-main">
          <strong>${escapeHtml(processInfo.name)}</strong>
          <small>${escapeHtml(roleLabel(processInfo.role))} · PID ${processInfo.pid} · CPU ${fmtPercent(processInfo.cpuPercent)}</small>
        </div>
        <div class="inference-memory">
          <strong>${fmtBytes(processInfo.memoryBytes)}</strong>
          <small>${fmtPercent(processInfo.memoryPercent)} 内存</small>
        </div>
        <div class="inference-actions">${action}</div>
      </div>`;
    })
    .join("");
}

async function loadInference() {
  try {
    state.inference = await api("/api/inference");
    renderInference();
  } catch {
    // Keep the last snapshot on transient failures.
  }
}

async function stopInferenceService(serviceId, name) {
  if (!confirm(`停止推理服务 ${name}？`)) return;
  await performAction(serviceId, "stop");
  await loadInference();
}

async function loadProcesses() {
  try {
    const data = await api(
      `/api/processes?sort=${state.processSort}&limit=200`,
    );
    state.processes = data.processes;
    state.processTotal = data.total;
    renderProcesses();
  } catch {
    // The overview keeps the previous process list on transient failures.
  }
}

async function loadDocker() {
  try {
    state.docker = await api("/api/docker");
    renderDocker();
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------- actions ---------- */

async function terminatePid(pid, name) {
  if (!Number.isInteger(pid) || pid <= 1) {
    toast("无效的进程 ID", true);
    return;
  }
  if (
    !confirm(
      `终止进程 ${name}（PID ${pid}）？\n先发送 SIGTERM，给它正常退出的机会。`,
    )
  )
    return;
  try {
    let result = await api(`/api/processes/${pid}/terminate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studioops-actor": "web",
      },
      body: "{}",
    });
    if (!result.exited) {
      if (
        !confirm(
          `进程 ${name}（PID ${pid}）仍在运行。\n强制终止会发送 SIGKILL，未保存的数据可能丢失。继续？`,
        )
      ) {
        toast("已发送 SIGTERM，进程仍在运行");
        await loadProcesses();
        return;
      }
      result = await api(`/api/processes/${pid}/terminate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studioops-actor": "web",
        },
        body: JSON.stringify({ force: true }),
      });
    }
    toast(
      result.exited ? `${name} 已终止` : `${name} 未能终止`,
      !result.exited,
    );
    await refreshAll({ quiet: true });
    await loadProcesses();
    await loadInference();
    if (state.view === "projects") loadDiscovered();
    if (state.expandedServiceId) {
      loadInlineLog(state.expandedServiceId);
      const service = state.services.find(
        (item) => item.id === state.expandedServiceId,
      );
      if (service?.kind === "ollama") loadInlineModels(state.expandedServiceId);
    }
  } catch (error) {
    toast(error.message, true);
    await loadProcesses();
  }
}

async function performAction(serviceId, action, button) {
  if (button) button.disabled = true;
  try {
    await api(`/api/services/${encodeURIComponent(serviceId)}/${action}`, {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    const service = state.services.find((item) => item.id === serviceId);
    toast(
      `${service?.name ?? serviceId}：${actionLabels[action] ?? action}完成`,
    );
    if (state.expandedServiceId === serviceId) {
      delete state.inlineLogs[serviceId];
      if (service?.kind === "ollama") delete state.ollamaModels[serviceId];
    }
    await refreshAll({ quiet: true });
    if (state.expandedServiceId === serviceId) {
      loadInlineLog(serviceId);
      if (service?.kind === "ollama") loadInlineModels(serviceId);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function performContainerAction(id, action, button) {
  if (button) button.disabled = true;
  try {
    await api(`/api/docker/containers/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    toast(`容器 ${id}：${actionLabels[action] ?? action}完成`);
    await loadDocker();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- views ---------- */

function switchView(view, { updateHash = true } = {}) {
  if (!viewMeta[view]) view = "overview";
  const previousView = state.view;
  if (previousView === "logs" && view !== "logs") unsubscribeLogs();
  state.view = view;
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.view === view),
    );
  document
    .querySelectorAll("[data-view-panel]")
    .forEach((panel) =>
      panel.classList.toggle("hidden", panel.dataset.viewPanel !== view),
    );
  const meta = viewMeta[view];
  $("page-title").textContent = meta.title;
  document.title = `StudioOps · ${meta.title}`;
  if (view !== "services") state.expandedServiceId = null;
  closeServiceForm();
  if (view === "services") renderServices();
  if (updateHash) {
    const hash = view === "overview" ? "" : `#${view}`;
    history.replaceState(null, "", `${location.pathname}${hash}`);
  }

  if (view === "projects") {
    renderProjects();
    loadDiscovered();
    loadProjectTailnet();
  }
  if (view === "processes") loadProcesses();
  if (view === "containers") loadDocker();
  if (view === "history") loadHistory();
  if (view === "network") loadNetwork();
  if (view === "settings") {
    renderSettingsFacts();
    loadTokenField();
    loadBackups();
    loadMetricsSettings();
    loadLaunchdAgents();
    loadAlertsStatus({ populateSettings: true });
    loadRemoteAccess();
    loadSecurityAudit();
    loadUninstallPreview();
  }
  if (view === "logs") {
    if (!state.logServiceId && state.services[0])
      state.logServiceId = state.services[0].id;
    if (state.logServiceId) loadLogs();
    else $("log-output").textContent = "还没有可查看日志的服务。";
  }
}

/* ---------- connection ---------- */

let socket;
let reconnectTimer;

function connect() {
  const socketUrl = new URL(agentOrigin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.pathname = "/ws";
  const token = localStorage.getItem("studioops.token");
  if (token) socketUrl.searchParams.set("token", token);
  const activeSocket = new WebSocket(socketUrl.toString());
  socket = activeSocket;
  activeSocket.addEventListener("open", () => {
    state.connected = true;
    $("connection-dot").className = "dot online";
    $("connection-text").textContent = "已连接";
    if ($("status-state")) $("status-state").textContent = "live";
    hideError();
    activeSocket.send(
      JSON.stringify({
        type: "subscribe",
        topics: ["system", "services", "events"],
      }),
    );
    if (state.view === "logs" && state.logAuto && state.logServiceId)
      activeSocket.send(
        JSON.stringify({
          type: "log-subscribe",
          serviceId: state.logServiceId,
          tail: Number($("log-tail").value),
        }),
      );
  });
  activeSocket.addEventListener("close", () => {
    if (socket !== activeSocket) return;
    state.connected = false;
    $("connection-dot").className = "dot offline";
    $("connection-text").textContent = "连接断开，重试中…";
    if ($("status-state")) $("status-state").textContent = "reconnecting";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  });
  activeSocket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.topic === "system") renderSystem(message.data);
      if (message.topic === "services") {
        state.services = message.data;
        renderServices();
      }
      if (message.topic === "events") refreshEvents();
      if (message.topic === "logs") handleLogFrame(message.data);
    } catch {
      // Ignore malformed frames.
    }
  });
}

function reconnectSocket() {
  clearTimeout(reconnectTimer);
  if (socket) {
    const previous = socket;
    socket = null;
    previous.close();
  }
  connect();
}

async function refreshEvents() {
  try {
    state.events = await api("/api/events?limit=20");
    renderEvents();
  } catch {
    // Keep the previous audit rows.
  }
}

/* ---------- feedback ---------- */

let toastTimer;
function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add("hidden"), 3600);
}

function showError(message) {
  $("error-banner-text").textContent = message;
  $("error-banner").classList.remove("hidden");
  $("connection-dot").className = "dot offline";
  $("connection-text").textContent = "未连接";
}

function hideError() {
  $("error-banner").classList.add("hidden");
}

/* ---------- events ---------- */

// Replace a failed app icon request with the same monogram used for processes
// that have no macOS app bundle.
document.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (
      target instanceof HTMLImageElement &&
      target.classList.contains("process-icon") &&
      target.dataset.fallback
    ) {
      const fallback = document.createElement("span");
      fallback.className = "process-icon process-icon-fallback";
      fallback.textContent = target.dataset.fallback;
      target.replaceWith(fallback);
    }
  },
  true,
);

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-service]");
  if (!target) return;

  if (target.dataset.view) {
    switchView(target.dataset.view);
    return;
  }
  if (target.id === "refresh") {
    refreshAll();
    loadProcesses();
    if (state.view === "containers") loadDocker();
    return;
  }
  if (target.id === "error-retry") {
    refreshAll();
    return;
  }
  if (target.id === "drawer-backdrop") {
    closeServiceForm();
    return;
  }
  if (target.id === "add-service") {
    openServiceForm();
    return;
  }
  if (target.id === "add-project" || target.id === "add-project-empty") {
    openProjectForm();
    return;
  }
  if (target.id === "discovered-refresh") {
    loadDiscovered();
    return;
  }
  if (target.dataset.tailnetProject) {
    changeProjectTailnet(
      target.dataset.tailnetProject,
      target.dataset.tailnetEnabled === "true",
      target,
    );
    return;
  }
  if (target.dataset.autostartProject) {
    changeProjectAutostart(
      target.dataset.autostartProject,
      target.dataset.autostartEnabled === "true",
      target,
    );
    return;
  }
  if (target.dataset.persistProject) {
    changeProjectPersistence(target.dataset.persistProject, true, target);
    return;
  }
  if (target.dataset.unpersistProject) {
    changeProjectPersistence(target.dataset.unpersistProject, false, target);
    return;
  }
  if (target.dataset.adoptDiscovered) {
    const processInfo = state.discovered?.processes.find(
      (item) => item.pid === Number(target.dataset.adoptDiscovered),
    );
    if (processInfo) adoptDiscovered(processInfo);
    return;
  }
  if (target.id === "config-close" || target.id === "config-cancel") {
    closeServiceForm();
    return;
  }
  if (target.id === "config-save") {
    saveServiceForm();
    return;
  }
  if (target.id === "config-delete") {
    deleteService();
    return;
  }
  if (target.id === "backup-refresh") {
    loadBackups();
    return;
  }
  if (target.dataset.historyRange) {
    setHistoryRange(target.dataset.historyRange);
    return;
  }
  if (target.id === "history-refresh") {
    loadHistory();
    return;
  }
  if (target.id === "launchd-scan") {
    loadLaunchdAgents();
    return;
  }
  if (target.dataset.launchdImport) {
    const agent = state.launchdAgents?.find(
      (item) => item.label === target.dataset.launchdImport,
    );
    openLaunchdImport(agent);
    return;
  }
  if (target.id === "alerts-save") {
    saveAlertSettings();
    return;
  }
  if (target.id === "alerts-test") {
    testAlertNotification();
    return;
  }
  if (target.id === "alerts-refresh") {
    loadAlertsStatus({ populateSettings: true });
    return;
  }
  if (target.id === "metrics-save") {
    saveMetricsSettings();
    return;
  }
  if (target.id === "metrics-reload") {
    loadMetricsSettings();
    return;
  }
  if (target.dataset.networkDirection) {
    const direction = target.dataset.networkDirection;
    if (!["inbound", "outbound", "all"].includes(direction)) return;
    state.networkDirection = direction;
    document
      .querySelectorAll("[data-network-direction]")
      .forEach((button) =>
        button.classList.toggle(
          "active",
          button.dataset.networkDirection === direction,
        ),
      );
    renderNetwork();
    return;
  }
  if (target.id === "network-refresh") {
    loadNetwork({ refresh: true });
    return;
  }
  if (target.id === "security-refresh") {
    loadSecurityAudit();
    return;
  }
  if (target.id === "tailscale-refresh") {
    loadRemoteAccess();
    return;
  }
  if (target.id === "tailscale-token") {
    generateAccessToken();
    return;
  }
  if (target.id === "tailscale-copy-token") {
    copyAccessToken();
    return;
  }
  if (target.id === "tailscale-serve-toggle") {
    toggleTailscaleServe(target);
    return;
  }
  if (target.id === "uninstall-refresh") {
    loadUninstallPreview();
    return;
  }
  if (target.id === "uninstall-export") {
    exportUninstallData(target);
    return;
  }
  if (target.id === "uninstall-cleanup") {
    cleanupStudioOps(target);
    return;
  }
  if (target.id === "reload-config") {
    reloadConfig();
    return;
  }
  if (target.dataset.editService) {
    const service = state.services.find(
      (item) => item.id === target.dataset.editService,
    );
    if (service) openServiceForm(service);
    return;
  }
  if (target.dataset.inlineComfy) {
    loadInlineComfy(target.dataset.inlineComfy);
    return;
  }
  if (target.dataset.cancelComfy) {
    cancelComfyTask(
      target.dataset.cancelComfy,
      target.dataset.promptId,
      target.dataset.running === "true",
    );
    return;
  }
  if (target.dataset.loadModel) {
    changeOllamaModel(
      target.dataset.loadModel,
      target.dataset.modelName,
      "load",
      target,
    );
    return;
  }
  if (target.dataset.unloadModel) {
    changeOllamaModel(
      target.dataset.unloadModel,
      target.dataset.modelName,
      "unload",
      target,
    );
    return;
  }
  if (target.dataset.inlineModels) {
    loadInlineModels(target.dataset.inlineModels);
    return;
  }
  if (target.dataset.inlineLog) {
    loadInlineLog(target.dataset.inlineLog);
    return;
  }
  if (target.dataset.inferenceStop) {
    stopInferenceService(
      target.dataset.inferenceStop,
      target.dataset.inferenceName ?? "推理服务",
    );
    return;
  }
  if (target.dataset.terminatePid) {
    terminatePid(
      Number(target.dataset.terminatePid),
      target.dataset.terminateName ?? "进程",
    );
    return;
  }
  if (target.dataset.restoreBackup) {
    restoreBackup(target.dataset.restoreBackup);
    return;
  }
  if (target.id === "log-clear") {
    state.logLines = [];
    state.logError = "";
    renderLogOutput({ scroll: false });
    return;
  }
  if (target.id === "log-refresh") {
    loadLogs();
    return;
  }
  if (target.id === "docker-refresh") {
    loadDocker();
    return;
  }
  if (target.id === "backup-config") {
    backupConfig();
    return;
  }
  if (target.id === "token-save") {
    const value = $("token-input").value.trim();
    if (value) localStorage.setItem("studioops.token", value);
    else localStorage.removeItem("studioops.token");
    toast(value ? "Token 已保存，正在重新连接" : "Token 已清除");
    reconnectSocket();
    refreshAll({ quiet: true });
    return;
  }
  if (target.id === "token-clear") {
    localStorage.removeItem("studioops.token");
    $("token-input").value = "";
    toast("Token 已清除");
    reconnectSocket();
    refreshAll({ quiet: true });
    return;
  }
  if (target.dataset.logService) {
    if (state.view !== "logs") {
      state.logServiceId = target.dataset.logService;
      switchView("logs");
    } else {
      loadLogs(target.dataset.logService);
    }
    return;
  }
  if (target.dataset.action && target.dataset.serviceId) {
    performAction(target.dataset.serviceId, target.dataset.action, target);
    return;
  }
  if (target.dataset.containerAction && target.dataset.containerId) {
    performContainerAction(
      target.dataset.containerId,
      target.dataset.containerAction,
      target,
    );
    return;
  }
  if (target.dataset.service) {
    toggleServiceDetail(target.dataset.service);
  }
});

$("drawer-backdrop").addEventListener("click", closeServiceForm);

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const active = document.activeElement;
  const isTyping =
    active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);

  if (event.key === "Escape") {
    if (isTyping) active.blur();
    closeServiceForm();
    if (state.expandedServiceId) {
      state.expandedServiceId = null;
      renderServices();
    }
    return;
  }
  if (isTyping) return;

  const viewKeys = {
    1: "overview",
    2: "services",
    3: "projects",
    4: "processes",
    5: "containers",
    6: "logs",
    7: "history",
    8: "network",
    9: "settings",
  };
  if (viewKeys[event.key]) {
    switchView(viewKeys[event.key]);
    return;
  }
  if (event.key === "r") {
    refreshAll();
    loadProcesses();
    if (state.view === "containers") loadDocker();
    return;
  }
  if (event.key === "/") {
    const input = document.querySelector(
      `[data-view-panel="${state.view}"] input[type="search"]`,
    );
    if (input) {
      event.preventDefault();
      input.focus();
    } else {
      toast("当前视图没有搜索框");
    }
    return;
  }
  if (event.key === "?") {
    toast("1-9 切换视图 · r 刷新 · / 搜索 · Esc 关闭抽屉");
  }
});

$("service-search").addEventListener("input", (event) => {
  state.serviceSearch = event.target.value;
  renderServices();
});

$("service-filter").addEventListener("change", (event) => {
  state.serviceFilter = event.target.value;
  renderServices();
});

$("history-service").addEventListener("change", (event) => {
  state.historyServiceId = event.target.value;
  renderHistory();
});

$("project-search").addEventListener("input", (event) => {
  state.projectSearch = event.target.value;
  renderProjects();
});

$("process-search").addEventListener("input", (event) => {
  state.processSearch = event.target.value;
  renderProcesses();
});

$("process-sort").addEventListener("change", async (event) => {
  state.processSort = event.target.value;
  await loadProcesses();
});

$("log-tail").addEventListener("change", () => loadLogs());

$("log-auto").addEventListener("change", (event) => {
  state.logAuto = event.target.checked;
  if (!state.logAuto) {
    unsubscribeLogs();
    renderLogMeta();
  } else if (state.view === "logs") loadLogs();
});

$("log-search").addEventListener("input", (event) => {
  state.logSearch = event.target.value;
  renderLogOutput({ scroll: false });
});

$("form-adapter").addEventListener("change", () => {
  if ($("form-adapter").value === "cloudflared") {
    if ($("form-kind").value === "process") $("form-kind").value = "tunnel";
    if (!$("form-group").value.trim()) $("form-group").value = "网络";
    if (!$("form-category").value) $("form-category").value = "network";
    if (!$("form-target").value.trim()) $("form-target").value = "quick";
    if (!$("form-log-file").value.trim() && state.config?.dataDir) {
      const id = $("form-id").value.trim() || "tunnel";
      $("form-log-file").value = `${state.config.dataDir}/logs/${id}.log`;
    }
  }
  updateFormVisibility();
});
$("form-kind").addEventListener("change", () => {
  if (
    $("form-kind").value === "tunnel" &&
    $("form-adapter").value !== "cloudflared"
  ) {
    $("form-adapter").value = "cloudflared";
    if (!$("form-target").value.trim()) $("form-target").value = "quick";
  }
  updateFormVisibility();
});

$("form-template").addEventListener("change", (event) => {
  applyProjectTemplate(event.target.value);
});

$("form-cwd").addEventListener("input", (event) => {
  const value = event.target.value.trim();
  if (!value) return;
  const base = value.split("/").filter(Boolean).at(-1) ?? "project";
  if (!$("form-target").value.trim()) $("form-target").value = value;
  if (!$("form-name").value.trim()) $("form-name").value = base;
  if (!$("form-id").value.trim()) {
    const id = base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    $("form-id").value = id || `project-${$("form-port").value || "app"}`;
  }
  if (!$("form-log-file").value.trim() && state.config?.dataDir) {
    const id = $("form-id").value.trim() || "project";
    $("form-log-file").value = `${state.config.dataDir}/logs/${id}.log`;
  }
});

$("form-port").addEventListener("input", () => {
  const port = Number($("form-port").value);
  if (!Number.isInteger(port) || $("form-health-type").value !== "http") return;
  try {
    const endpoint = new URL($("form-health-endpoint").value);
    if (["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
      endpoint.port = String(port);
      $("form-health-endpoint").value = endpoint.toString();
    }
  } catch {
    // Leave non-URL endpoints untouched.
  }
});

$("config-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveServiceForm();
});

async function backupConfig() {
  try {
    const result = await api("/api/config/backup", {
      method: "POST",
      headers: { "x-studioops-actor": "web" },
    });
    toast(`已创建备份 ${result.name}`);
    await loadBackups();
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------- bootstrap ---------- */

const initialView = location.hash.replace("#", "") || "overview";
decoratePanels();
$("status-agent").textContent = new URL(agentOrigin).host;
switchView(initialView, { updateHash: false });
refreshAll({ quiet: true }).catch(() => {});
loadProcesses();
connect();
setInterval(() => {
  if (!document.hidden) loadProcesses();
}, 4000);
setInterval(() => {
  if (!document.hidden) loadInference();
}, 5000);
setInterval(() => {
  if (!document.hidden && state.view === "projects") loadDiscovered();
}, 10000);
setInterval(() => {
  if (!document.hidden) refreshEvents();
}, 15000);
setInterval(() => {
  if (!document.hidden && state.view === "history")
    loadHistory({ quiet: true });
}, 10000);
setInterval(() => {
  if (!document.hidden && state.view === "network")
    loadNetwork({ quiet: true });
}, 5000);
