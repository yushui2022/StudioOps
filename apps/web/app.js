const $ = (id) => document.getElementById(id);
const api = async (path, options) => {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body.data;
};

const fmtUptime = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

function renderSystem(system) {
  $("hostname").textContent = system.hostname;
  $("platform").textContent = `${system.platform} · ${system.arch}`;
  $("uptime").textContent = fmtUptime(system.uptimeSeconds);
  $("load").textContent = system.load[0].toFixed(2);
  const used = 1 - system.memory.freeBytes / system.memory.totalBytes;
  $("memory").textContent = `${Math.round(used * 100)}%`;
}

function renderServices(services) {
  $("service-list").innerHTML = services
    .map(
      (service) => `
    <article class="service-row">
      <div><strong>${service.name}</strong><small>${service.kind} · ${service.description || service.target}</small></div>
      <span class="state state-${service.state}">${service.state}</span>
      <div class="actions">${service.allowedActions.map((action) => `<button data-service="${service.id}" data-action="${action}">${action}</button>`).join("")}</div>
    </article>
  `,
    )
    .join("");
  document.querySelectorAll("[data-action]").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(
          `/api/services/${button.dataset.service}/${button.dataset.action}`,
          { method: "POST" },
        );
        await refresh();
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    }),
  );
}

async function refresh() {
  renderSystem(await api("/api/system"));
  renderServices(await api("/api/services"));
}

function connect() {
  const socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
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
refresh().catch((error) => {
  $("service-list").innerHTML = `<p class="error">${error.message}</p>`;
});
connect();
