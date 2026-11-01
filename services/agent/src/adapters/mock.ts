import type {
  ServiceAction,
  ServiceDefinition,
  ServiceSnapshot,
  ServiceState,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "./adapter.js";

export class MockAdapter implements ServiceAdapter {
  readonly id = "mock";
  private readonly states = new Map<
    string,
    { state: ServiceState; updatedAt: string }
  >();

  canHandle(definition: ServiceDefinition): boolean {
    return definition.adapter === this.id;
  }

  async inspect(definition: ServiceDefinition): Promise<ServiceSnapshot> {
    const value = this.states.get(definition.id) ?? {
      state: "stopped" as const,
      updatedAt: new Date().toISOString(),
    };
    return { ...definition, ...value };
  }

  async execute(
    definition: ServiceDefinition,
    action: ServiceAction,
  ): Promise<ServiceSnapshot> {
    if (!definition.allowedActions.includes(action)) {
      throw new Error(`Action ${action} is not allowed for ${definition.id}`);
    }

    const nextState: ServiceState =
      action === "start" || action === "restart"
        ? "running"
        : action === "stop"
          ? "stopped"
          : action === "pause"
            ? "paused"
            : "running";
    const value = { state: nextState, updatedAt: new Date().toISOString() };
    this.states.set(definition.id, value);
    return { ...definition, ...value };
  }
}
