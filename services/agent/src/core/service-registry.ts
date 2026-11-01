import type {
  ServiceAction,
  ServiceDefinition,
  ServiceLog,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "../adapters/adapter.js";
import { withHealth } from "./health.js";

export class ServiceRegistry {
  private readonly definitions = new Map<string, ServiceDefinition>();
  private readonly adapters = new Map<string, ServiceAdapter>();

  registerAdapter(adapter: ServiceAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  register(definition: ServiceDefinition): void {
    if (this.definitions.has(definition.id))
      throw new Error(`Duplicate service id: ${definition.id}`);
    if (!this.adapters.has(definition.adapter))
      throw new Error(`Unknown adapter: ${definition.adapter}`);
    this.definitions.set(definition.id, definition);
  }

  list(): Promise<ServiceSnapshot[]> {
    return Promise.all(
      [...this.definitions.values()].map((definition) =>
        this.inspect(definition.id),
      ),
    );
  }

  async inspect(id: string): Promise<ServiceSnapshot> {
    const definition = this.getDefinition(id);
    const snapshot = await this.getAdapter(definition).inspect(definition);
    return withHealth(definition, snapshot);
  }

  async execute(id: string, action: ServiceAction): Promise<ServiceSnapshot> {
    const definition = this.getDefinition(id);
    const snapshot = await this.getAdapter(definition).execute(
      definition,
      action,
    );
    return withHealth(definition, snapshot);
  }

  async logs(id: string, tail = 200): Promise<ServiceLog> {
    const definition = this.getDefinition(id);
    const adapter = this.getAdapter(definition);
    if (!adapter.logs)
      throw new Error(`Logs are not supported for ${definition.id}`);
    return adapter.logs(definition, Math.max(1, Math.min(tail, 1000)));
  }

  private getDefinition(id: string): ServiceDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown service: ${id}`);
    return definition;
  }

  private getAdapter(definition: ServiceDefinition): ServiceAdapter {
    const adapter = this.adapters.get(definition.adapter);
    if (!adapter) throw new Error(`Unknown adapter: ${definition.adapter}`);
    return adapter;
  }
}
