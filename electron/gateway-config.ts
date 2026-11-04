import { GatewayServer, validateGatewayPool, type GatewayForwarder, type GatewayPool } from "@omp-switch/core";
import type { MetadataStore } from "./metadata-store";

interface ActiveGateway {
  server: GatewayServer;
  profile: string;
  port: number;
  token: string;
}

interface GatewayRuntimeDependencies {
  loadToken: () => Promise<string>;
  resolveForwarder: (profileId: string) => Promise<GatewayForwarder>;
}

/** Save, start and stop share one queue so an awaited persistence cannot apply to a later lifecycle. */
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

  status(profileId?: string) {
    const active = this.active;
    return active?.server.running
      ? { running: true, profileId: active.profile, port: active.port, upstreams: active.server.getStats(), token: profileId === active.profile ? active.token : undefined }
      : { running: false, profileId: null, port: null, upstreams: [] };
  }

  start(store: MetadataStore, profileId: string): Promise<{ running: true; profileId: string; port: number; token: string }> {
    return this.runExclusive(async () => {
      const pools = store.listGatewayPools(profileId).filter((pool) => pool.enabled);
      if (!pools.length) throw new Error("No enabled gateway pools exist for this profile");
      const port = pools[0].port;
      const active = this.active;
      if (active && port !== active.port) throw new Error("Stop the gateway before changing its port");
      const token = await this.dependencies.loadToken();
      const resolved = await this.dependencies.resolveForwarder(profileId);
      const forwarder: GatewayForwarder = {
        ...resolved,
        onAttempt: (observation) => {
          resolved.onAttempt?.(observation);
          const write = store.recordGatewayProbe({
            profile: profileId,
            poolId: observation.poolId,
            upstreamId: observation.upstreamId,
            timestamp: new Date().toISOString(),
            ok: !observation.error && (observation.status === undefined || observation.status < 400),
            status: observation.status,
            latencyMs: observation.latencyMs,
            error: observation.error,
          }).catch(() => undefined);
          this.probeWrites.add(write);
          void write.then(() => { this.probeWrites.delete(write); });
        },
      };
      if (active) {
        await store.setPreference("gateway.port", port);
        active.server.setConfiguration(pools, forwarder, token);
        this.active = { ...active, profile: profileId, token };
        return { running: true, profileId, port, token };
      }
      const server = new GatewayServer(forwarder, pools, { token });
      let boundPort: number;
      try {
        boundPort = await server.start(port);
        await store.setPreference("gateway.port", boundPort);
      } catch (error) {
        if (server.running) await server.stop();
        await Promise.all(this.probeWrites);
        throw error;
      }
      this.active = { server, profile: profileId, port: boundPort, token };
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
