import type {
  ServiceAction,
  ServiceDefinition,
  ServiceSnapshot,
} from "../../../../packages/contracts/src/index.js";

export interface ServiceAdapter {
  readonly id: string;
  canHandle(definition: ServiceDefinition): boolean;
  inspect(definition: ServiceDefinition): Promise<ServiceSnapshot>;
  execute(
    definition: ServiceDefinition,
    action: ServiceAction,
  ): Promise<ServiceSnapshot>;
}
