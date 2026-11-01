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
  logAuto: false,
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
      return `<article class="project-card">
        <header class="project-card-head">
          <div class="project-title">
            <span class="state-dot ${escapeHtml(service.state)}"></span>
            <div>
              <strong>${escapeHtml(service.name)}</strong>
              <small>${escapeHtml(service.group ?? "项目服务")} · ${escapeHtml(service.kind)}</small>
            </div>
          </div>
          <span class="state-pill ${escapeHtml(service.state)}">${escapeHtml(stateLabels[service.state] ?? service.state)}</span>
        </header>
        <p class="project-target" title="${escapeHtml(service.target)}">${escapeHtml(service.description || service.target)}</p>
        <div class="project-facts">
          <div><span>端口</span><strong>${service.port ?? "—"}</strong></div>
          <div><span>PID</span><strong>${service.pid ?? "—"}</strong></div>
          <div><span>CPU</span><strong>${fmtPercent(service.cpuPercent)}</strong></div>
          <div><span>内存</span><strong>${fmtBytes(service.memoryBytes)}</strong></div>
        </div>
        <footer class="project-actions">
          <button class="btn btn-small" data-log-service="${escapeHtml(service.id)}">日志</button>
          <button class="btn btn-small" data-edit-service="${escapeHtml(service.id)}">编辑</button>
          ${actions}
        </footer>
      </article>`;
    })
    .join("");
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
          <td>${escapeHtml(event.actor ?? "local")}</td>
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
      ? "已启用 Bearer Token"
      : "未启用（仅本机回环）";
    $("settings-data-dir").textContent = config.dataDir ?? "—";
    $("settings-version").textContent = `v${config.version}`;
    if ($("brand-version"))
      $("brand-version").textContent = `v${config.version}`;
    const hint = $("token-hint");
    if (hint)
      hint.textContent = config.tokenRequired
        ? "已启用；HTTP 与 WebSocket 自动携带。"
        : "仅监听本机回环；远程绑定需设置 STUDIOOPS_TOKEN。";
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

function modelsToHtml(snapshot) {
  if (!snapshot.models.length)
    return '<p class="model-empty">没有已下载的模型</p>';
  return snapshot.models
    .map((model) => {
      const meta = [
        model.family,
        model.parameterSize,
        model.quantization,
        fmtBytes(model.sizeBytes),
      ]
        .filter(Boolean)
        .join(" · ");
      const expires =
        model.loaded && model.expiresAt
          ? ` · 到期 ${fmtClock(model.expiresAt)}`
          : "";
      return `<div class="model-row">
        <div>
          <strong title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</strong>
          <small>${escapeHtml(meta)}${escapeHtml(expires)}</small>
        </div>
        ${model.loaded ? '<span class="model-badge">loaded</span>' : ""}
      </div>`;
    })
    .join("");
}

function inlineDetailHtml(service) {
  const models = state.ollamaModels[service.id];
  const log = state.inlineLogs[service.id];
  const health = service.healthState ?? "unknown";
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
               ? modelsToHtml(models)
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
            <div class="inline-fact"><span>CPU</span><strong>${fmtPercent(service.cpuPercent)}</strong></div>
            <div class="inline-fact"><span>内存</span><strong>${fmtBytes(service.memoryBytes)}</strong></div>
            <div class="inline-fact"><span>适配器</span><strong>${escapeHtml(service.adapter)}</strong></div>
            <div class="inline-fact"><span>更新时间</span><strong>${escapeHtml(fmtClock(service.updatedAt))}</strong></div>
            <div class="inline-fact wide"><span>目标</span><strong>${escapeHtml(service.target)}</strong></div>
            <div class="inline-fact wide"><span>允许动作</span><strong>${escapeHtml(service.allowedActions.join(" · "))}</strong></div>
          </div>
          ${modelSection}
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
  loadInlineLog(serviceId);
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
    if (target) target.innerHTML = modelsToHtml(data);
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
    "form-health-endpoint",
  ])
    $(id).value = "";
  $("form-kind").value = "process";
  $("form-adapter").value = "process";
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

function openProjectForm() {
  resetServiceForm();
  state.formServiceId = null;
  $("config-title").textContent = "新增项目服务";
  $("form-category").value = "project";
  $("form-group").value = "项目服务";
  updateFormVisibility();
  $("config-drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");
  $("form-name").focus();
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
  if (!target) throw new Error("目标不能为空");

  const service = {
    id,
    name,
    kind: $("form-kind").value,
    adapter,
    target,
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

async function saveServiceForm() {
  const button = $("config-save");
  button.disabled = true;
  setFormError("");
  try {
    const service = collectServiceForm();
    const editing = state.formServiceId;
    await api(
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
    await api(`/api/config/services/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-studioops-actor": "web" },
    });
    closeServiceForm();
    toast(`已删除服务 ${id}`);
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

function renderLogMeta(log) {
  if (!log) return;
  const truncated = log.truncated ? " · 已截断" : "";
  $("log-meta").textContent =
    `${log.lines.length} 行 · ${log.source}${truncated} · ${fmtDateTime(log.fetchedAt)}`;
}

async function loadLogs(serviceId = state.logServiceId) {
  if (!serviceId) return;
  state.logServiceId = serviceId;
  const service = state.services.find((item) => item.id === serviceId);
  const logTitle = service ? `${service.name} 日志` : serviceId;
  $("log-title").textContent = logTitle;
  const logPanel = $("log-title").closest(".panel");
  if (logPanel) logPanel.dataset.title = logTitle;
  $("log-output").textContent = "加载中…";
  document
    .querySelectorAll(".log-service-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.logService === serviceId),
    );
  try {
    const tail = Number($("log-tail").value);
    const log = await api(
      `/api/services/${encodeURIComponent(serviceId)}/logs?tail=${tail}`,
    );
    state.logLines = log.lines;
    renderLogMeta(log);
    $("log-output").innerHTML = log.lines.length
      ? log.lines
          .map((line) => {
            const severity = /\b(error|failed|fatal|exception)\b/i.test(line)
              ? "log-error"
              : /\b(warn|warning)\b/i.test(line)
                ? "log-warn"
                : "";
            return `<span class="log-line ${severity}">${escapeHtml(line)}</span>`;
          })
          .join("\n")
      : '<span class="muted">暂无日志</span>';
    $("log-output").scrollTop = $("log-output").scrollHeight;
  } catch (error) {
    $("log-meta").textContent = "";
    $("log-output").textContent = error.message;
  }
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
  if (state.view === "logs" && state.logAuto && state.logServiceId)
    loadLogs().catch(() => {});
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

  if (view === "projects") renderProjects();
  if (view === "processes") loadProcesses();
  if (view === "containers") loadDocker();
  if (view === "settings") {
    renderSettingsFacts();
    loadTokenField();
    loadBackups();
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
    7: "settings",
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
    toast("1-6 切换视图 · r 刷新 · / 搜索 · Esc 关闭抽屉");
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
  if (state.logAuto) loadLogs();
});

$("form-adapter").addEventListener("change", updateFormVisibility);

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
  if (!document.hidden) refreshEvents();
}, 15000);
setInterval(() => {
  if (!document.hidden && state.logAuto && state.logServiceId) loadLogs();
}, 4000);
