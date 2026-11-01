import os from "node:os";
import type { SystemSnapshot } from "../../../../packages/contracts/src/index.js";

export function getSystemSnapshot(): SystemSnapshot {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: os.uptime(),
    load: os.loadavg(),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    updatedAt: new Date().toISOString(),
  };
}
