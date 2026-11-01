import os from "node:os";
import {
  evaluateKillability,
  findProcess,
  listAncestorPids,
} from "./process-list.js";

export interface TerminateResult {
  pid: number;
  signal: "SIGTERM" | "SIGKILL";
  exited: boolean;
  command: string;
}

/**
 * Terminate one user-owned process. This intentionally has a narrower surface
 * than the POSIX kill command: no arbitrary signals, no system processes and no
 * other users' processes.
 */
export async function terminateProcess(
  pid: number,
  force = false,
): Promise<TerminateResult> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid process id");
  const processInfo = await findProcess(pid);
  if (!processInfo) throw new Error(`Process ${pid} is not running`);
  const protectedPids = await listAncestorPids(process.pid);
  const guard = evaluateKillability(
    processInfo,
    os.userInfo().username,
    protectedPids,
  );
  if (!guard.killable)
    throw new Error(
      `Refusing to terminate ${processInfo.command}: ${guard.protectedReason}`,
    );

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ESRCH")
      return {
        pid,
        signal,
        exited: true,
        command: processInfo.command,
      };
    throw error;
  }

  const deadline = Date.now() + (force ? 2000 : 3000);
  while (Date.now() < deadline) {
    await delay(100);
    if (!isAlive(pid))
      return {
        pid,
        signal,
        exited: true,
        command: processInfo.command,
      };
  }
  return {
    pid,
    signal,
    exited: !isAlive(pid),
    command: processInfo.command,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ESRCH") return false;
    // EPERM means the process exists but cannot be signalled.
    return code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
