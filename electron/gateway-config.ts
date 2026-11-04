import { validateGatewayPool, type GatewayPool, type GatewayServer } from "@omp-switch/core";
import type { MetadataStore } from "./metadata-store";

interface ActiveGateway {
  server: GatewayServer;
  profile: string;
  port: number;
}

/** Save, start and stop share one queue so an awaited persistence cannot apply to a later lifecycle. */
export class GatewayConfigCoordinator {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly activeGateway: () => ActiveGateway | null) {}

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  save(store: MetadataStore, pool: GatewayPool): Promise<GatewayPool> {
    return this.runExclusive(async () => {
      validateGatewayPool(pool);
      const active = this.activeGateway();
      if (active?.server.running && active.profile === pool.profile && pool.port !== active.port) {
        throw new Error("Stop the gateway before changing its port");
      }
      await store.saveGatewayPool(pool);
      if (active?.server.running && active.profile === pool.profile) {
        active.server.setPools(store.listGatewayPools(pool.profile).filter((candidate) => candidate.enabled));
      }
      return pool;
    });
  }
}
