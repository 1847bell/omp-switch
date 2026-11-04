import { GatewayServer, validateGatewayPool, validateGatewayPort, type GatewayForwarder, type GatewayListenerSettings, type GatewayPool } from "@omp-switch/core";
import type { MetadataStore } from "./metadata-store";

interface ActiveGateway {
  server: GatewayServer;
  profile: string;
  port: number;
  token: string;
  resolved: GatewayForwarder;
}

interface GatewayRuntimeDependencies {
  loadToken: () => Promise<string>;
  resolveForwarder: (profileId: string) => Promise<GatewayForwarder>;
}

/** Pool and listener changes share one queue so an awaited write cannot apply to a later lifecycle. */
export class GatewayConfigCoordinator {
  private pending: Promise<unknown> = Promise.resolve();
  private active: ActiveGateway | null = null;
  private readonly probeWrites = new Set<Promise<void>>();

  constructor(private readonly dependencies: GatewayRuntimeDependencies) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private createForwarder(store: MetadataStore, profileId: string, pools: GatewayPool[], resolved: GatewayForwarder): GatewayForwarder {
    const revisions = new Map<string, number>();
    for (const pool of pools) revisions.set(pool.id, store.getGatewayPoolRevision(profileId, pool.id));
    return {
      ...resolved,
      onAttempt: (observation) => {
        resolved.onAttempt?.(observation);
        const revision = revisions.get(observation.poolId);
        if (revision === undefined) return;
        const write = store.recordGatewayProbe({
          profile: profileId,
          poolId: observation.poolId,
          upstreamId: observation.upstreamId,
          timestamp: new Date().toISOString(),
          ok: !observation.error && (observation.status === undefined || observation.status < 400),
          status: observation.status,
          latencyMs: observation.latencyMs,
          error: observation.error,
        }, revision).catch(() => undefined);
        this.probeWrites.add(write);
        void write.then(() => { this.probeWrites.delete(write); });
      },
    };
  }

  private updatePools(store: MetadataStore, active: ActiveGateway): void {
    const pools = store.listGatewayPools(active.profile).filter((pool) => pool.enabled);
    active.server.setPools(pools, this.createForwarder(store, active.profile, pools, active.resolved));
  }

  status(profileId?: string) {
    const active = this.active;
    return active?.server.running
      ? { running: true, profileId: active.profile, port: active.port, upstreams: active.server.getStats(), token: profileId === active.profile ? active.token : undefined }
      : { running: false, profileId: null, port: null, upstreams: [] };
  }

  setPort(store: MetadataStore, profileId: string, port: number): Promise<GatewayListenerSettings> {
    return this.runExclusive(async () => {
      validateGatewayPort(port);
      const active = this.active;
      if (active?.server.running && active.profile === profileId && port !== active.port) {
        throw new Error("Stop the gateway before changing its port");
      }
      await store.setGatewayListenerPort(profileId, port);
      return store.getGatewayListenerSettings(profileId);
    });
  }

  start(store: MetadataStore, profileId: string): Promise<{ running: true; profileId: string; port: number; token: string }> {
    return this.runExclusive(async () => {
      const pools = store.listGatewayPools(profileId).filter((pool) => pool.enabled);
      if (!pools.length) throw new Error("No enabled gateway pools exist for this profile");
      const settings = store.getGatewayListenerSettings(profileId);
      if (settings.port === null) {
        throw new Error(`Legacy gateway pool ports are inconsistent or invalid (${settings.conflictingPorts.join(", ")}). Choose and save one listener port for Profile ${profileId}`);
      }
      const port = settings.port;
      validateGatewayPort(port);
      const active = this.active;
      if (active && port !== active.port) throw new Error("Stop the gateway before changing its port");
      const token = await this.dependencies.loadToken();
      const resolved = await this.dependencies.resolveForwarder(profileId);
      const forwarder = this.createForwarder(store, profileId, pools, resolved);
      if (active) {
        active.server.setConfiguration(pools, forwarder, token);
        this.active = { ...active, profile: profileId, token, resolved };
        return { running: true, profileId, port, token };
      }
      const server = new GatewayServer(forwarder, pools, { token });
      let boundPort: number;
      try {
        boundPort = await server.start(port);
      } catch (error) {
        if (server.running) await server.stop();
        await Promise.all(this.probeWrites);
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw new Error(`Gateway port ${port} is already in use; choose another port or stop the other service`, { cause: error });
        }
        throw error;
      }
      this.active = { server, profile: profileId, port: boundPort, token, resolved };
      return { running: true, profileId, port: boundPort, token };
    });
  }

  stop(expectedProfileId: string): Promise<void> {
    return this.runExclusive(async () => {
      const active = this.active;
      if (!active) return;
      if (active.profile !== expectedProfileId) throw new Error("Gateway active profile changed; refusing stale stop");
      await active.server.stop();
      await Promise.all(this.probeWrites);
      this.active = null;
    });
  }

  save(store: MetadataStore, pool: GatewayPool): Promise<GatewayPool> {
    return this.runExclusive(async () => {
      validateGatewayPool(pool);
      const active = this.active;
      await store.saveGatewayPool(pool);
      if (active?.server.running && active.profile === pool.profile) {
        this.updatePools(store, active);
      }
      return pool;
    });
  }

  delete(store: MetadataStore, profileId: string, poolId: string): Promise<void> {
    return this.runExclusive(async () => {
      if (typeof profileId !== "string" || typeof poolId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(poolId)) {
        throw new Error("Invalid gateway pool identifier");
      }
      await store.deleteGatewayPool(profileId, poolId);
      const active = this.active;
      if (active?.server.running && active.profile === profileId) this.updatePools(store, active);
    });
  }
}
