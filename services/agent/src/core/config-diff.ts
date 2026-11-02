import type { ServiceDefinition } from "../../../../packages/contracts/src/index.js";

const runtimeFields: Array<keyof ServiceDefinition> = [
  "adapter",
  "target",
  "command",
  "args",
  "cwd",
  "env",
  "port",
  "pidFile",
  "plistFile",
  "composeFile",
  "projectName",
];

export function changedRuntimeFields(
  previous: ServiceDefinition,
  next: ServiceDefinition,
): string[] {
  return runtimeFields.filter(
    (field) =>
      JSON.stringify(previous[field] ?? null) !==
      JSON.stringify(next[field] ?? null),
  );
}
