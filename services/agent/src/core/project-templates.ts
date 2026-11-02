import type { ProjectTemplate } from "../../../../packages/contracts/src/index.js";

/**
 * Curated starting points for user projects. Templates only prefill the form;
 * every value remains editable before it is written to services.yaml.
 */
const templates: ProjectTemplate[] = [
  {
    id: "node-dev",
    name: "Node.js · npm run dev",
    description: "适合 Vite、Next、Nuxt 等 npm 项目",
    command: "npm",
    args: ["run", "dev"],
    port: 3000,
    healthPath: "/",
  },
  {
    id: "node-server",
    name: "Node.js · node server.js",
    description: "单文件或自定义 Node 服务",
    command: "node",
    args: ["server.js"],
    port: 3000,
    healthPath: "/",
  },
  {
    id: "vite",
    name: "Vite",
    description: "npm run dev，并固定监听 127.0.0.1 端口",
    command: "npm",
    args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "{port}"],
    port: 5173,
    healthPath: "/",
  },
  {
    id: "python-main",
    name: "Python · python3 main.py",
    description: "普通 Python HTTP/服务脚本",
    command: "python3",
    args: ["main.py"],
    port: 8000,
    healthPath: "/",
  },
  {
    id: "python-uvicorn",
    name: "Python · uvicorn",
    description: "FastAPI / ASGI 项目，例如 main:app",
    command: "uvicorn",
    args: ["main:app", "--host", "127.0.0.1", "--port", "{port}"],
    port: 8000,
    healthPath: "/",
    requires: "uvicorn",
  },
  {
    id: "pm2",
    name: "PM2 · pm2-runtime",
    description: "用 pm2-runtime 前台运行 ecosystem.config.js",
    command: "pm2-runtime",
    args: ["start", "ecosystem.config.js"],
    port: 3000,
    healthPath: "/",
    requires: "pm2",
  },
  {
    id: "static",
    name: "静态站点",
    description: "用 Python 内置 HTTP 服务托管当前目录",
    command: "python3",
    args: ["-m", "http.server", "{port}", "--bind", "127.0.0.1"],
    port: 8000,
    healthPath: "/",
  },
];

export function listProjectTemplates(): ProjectTemplate[] {
  return templates.map((template) => ({ ...template }));
}
