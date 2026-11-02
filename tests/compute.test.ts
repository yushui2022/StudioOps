import assert from "node:assert/strict";
import test from "node:test";
import {
  parseComputeProcesses,
  parseLastHistory,
  parseWho,
} from "../services/agent/src/core/compute.js";

test("parseWho keeps only the compute user sessions", () => {
  const raw = [
    "orlando console  Nov  2 18:43",
    "compute ttys000  Nov  2 18:55 (100.115.137.62)",
    "compute ttys001  Nov  2 19:01",
  ].join("\n");
  const sessions = parseWho(raw, "compute");
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.tty, "ttys000");
  assert.equal(sessions[0]?.from, "100.115.137.62");
  assert.equal(sessions[0]?.loginAt, "Nov 2 18:55");
  assert.equal(sessions[1]?.from, undefined);
});

test("parseLastHistory filters the account and skips wtmp footer", () => {
  const raw = [
    "compute  ttys000  100.115.137.62  Mon Nov  2 18:55   still logged in",
    "orlando  console                   Mon Nov  2 18:43   still logged in",
    "compute  ttys001  localhost        Sun Nov  1 21:00 - 21:30  (00:30)",
    "",
    "wtmp begins Mon Nov  2 12:00",
  ].join("\n");
  const history = parseLastHistory(raw, "compute");
  assert.equal(history.length, 2);
  assert.match(history[0] ?? "", /^compute\s+ttys000/);
  assert.match(history[1] ?? "", /^compute\s+ttys001/);
});

test("parseComputeProcesses reads fixed ps columns for the compute user", () => {
  const raw = [
    "compute 123 1 12.5 1.2 204800 01:23 python train.py",
    "orlando 124 1 50.0 2.0 409600 00:10 node app.js",
    "compute 125 123 0.0 0.1 1024 00:01 /usr/bin/yes",
  ].join("\n");
  const processes = parseComputeProcesses(raw, "compute");
  assert.equal(processes.length, 2);
  assert.equal(processes[0]?.pid, 123);
  assert.equal(processes[0]?.cpuPercent, 12.5);
  assert.equal(processes[0]?.memoryBytes, 204800 * 1024);
  assert.match(processes[0]?.command ?? "", /train\.py/);
  assert.equal(processes[1]?.pid, 125);
});
