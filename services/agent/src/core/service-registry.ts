import type {
  ServiceAction,
  ServiceDefinition,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";
import type { ServiceAdapter } from "../adapters/adapter.js";

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
    return this.getAdapter(definition).inspect(definition);
  }

  async execute(id: string, action: ServiceAction): Promise<ServiceSnapshot> {
    const definition = this.getDefinition(id);
    return this.getAdapter(definition).execute(definition, action);
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
