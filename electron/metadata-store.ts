import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  evaluateUpstreamHealth,
  DEFAULT_GATEWAY_PORT,
  validateGatewayPort,
  type GatewayListenerSettings,
  type GatewayPool,
  type GatewayProbeRecord,
  type GatewayUpstreamHealth,
  type SessionFileCache,
  type SessionSearchResult,
  type SessionSummary,
  type SessionUsageRecord,
  type Snapshot,
} from "@omp-switch/core";

interface MetadataState {
  version: 3;
  providerLabels: Record<string, string>;
  snapshots: Array<Record<string, unknown>>;
  gatewayPools: GatewayPool[];
  gatewayProbeHistory: Array<Omit<GatewayProbeRecord, "profile"> & { profile?: string }>;
  sessionCaches: SessionFileCache[];
  preferences: Record<string, unknown>;
}

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): void; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
};

export interface MetadataStoreOptions {
  backend?: "auto" | "json";
}

const SNAPSHOT_RETENTION = 30;
const PROBE_HISTORY_RETENTION = 50;

function emptyState(): MetadataState {
  return { version: 3, providerLabels: {}, snapshots: [], gatewayPools: [], gatewayProbeHistory: [], sessionCaches: [], preferences: {} };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asObject(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((item): item is [string, string] => typeof item[1] === "string"));
}

function migrateGatewayListeners(pools: GatewayPool[], preferences: Record<string, unknown>): boolean {
  const portsByProfile = new Map<string, unknown[]>();
  let changed = false;
  for (const pool of pools) {
    const ports = portsByProfile.get(pool.profile) ?? [];
    const legacy = pool as GatewayPool & { port?: unknown };
    if (Object.hasOwn(legacy, "port")) {
      ports.push(legacy.port);
      delete legacy.port;
      changed = true;
    }
    portsByProfile.set(pool.profile, ports);
  }
  for (const [profile, ports] of portsByProfile) {
    const key = `gateway.listener.${profile}`;
    if (Object.hasOwn(preferences, key)) continue;
    const numericPorts = [...new Set(ports.filter((port): port is number => typeof port === "number" && Number.isFinite(port)))].sort((a, b) => a - b);
    const allValid = ports.every((port) => typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535);
    const settings: GatewayListenerSettings = ports.length === 0
      ? { port: DEFAULT_GATEWAY_PORT, conflictingPorts: [] }
      : allValid && numericPorts.length === 1
        ? { port: numericPorts[0], conflictingPorts: [] }
        : { port: null, conflictingPorts: numericPorts };
    preferences[key] = settings;
    changed = true;
  }
  if (Object.hasOwn(preferences, "gateway.port")) {
    delete preferences["gateway.port"];
    changed = true;
  }
  return changed;
}

type LegacySessionCache = SessionFileCache & { messageOffsets?: unknown };

function stripLegacyCacheFields(cache: SessionFileCache): Omit<LegacySessionCache, "usage" | "messageOffsets"> & { usage: SessionUsageRecord[] } {
  const { messageOffsets: _messageOffsets, ...clean } = cache as LegacySessionCache;
  return clean;
}

function cachePayload(cache: SessionFileCache): Omit<SessionFileCache, "usage"> {
  const { usage: _usage, ...payload } = stripLegacyCacheFields(cache);
  return payload;
}

function cloneUsage(usage: SessionUsageRecord[]): SessionUsageRecord[] {
  return usage.map((item) => ({ ...item, tokens: { ...item.tokens } }));
}

function cloneCache(cache: SessionFileCache): SessionFileCache {
  const clean = stripLegacyCacheFields(cache);
  return {
    ...clean,
    summary: { ...clean.summary, tokens: { ...clean.summary.tokens } },
    usage: cloneUsage(clean.usage),
  };
}

function sortCaches(caches: SessionFileCache[]): SessionFileCache[] {
  return caches.sort((left, right) =>
    (right.summary.lastActiveAt ?? right.summary.startedAt ?? "").localeCompare(left.summary.lastActiveAt ?? left.summary.startedAt ?? ""));
}

export class MetadataStore {
  private readonly filePath: string;
  private readonly backend: "auto" | "json";
  private sqlite: SqliteDb | null = null;
  private fallback: MetadataState = emptyState();
  private hasFts = false;
  private fallbackWrites: Promise<void> = Promise.resolve();
  private readonly gatewayPoolRevisions = new Map<string, Map<string, number>>();

  constructor(userDataDir: string, options: MetadataStoreOptions = {}) {
    this.filePath = path.join(userDataDir, "metadata.sqlite");
    this.backend = options.backend ?? "auto";
  }

  get activeBackend(): "sqlite" | "json" {
    return this.sqlite ? "sqlite" : "json";
  }

  async init(): Promise<void> {
    if (this.sqlite) return;
    if (this.backend === "json") {
      await this.loadFallback();
      return;
    }
    let DatabaseSync: new (filePath: string) => SqliteDb;
    try {
      // node:sqlite is unavailable on older Electron/Node runtimes.
      DatabaseSync = (await import("node:sqlite")).DatabaseSync as unknown as typeof DatabaseSync;
    } catch {
      await this.loadFallback();
      return;
    }
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      this.sqlite = new DatabaseSync(this.filePath);
      this.sqlite.exec(
        "CREATE TABLE IF NOT EXISTS provider_meta (provider_id TEXT PRIMARY KEY, label TEXT NOT NULL);"
        + "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, profile TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);"
        + "CREATE TABLE IF NOT EXISTS gateway_pools (id TEXT NOT NULL, profile TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile, id));"
        + "CREATE TABLE IF NOT EXISTS gateway_probe_history (id TEXT PRIMARY KEY, profile TEXT, pool_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);"
        + "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, payload TEXT NOT NULL);"
        + "CREATE TABLE IF NOT EXISTS session_cache (id TEXT PRIMARY KEY, profile TEXT NOT NULL, relative_path TEXT NOT NULL, payload TEXT NOT NULL);"
        + "CREATE TABLE IF NOT EXISTS session_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, profile TEXT NOT NULL, payload TEXT NOT NULL);"
        + "DROP TABLE IF EXISTS session_index;",
      );
      this.migrateGatewayState();
      try {
        this.sqlite.exec("CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(session_id UNINDEXED, profile UNINDEXED, role, text);");
        this.hasFts = true;
      } catch {
        this.hasFts = false;
      }
      this.removeLegacySessionOffsets();
    } catch (error) {
      this.sqlite?.close();
      this.sqlite = null;
      throw error;
    }
  }

  close(): void {
    if (!this.sqlite) return;
    try {
      this.sqlite.close();
    } finally {
      this.sqlite = null;
    }
  }

  private migrateGatewayState(): void {
    if (!this.sqlite) return;
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      const poolColumns = db.prepare("PRAGMA table_info(gateway_pools)").all() as Array<{ name: string; pk: number }>;
      if (!poolColumns.some((column) => column.name === "profile" && column.pk > 0)) {
        db.exec(
          "CREATE TABLE gateway_pools_migrated (id TEXT NOT NULL, profile TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile, id));"
          + "INSERT INTO gateway_pools_migrated(id, profile, payload) SELECT id, profile, payload FROM gateway_pools;"
          + "DROP TABLE gateway_pools; ALTER TABLE gateway_pools_migrated RENAME TO gateway_pools;",
        );
      }
      const historyColumns = db.prepare("PRAGMA table_info(gateway_probe_history)").all() as Array<{ name: string }>;
      if (!historyColumns.some((column) => column.name === "profile")) {
        db.exec("ALTER TABLE gateway_probe_history ADD COLUMN profile TEXT");
      }
      const rows = db.prepare("SELECT id, pool_id, payload FROM gateway_probe_history WHERE profile IS NULL").all() as Array<{ id: string; pool_id: string; payload: string }>;
      const owners = db.prepare("SELECT DISTINCT profile FROM gateway_pools WHERE id = ?");
      const update = db.prepare("UPDATE gateway_probe_history SET profile = ?, payload = ? WHERE id = ?");
      for (const row of rows) {
        const record = JSON.parse(row.payload) as Omit<GatewayProbeRecord, "profile"> & { profile?: string };
        const profiles = owners.all(row.pool_id) as Array<{ profile: string }>;
        // Empty profile permanently quarantines unresolved legacy ownership; valid profiles are nonempty.
        const profile = record.profile ?? (profiles.length === 1 ? profiles[0].profile : "");
        update.run(profile, JSON.stringify({ ...record, profile }), row.id);
      }
      const poolRows = db.prepare("SELECT id, profile, payload FROM gateway_pools").all() as Array<{ id: string; profile: string; payload: string }>;
      const pools = poolRows.map((row) => JSON.parse(row.payload) as GatewayPool);
      const preferenceRows = db.prepare("SELECT key, payload FROM preferences").all() as Array<{ key: string; payload: string }>;
      const preferences = Object.fromEntries(preferenceRows.map((row) => [row.key, JSON.parse(row.payload) as unknown]));
      if (migrateGatewayListeners(pools, preferences)) {
        const updatePool = db.prepare("UPDATE gateway_pools SET payload = ? WHERE profile = ? AND id = ?");
        pools.forEach((pool, index) => updatePool.run(JSON.stringify(pool), poolRows[index].profile, poolRows[index].id));
        const insertSettings = db.prepare("INSERT INTO preferences(key, payload) VALUES(?, ?) ON CONFLICT(key) DO NOTHING");
        for (const [key, settings] of Object.entries(preferences)) {
          if (key.startsWith("gateway.listener.")) insertSettings.run(key, JSON.stringify(settings));
        }
        db.prepare("DELETE FROM preferences WHERE key = ?").run("gateway.port");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private removeLegacySessionOffsets(): void {
    if (!this.sqlite) return;
    const rows = this.sqlite.prepare("SELECT id, payload FROM session_cache").all() as Array<{ id: string; payload: string }>;
    const updates: Array<{ id: string; payload: string }> = [];
    for (const row of rows) {
      try {
        const payload = asObject(JSON.parse(row.payload));
        if (!payload || !("messageOffsets" in payload)) continue;
        delete payload.messageOffsets;
        updates.push({ id: row.id, payload: JSON.stringify(payload) });
      } catch {
        // Leave malformed legacy rows untouched; a later refresh can replace them safely.
      }
    }
    if (updates.length === 0) return;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sqlite.prepare("UPDATE session_cache SET payload = ? WHERE id = ?");
      for (const item of updates) update.run(item.payload, item.id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private async loadFallback(): Promise<void> {
    const empty = emptyState();
    let needsPersistence = false;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath + ".json", "utf8")) as Record<string, unknown>;
      const isCurrent = parsed.version === 3 && Array.isArray(parsed.sessionCaches);
      const rawCaches = Array.isArray(parsed.sessionCaches) ? parsed.sessionCaches : [];
      const hasLegacyCacheFields = rawCaches.some((cache) => Boolean(asObject(cache)?.messageOffsets));
      this.fallback = {
        version: 3,
        providerLabels: asStringRecord(parsed.providerLabels),
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots.filter(asObject) : [],
        gatewayPools: Array.isArray(parsed.gatewayPools) ? parsed.gatewayPools as GatewayPool[] : [],
        gatewayProbeHistory: Array.isArray(parsed.gatewayProbeHistory) ? parsed.gatewayProbeHistory as GatewayProbeRecord[] : [],
        sessionCaches: isCurrent ? (rawCaches as SessionFileCache[]).map(cloneCache) : [],
        preferences: asObject(parsed.preferences) ?? {},
      };
      let migratedHistory = false;
      for (const record of this.fallback.gatewayProbeHistory) {
        if (record.profile !== undefined) continue;
        const owners = new Set(this.fallback.gatewayPools.filter((pool) => pool.id === record.poolId).map((pool) => pool.profile));
        // Persist unresolved ownership too, so a newly created pool cannot inherit old probes.
        record.profile = owners.size === 1 ? owners.values().next().value! : "";
        migratedHistory = true;
      }
      const migratedListeners = migrateGatewayListeners(this.fallback.gatewayPools, this.fallback.preferences);
      needsPersistence = !isCurrent || "sessionIndex" in parsed || hasLegacyCacheFields || migratedHistory || migratedListeners;
    } catch {
      this.fallback = empty;
    }
    // Migration write errors must propagate without replacing the loaded state with an empty store.
    if (needsPersistence) await this.persistFallback();
  }

  async setProviderLabel(providerId: string, label: string): Promise<void> {
    if (this.sqlite) {
      this.sqlite.prepare("INSERT INTO provider_meta(provider_id, label) VALUES(?, ?) ON CONFLICT(provider_id) DO UPDATE SET label=excluded.label").run(providerId, label);
      return;
    }
    this.fallback.providerLabels[providerId] = label;
    await this.persistFallback();
  }

  getProviderLabels(): Record<string, string> {
    if (this.sqlite) {
      const rows = this.sqlite.prepare("SELECT provider_id, label FROM provider_meta").all() as Array<{ provider_id: string; label: string }>;
      return Object.fromEntries(rows.map((row) => [row.provider_id, row.label]));
    }
    return { ...this.fallback.providerLabels };
  }

  async addSnapshot(snapshot: Record<string, unknown>): Promise<void> {
    if (this.sqlite) {
      this.sqlite.prepare("INSERT OR REPLACE INTO snapshots(id, profile, created_at, payload) VALUES(?, ?, ?, ?)").run(snapshot.id, snapshot.profile, snapshot.createdAt, JSON.stringify(snapshot));
      this.sqlite.prepare(
        "DELETE FROM snapshots WHERE profile = ? AND id NOT IN (SELECT id FROM snapshots WHERE profile = ? ORDER BY created_at DESC LIMIT ?)",
      ).run(snapshot.profile, snapshot.profile, SNAPSHOT_RETENTION);
      return;
    }
    this.fallback.snapshots = [snapshot, ...this.fallback.snapshots.filter((item) => item.id !== snapshot.id)].slice(0, SNAPSHOT_RETENTION);
    await this.persistFallback();
  }

  listSnapshots(profile: string): Array<Record<string, unknown>> {
    if (this.sqlite) {
      const rows = this.sqlite.prepare("SELECT payload FROM snapshots WHERE profile = ? ORDER BY created_at DESC").all(profile) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    }
    return this.fallback.snapshots.filter((snapshot) => snapshot.profile === profile);
  }

  getSnapshot(profile: string, id: string): Snapshot | null {
    if (this.sqlite) {
      const row = this.sqlite.prepare("SELECT payload FROM snapshots WHERE profile = ? AND id = ? LIMIT 1").get(profile, id) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as Snapshot : null;
    }
    const item = this.fallback.snapshots.find((snapshot) => snapshot.profile === profile && snapshot.id === id);
    return item ? item as unknown as Snapshot : null;
  }

  getLatestSnapshot(profile: string): Snapshot | null {
    if (this.sqlite) {
      const row = this.sqlite.prepare("SELECT payload FROM snapshots WHERE profile = ? ORDER BY created_at DESC LIMIT 1").get(profile) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as Snapshot : null;
    }
    const item = this.fallback.snapshots.find((snapshot) => snapshot.profile === profile);
    return item ? item as unknown as Snapshot : null;
  }

  getGatewayListenerSettings(profile: string): GatewayListenerSettings {
    const settings = this.getPreference<GatewayListenerSettings>(`gateway.listener.${profile}`);
    return settings ? { ...settings, conflictingPorts: [...settings.conflictingPorts] } : { port: DEFAULT_GATEWAY_PORT, conflictingPorts: [] };
  }

  async setGatewayListenerPort(profile: string, port: number): Promise<void> {
    validateGatewayPort(port);
    await this.setPreference(`gateway.listener.${profile}`, { port, conflictingPorts: [] });
  }

  async saveGatewayPool(pool: GatewayPool): Promise<void> {
    if (this.sqlite) {
      this.sqlite.prepare("INSERT INTO gateway_pools(id, profile, payload) VALUES(?, ?, ?) ON CONFLICT(profile, id) DO UPDATE SET payload=excluded.payload").run(pool.id, pool.profile, JSON.stringify(pool));
      return;
    }
    this.fallback.gatewayPools = [pool, ...this.fallback.gatewayPools.filter((item) => item.id !== pool.id || item.profile !== pool.profile)];
    await this.persistFallback();
  }

  getGatewayPoolRevision(profile: string, poolId: string): number {
    return this.gatewayPoolRevisions.get(profile)?.get(poolId) ?? 0;
  }

  async deleteGatewayPool(profile: string, poolId: string): Promise<boolean> {
    const revision = this.getGatewayPoolRevision(profile, poolId);
    const revisions = this.gatewayPoolRevisions.get(profile) ?? new Map<string, number>();
    this.gatewayPoolRevisions.set(profile, revisions);
    if (this.sqlite) {
      const db = this.sqlite;
      db.exec("BEGIN IMMEDIATE");
      try {
        const existed = Boolean(db.prepare("SELECT id FROM gateway_pools WHERE profile = ? AND id = ?").get(profile, poolId));
        db.prepare("DELETE FROM gateway_pools WHERE profile = ? AND id = ?").run(profile, poolId);
        db.prepare("DELETE FROM gateway_probe_history WHERE profile = ? AND pool_id = ?").run(profile, poolId);
        db.exec("COMMIT");
        revisions.set(poolId, revision + 1);
        return existed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const matchesPool = (item: GatewayPool): boolean => item.profile === profile && item.id === poolId;
    const pools = this.fallback.gatewayPools.filter(matchesPool);
    const poolIndex = this.fallback.gatewayPools.findIndex(matchesPool);
    const history = this.fallback.gatewayProbeHistory.filter((item) => item.profile === profile && item.poolId === poolId);
    this.fallback.gatewayPools = this.fallback.gatewayPools.filter((item) => !matchesPool(item));
    this.fallback.gatewayProbeHistory = this.fallback.gatewayProbeHistory.filter((item) => item.profile !== profile || item.poolId !== poolId);
    revisions.set(poolId, revision + 1);
    await this.persistFallback(() => {
      // Restore only this deletion's data; other pending writes must survive a failed replacement.
      if (!this.fallback.gatewayPools.some(matchesPool)) this.fallback.gatewayPools.splice(poolIndex, 0, ...pools);
      const ids = new Set(this.fallback.gatewayProbeHistory.map((item) => item.id));
      this.fallback.gatewayProbeHistory.push(...history.filter((item) => !ids.has(item.id)));
      if (revisions.get(poolId) === revision + 1) revisions.set(poolId, revision);
    });
    return pools.length > 0;
  }

  listGatewayPools(profile?: string): GatewayPool[] {
    if (this.sqlite) {
      const query = profile ? "SELECT payload FROM gateway_pools WHERE profile = ?" : "SELECT payload FROM gateway_pools";
      const rows = this.sqlite.prepare(query).all(...(profile ? [profile] : [])) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as GatewayPool);
    }
    return this.fallback.gatewayPools.filter((pool) => !profile || pool.profile === profile);
  }

  async recordGatewayProbe(record: GatewayProbeRecord, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined) {
      if (this.getGatewayPoolRevision(record.profile, record.poolId) !== expectedRevision) return;
      const exists = this.sqlite
        ? this.sqlite.prepare("SELECT 1 FROM gateway_pools WHERE profile = ? AND id = ?").get(record.profile, record.poolId)
        : this.fallback.gatewayPools.some((pool) => pool.profile === record.profile && pool.id === record.poolId);
      if (!exists) return;
    }
    const id = record.id || randomUUID();
    const item: GatewayProbeRecord = { ...record, id };
    if (this.sqlite) {
      this.sqlite.prepare(
        "INSERT INTO gateway_probe_history(id, profile, pool_id, upstream_id, created_at, payload) VALUES(?, ?, ?, ?, ?, ?)"
      ).run(id, item.profile, item.poolId, item.upstreamId, item.timestamp, JSON.stringify(item));
      this.sqlite.prepare(
        "DELETE FROM gateway_probe_history WHERE profile = ? AND pool_id = ? AND upstream_id = ? AND id NOT IN (SELECT id FROM gateway_probe_history WHERE profile = ? AND pool_id = ? AND upstream_id = ? ORDER BY created_at DESC LIMIT ?)"
      ).run(item.profile, item.poolId, item.upstreamId, item.profile, item.poolId, item.upstreamId, PROBE_HISTORY_RETENTION);
      return;
    }
    const current = this.fallback.gatewayProbeHistory ?? [];
    const updated = [item, ...current.filter((entry) => entry.id !== id)];
    const matching = updated.filter((entry) => entry.profile === item.profile && entry.poolId === item.poolId && entry.upstreamId === item.upstreamId).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, PROBE_HISTORY_RETENTION);
    const others = updated.filter((entry) => !(entry.profile === item.profile && entry.poolId === item.poolId && entry.upstreamId === item.upstreamId));
    this.fallback.gatewayProbeHistory = [...matching, ...others];
    await this.persistFallback();
  }

  listGatewayProbeHistory(profile: string, poolId?: string, upstreamId?: string): GatewayProbeRecord[] {
    if (this.sqlite) {
      let query = "SELECT payload FROM gateway_probe_history WHERE profile = ?";
      const params: string[] = [profile];
      if (poolId) {
        query += " AND pool_id = ?";
        params.push(poolId);
      }
      if (upstreamId) {
        query += " AND upstream_id = ?";
        params.push(upstreamId);
      }
      query += " ORDER BY created_at DESC";
      const rows = this.sqlite.prepare(query).all(...params) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as GatewayProbeRecord);
    }
    return this.fallback.gatewayProbeHistory.filter((entry): entry is GatewayProbeRecord => {
      if (entry.profile !== profile) return false;
      if (poolId && entry.poolId !== poolId) return false;
      if (upstreamId && entry.upstreamId !== upstreamId) return false;
      return true;
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  getGatewayHealth(profile: string, poolId?: string): Record<string, GatewayUpstreamHealth> {
    const history = this.listGatewayProbeHistory(profile, poolId);
    const byUpstream: Record<string, GatewayProbeRecord[]> = {};
    for (const record of history) {
      const key = `${record.poolId}:${record.upstreamId}`;
      if (!byUpstream[key]) byUpstream[key] = [];
      byUpstream[key].push(record);
    }
    const result: Record<string, GatewayUpstreamHealth> = {};
    for (const [key, records] of Object.entries(byUpstream)) {
      const [pId, uId] = key.split(":");
      result[key] = evaluateUpstreamHealth(pId, uId, records);
    }
    return result;
  }

  async replaceSessionCaches(profile: string, caches: SessionFileCache[]): Promise<void> {
    const next = caches.filter((cache) => cache.profile === profile).map(cloneCache);
    if (!this.sqlite) {
      this.fallback.sessionCaches = [
        ...this.fallback.sessionCaches.filter((cache) => cache.profile !== profile),
        ...next,
      ];
      await this.persistFallback();
      return;
    }

    const current = this.listSessionCaches(profile);
    const currentById = new Map(current.map((cache) => [cache.id, cache]));
    const nextById = new Map(next.map((cache) => [cache.id, cache]));
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const upsertCache = this.sqlite.prepare("INSERT INTO session_cache(id, profile, relative_path, payload) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile, relative_path=excluded.relative_path, payload=excluded.payload");
      const deleteUsage = this.sqlite.prepare("DELETE FROM session_usage WHERE session_id = ?");
      const insertUsage = this.sqlite.prepare("INSERT INTO session_usage(id, session_id, profile, payload) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, profile=excluded.profile, payload=excluded.payload");
      const deleteCache = this.sqlite.prepare("DELETE FROM session_cache WHERE id = ?");
      for (const cache of next) {
        const before = currentById.get(cache.id);
        const changed = !before || JSON.stringify(cachePayload(before)) !== JSON.stringify(cachePayload(cache)) || JSON.stringify(before.usage) !== JSON.stringify(cache.usage);
        if (!changed) continue;
        upsertCache.run(cache.id, profile, cache.relativePath, JSON.stringify(cachePayload(cache)));
        deleteUsage.run(cache.id);
        for (const usage of cache.usage) insertUsage.run(usage.id, cache.id, profile, JSON.stringify(usage));
      }
      for (const cache of current) {
        if (!nextById.has(cache.id)) {
          deleteUsage.run(cache.id);
          deleteCache.run(cache.id);
        }
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async removeSessions(profile: string, ids: string[]): Promise<void> {
    const selected = new Set(ids);
    if (!selected.size) return;
    if (!this.sqlite) {
      this.fallback.sessionCaches = this.fallback.sessionCaches.filter((cache) => cache.profile !== profile || !selected.has(cache.id));
      await this.persistFallback();
      return;
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const deleteCache = this.sqlite.prepare("DELETE FROM session_cache WHERE profile = ? AND id = ?");
      const deleteUsage = this.sqlite.prepare("DELETE FROM session_usage WHERE profile = ? AND session_id = ?");
      const deleteFts = this.hasFts ? this.sqlite.prepare("DELETE FROM session_fts WHERE profile = ? AND session_id = ?") : undefined;
      for (const id of selected) {
        deleteFts?.run(profile, id);
        deleteUsage.run(profile, id);
        deleteCache.run(profile, id);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  hasSessionCache(profile: string, id: string): boolean {
    if (!this.sqlite) return this.fallback.sessionCaches.some((cache) => cache.profile === profile && cache.id === id);
    return Boolean(this.sqlite.prepare("SELECT 1 FROM session_cache WHERE profile = ? AND id = ? LIMIT 1").get(profile, id));
  }

  listSessionCaches(profile: string): SessionFileCache[] {
    if (!this.sqlite) {
      return sortCaches(this.fallback.sessionCaches.filter((cache) => cache.profile === profile).map(cloneCache));
    }
    const cacheRows = this.sqlite.prepare("SELECT payload FROM session_cache WHERE profile = ?").all(profile) as Array<{ payload: string }>;
    const usages = this.sqlite.prepare("SELECT session_id, payload FROM session_usage WHERE profile = ?").all(profile) as Array<{ session_id: string; payload: string }>;
    const usageBySession = new Map<string, SessionUsageRecord[]>();
    for (const row of usages) {
      const list = usageBySession.get(row.session_id) ?? [];
      list.push(JSON.parse(row.payload) as SessionUsageRecord);
      usageBySession.set(row.session_id, list);
    }
    return sortCaches(cacheRows.map((row) => {
      const payload = JSON.parse(row.payload) as Omit<SessionFileCache, "usage">;
      return cloneCache({ ...payload, usage: cloneUsage(usageBySession.get(payload.id) ?? []) });
    }));
  }

  getSessionCache(profile: string, id: string): SessionFileCache | undefined {
    return this.listSessionCaches(profile).find((cache) => cache.id === id);
  }

  listSessionSummaries(profile: string): SessionSummary[] {
    return this.listSessionCaches(profile).map((cache) => ({ ...cache.summary, tokens: { ...cache.summary.tokens } }));
  }

  listSessionUsage(profile: string): SessionUsageRecord[] {
    return this.listSessionCaches(profile).flatMap((cache) => cloneUsage(cache.usage));
  }

  hasIndexedSession(profile: string, sessionId: string): boolean {
    if (!this.sqlite || !this.hasFts) return false;
    try {
      const row = this.sqlite.prepare("SELECT 1 FROM session_fts WHERE profile = ? AND session_id = ? LIMIT 1").get(profile, sessionId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  indexSessionMessagesForFts(profile: string, sessionId: string, messages: Array<{ role?: string; text?: string }>): void {
    if (!this.sqlite || !this.hasFts) return;
    try {
      this.sqlite.prepare("DELETE FROM session_fts WHERE session_id = ? AND profile = ?").run(sessionId, profile);
      const insert = this.sqlite.prepare("INSERT INTO session_fts(session_id, profile, role, text) VALUES(?, ?, ?, ?)");
      for (const msg of messages) {
        if (msg.text && typeof msg.text === "string" && msg.text.trim()) {
          insert.run(sessionId, profile, msg.role || "message", msg.text);
        }
      }
    } catch {
      // Gracefully ignore FTS indexing errors
    }
  }

  appendSessionMessagesForFts(profile: string, sessionId: string, messages: Array<{ role?: string; text?: string }>): void {
    if (!this.sqlite || !this.hasFts) return;
    try {
      const insert = this.sqlite.prepare("INSERT INTO session_fts(session_id, profile, role, text) VALUES(?, ?, ?, ?)");
      for (const msg of messages) {
        if (msg.text && typeof msg.text === "string" && msg.text.trim()) {
          insert.run(sessionId, profile, msg.role || "message", msg.text);
        }
      }
    } catch {
      // Gracefully ignore
    }
  }

  searchSessionFts(profile: string, query: string, limit = 50): SessionSearchResult[] {
    if (!query.trim() || !this.sqlite || !this.hasFts) return [];
    try {
      const clean = query.replace(/['"*]/g, " ").trim();
      if (!clean) return [];
      const matchExpr = clean.split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(" ");
      const rows = this.sqlite.prepare(
        "SELECT session_id, role, snippet(session_fts, 3, '<mark>', '</mark>', '...', 15) AS snippet FROM session_fts WHERE profile = ? AND session_fts MATCH ? LIMIT ?"
      ).all(profile, matchExpr, limit) as Array<{ session_id: string; role: string; snippet: string }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        role: r.role,
        snippet: r.snippet,
      }));
    } catch {
      return [];
    }
  }

  async setPreference(key: string, value: unknown): Promise<void> {
    if (this.sqlite) {
      this.sqlite.prepare("INSERT INTO preferences(key, payload) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(key, JSON.stringify(value));
      return;
    }
    this.fallback.preferences[key] = value;
    await this.persistFallback();
  }

  getPreference<T>(key: string): T | undefined {
    if (this.sqlite) {
      const row = this.sqlite.prepare("SELECT payload FROM preferences WHERE key = ?").get(key) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as T : undefined;
    }
    return this.fallback.preferences[key] as T | undefined;
  }

  private persistFallback(rollback?: () => void): Promise<void> {
    const write = this.fallbackWrites.then(async () => {
      const target = this.filePath + ".json";
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(this.fallback, null, 2), "utf8");
        await fs.rename(temporary, target);
      } catch (error) {
        rollback?.();
        throw error;
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.fallbackWrites = write.catch(() => undefined);
    return write;
  }
}
