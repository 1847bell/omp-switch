import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync as SqliteDatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataStore } from "./metadata-store";
import type { GatewayPool, SessionFileCache } from "@omp-switch/core";

const tempRoots: string[] = [];
const openStores: MetadataStore[] = [];

async function makeStore(backend: "auto" | "json") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-test-"));
  tempRoots.push(root);
  const store = new MetadataStore(root, { backend });
  await store.init();
  expect(store.activeBackend).toBe(backend === "auto" ? "sqlite" : "json");
  openStores.push(store);
  return { root, store };
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function pool(id: string, profile = "default"): GatewayPool {
  return {
    id,
    profile,
    virtualModel: "omp-switch/" + id,
    enabled: true,
    upstreams: [{ id: "one", providerId: "openai", modelId: "gpt-5", kind: "secret", credentialId: "cred", enabled: true }],
  };
}

function sessionCache(id: string, profile = "default", hour = 0): SessionFileCache {
  return {
    id,
    profile,
    relativePath: "project/2026-08-19T0" + hour + "-00-00-000Z_019f428b-2bca-7000-8c4f-b21fd95671f4.jsonl",
    fileSize: 100 + hour,
    mtimeMs: hour,
    headHash: "head-" + hour,
    completeBytes: 100 + hour,
    invalidLines: 0,
    summary: {
      id,
      profile,
      title: "Session " + id,
      lastActiveAt: "2026-08-19T0" + hour + ":00:00Z",
      messageCount: 2,
      requestCount: 1,
      failures: 0,
      tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
      cost: 0.001,
      fileSize: 100 + hour,
    },
    usage: [{
      id: "usage-" + id,
      sessionId: id,
      profile,
      startedAt: "2026-08-19T0" + hour + ":00:00Z",
      model: "gpt-5",
      provider: "openai",
      tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
      cost: 0.001,
      requestCount: 1,
      failures: 0,
      sourceKey: id + ":0",
    }],
  };
}

describe.each(["auto", "json"] as const)("MetadataStore (%s backend)", (backend) => {
  it("defaults and persists listener settings independently per Profile", async () => {
    const { root, store } = await makeStore(backend);
    expect(store.getGatewayListenerSettings("default")).toEqual({ port: 46831, conflictingPorts: [] });
    await store.setGatewayListenerPort("default", 47001);
    await store.setGatewayListenerPort("work", 47002);
    for (const port of [0, 1023, 65536, 1.5, NaN, Infinity]) {
      await expect(store.setGatewayListenerPort("default", port)).rejects.toThrow("Gateway port is invalid");
    }
    const settings = store.getGatewayListenerSettings("default");
    settings.conflictingPorts.push(9999);
    expect(store.getGatewayListenerSettings("default")).toEqual({ port: 47001, conflictingPorts: [] });
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.getGatewayListenerSettings("default")).toEqual({ port: 47001, conflictingPorts: [] });
    expect(reopened.getGatewayListenerSettings("work")).toEqual({ port: 47002, conflictingPorts: [] });
    expect(reopened.getPreference("gateway.listener.default")).toEqual({ port: 47001, conflictingPorts: [] });
  });

  it("migrates legacy listener ports across all Profiles and stays idempotent on reopening", async () => {
    const { root, store } = await makeStore(backend);
    await store.setProviderLabel("openai", "Preserved");
    await store.setPreference("unrelated", { retained: true });
    await store.addSnapshot({ id: "preserved", profile: "same", createdAt: "2026-11-04T00:00:00Z" });
    const legacyPools = [
      { ...pool("one", "same"), port: 47011, extra: "retained" },
      { ...pool("two", "same"), port: 47011, enabled: false },
      { ...pool("one", "conflict"), port: 47022 },
      { ...pool("two", "conflict"), port: 47021, enabled: false },
      { ...pool("one", "invalid"), port: 80 },
      { ...pool("two", "invalid"), port: 47031 },
      { ...pool("one", "string"), port: "47041" },
      { ...pool("one", "explicit"), port: 47051 },
      { ...pool("two", "explicit"), port: 47052 },
      { ...pool("one", "unresolved"), port: 47061 },
      pool("one", "new"),
    ];
    const preferences = {
      "gateway.port": 49999,
      "gateway.listener.explicit": { port: 48001, conflictingPorts: [] },
      "gateway.listener.unresolved": { port: null, conflictingPorts: [48002, 48003] },
    };
    store.close();
    if (backend === "json") {
      const file = path.join(root, "metadata.sqlite.json");
      const state = JSON.parse(await fs.readFile(file, "utf8"));
      state.gatewayPools = legacyPools;
      Object.assign(state.preferences, preferences);
      await fs.writeFile(file, JSON.stringify(state), "utf8");
    } else {
      const database = new SqliteDatabaseSync(path.join(root, "metadata.sqlite"));
      try {
        const insertPool = database.prepare("INSERT INTO gateway_pools VALUES (?, ?, ?)");
        for (const item of legacyPools) insertPool.run(item.id, item.profile, JSON.stringify(item));
        const insertPreference = database.prepare("INSERT INTO preferences VALUES (?, ?)");
        for (const [key, value] of Object.entries(preferences)) insertPreference.run(key, JSON.stringify(value));
      } finally {
        database.close();
      }
    }
    const cleanPools = legacyPools.map((item) => {
      const clean = { ...item } as GatewayPool & { port?: unknown };
      delete clean.port;
      return clean;
    });
    for (let round = 0; round < 2; round++) {
      const reopened = new MetadataStore(root, { backend });
      openStores.push(reopened);
      await reopened.init();
      await reopened.init();
      expect(reopened.getGatewayListenerSettings("same")).toEqual({ port: 47011, conflictingPorts: [] });
      expect(reopened.getGatewayListenerSettings("conflict")).toEqual({ port: null, conflictingPorts: [47021, 47022] });
      expect(reopened.getGatewayListenerSettings("invalid")).toEqual({ port: null, conflictingPorts: [80, 47031] });
      expect(reopened.getGatewayListenerSettings("string")).toEqual({ port: null, conflictingPorts: [] });
      expect(reopened.getGatewayListenerSettings("explicit")).toEqual(preferences["gateway.listener.explicit"]);
      expect(reopened.getGatewayListenerSettings("unresolved")).toEqual(preferences["gateway.listener.unresolved"]);
      expect(reopened.getGatewayListenerSettings("new")).toEqual({ port: 46831, conflictingPorts: [] });
      expect(reopened.listGatewayPools()).toEqual(expect.arrayContaining(cleanPools));
      expect(reopened.listGatewayPools()).toHaveLength(cleanPools.length);
      expect(reopened.getPreference("gateway.port")).toBeUndefined();
      expect(reopened.getPreference("unrelated")).toEqual({ retained: true });
      expect(reopened.getProviderLabels()).toEqual({ openai: "Preserved" });
      expect(reopened.listSnapshots("same")).toEqual([{ id: "preserved", profile: "same", createdAt: "2026-11-04T00:00:00Z" }]);
      reopened.close();
      if (backend === "json") {
        const persisted = JSON.parse(await fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8"));
        expect(persisted.gatewayPools.every((item: Record<string, unknown>) => !("port" in item))).toBe(true);
        expect(persisted.preferences["gateway.listener.conflict"]).toEqual({ port: null, conflictingPorts: [47021, 47022] });
      } else {
        const database = new SqliteDatabaseSync(path.join(root, "metadata.sqlite"));
        try {
          const rows = database.prepare("SELECT payload FROM gateway_pools").all() as Array<{ payload: string }>;
          expect(rows.every((row) => !("port" in JSON.parse(row.payload)))).toBe(true);
          const setting = database.prepare("SELECT payload FROM preferences WHERE key = ?").get("gateway.listener.conflict") as { payload: string };
          expect(JSON.parse(setting.payload)).toEqual({ port: null, conflictingPorts: [47021, 47022] });
        } finally {
          database.close();
        }
      }
    }
    const resolved = new MetadataStore(root, { backend });
    openStores.push(resolved);
    await resolved.init();
    await resolved.setGatewayListenerPort("conflict", 48004);
    expect(resolved.getGatewayListenerSettings("conflict")).toEqual({ port: 48004, conflictingPorts: [] });
    expect(resolved.getGatewayListenerSettings("invalid").port).toBeNull();
  });

  it("round-trips provider labels", async () => {
    const { store } = await makeStore(backend);
    expect(store.getProviderLabels()).toEqual({});
    await store.setProviderLabel("openai", "Work OpenAI");
    await store.setProviderLabel("openai", "Renamed");
    await store.setProviderLabel("groq", "Groq");
    expect(store.getProviderLabels()).toEqual({ openai: "Renamed", groq: "Groq" });
  });

  it("preserves concurrent pool, probe and preference commits after reopening", async () => {
    const { root, store } = await makeStore(backend);
    const defaultPool = pool("same");
    const workPool = pool("same", "work");
    await Promise.all([
      store.saveGatewayPool(defaultPool),
      store.saveGatewayPool(workPool),
      store.recordGatewayProbe({ profile: "default", poolId: "same", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, status: 200, latencyMs: 12 }),
      store.recordGatewayProbe({ profile: "work", poolId: "same", upstreamId: "one", timestamp: "2026-11-04T00:00:01Z", ok: false, status: 503, latencyMs: 24 }),
      store.setGatewayListenerPort("default", 47000),
      store.setProviderLabel("openai", "Local test provider"),
    ]);
    store.close();
    const reopened = new MetadataStore(root, { backend });
    await reopened.init();
    openStores.push(reopened);
    expect(reopened.activeBackend).toBe(backend === "auto" ? "sqlite" : "json");
    expect(reopened.listGatewayPools("default")).toEqual([defaultPool]);
    expect(reopened.listGatewayPools("work")).toEqual([workPool]);
    expect(reopened.getGatewayHealth("default")["same:one"].lastStatus).toBe(200);
    expect(reopened.getGatewayHealth("work")["same:one"].lastStatus).toBe(503);
    expect(reopened.getGatewayListenerSettings("default")).toEqual({ port: 47000, conflictingPorts: [] });
    expect(reopened.getProviderLabels()).toEqual({ openai: "Local test provider" });
  });

  it("returns the newest snapshot per profile and keeps profiles apart", async () => {
    const { store } = await makeStore(backend);
    expect(store.getLatestSnapshot("default")).toBeNull();
    await store.addSnapshot({ id: "a", profile: "default", createdAt: "2026-08-19T01:00:00Z" });
    await store.addSnapshot({ id: "b", profile: "default", createdAt: "2026-08-19T03:00:00Z" });
    await store.addSnapshot({ id: "c", profile: "work", createdAt: "2026-08-19T02:00:00Z" });
    expect(store.getLatestSnapshot("default")).toMatchObject({ id: "b" });
    expect(store.getLatestSnapshot("work")).toMatchObject({ id: "c" });
    expect(store.getSnapshot("default", "a")).toMatchObject({ id: "a" });
    expect(store.getSnapshot("default", "non-existent")).toBeNull();
  });

  it("caps stored snapshots so the metadata never grows without bound", async () => {
    const { store } = await makeStore(backend);
    for (let index = 0; index < 35; index += 1) {
      await store.addSnapshot({
        id: "snap-" + String(index).padStart(2, "0"),
        profile: "default",
        createdAt: "2026-08-19T" + String(index % 24).padStart(2, "0") + ":" + String(index).padStart(2, "0") + ":00Z",
      });
    }
    expect(store.listSnapshots("default").length).toBe(30);
  }, 30_000);

  it("keeps same-ID pools separate across updates, repeated init and reopen", async () => {
    const { root, store } = await makeStore(backend);
    await store.saveGatewayPool(pool("fast"));
    await store.saveGatewayPool(pool("fast", "work"));
    const updated = { ...pool("fast"), virtualModel: "updated" };
    await store.saveGatewayPool(updated);
    await store.init();
    expect(store.listGatewayPools("default")).toEqual([updated]);
    expect(store.listGatewayPools("work")).toEqual([pool("fast", "work")]);
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    await reopened.init();
    expect(reopened.activeBackend).toBe(backend === "auto" ? "sqlite" : "json");
    expect(reopened.listGatewayPools("default")).toEqual([updated]);
    expect(reopened.listGatewayPools("work")).toEqual([pool("fast", "work")]);
    expect(reopened.listGatewayPools()).toHaveLength(2);
  });

  it("deletes only the selected Profile's pool and health while preserving listener and unrelated data on reopen", async () => {
    const { root, store } = await makeStore(backend);
    await store.saveGatewayPool(pool("same"));
    await store.saveGatewayPool(pool("same", "work"));
    await store.saveGatewayPool(pool("other"));
    await store.setGatewayListenerPort("default", 47001);
    await store.setProviderLabel("openai", "Preserved");
    await store.setPreference("unrelated", { retained: true });
    await store.addSnapshot({ id: "preserved", profile: "default", createdAt: "2026-11-04T00:00:00Z" });
    await store.replaceSessionCaches("default", [sessionCache("preserved")]);
    const probe = { upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, status: 200, latencyMs: 12 };
    await store.recordGatewayProbe({ ...probe, profile: "default", poolId: "same" });
    await store.recordGatewayProbe({ ...probe, profile: "work", poolId: "same" });
    await store.recordGatewayProbe({ ...probe, profile: "default", poolId: "other" });
    expect(store.getGatewayHealth("default", "same")["same:one"]).toBeDefined();
    await expect(store.deleteGatewayPool("default", "same")).resolves.toBe(true);
    expect(store.getGatewayPoolRevision("default", "same")).toBe(1);
    expect(store.getGatewayPoolRevision("work", "same")).toBe(0);
    expect(store.getGatewayPoolRevision("default", "other")).toBe(0);
    expect(store.listGatewayProbeHistory("default", "same")).toEqual([]);
    expect(store.getGatewayHealth("default", "same")).toEqual({});
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayPools("default")).toEqual([pool("other")]);
    expect(reopened.listGatewayPools("work")).toEqual([pool("same", "work")]);
    expect(reopened.getGatewayHealth("default", "same")).toEqual({});
    expect(reopened.listGatewayProbeHistory("default", "same")).toEqual([]);
    expect(reopened.listGatewayProbeHistory("work", "same")).toHaveLength(1);
    expect(reopened.listGatewayProbeHistory("default", "other")).toHaveLength(1);
    expect(reopened.getGatewayListenerSettings("default")).toEqual({ port: 47001, conflictingPorts: [] });
    expect(reopened.getProviderLabels()).toEqual({ openai: "Preserved" });
    expect(reopened.getPreference("unrelated")).toEqual({ retained: true });
    expect(reopened.listSnapshots("default")).toHaveLength(1);
    expect(reopened.getSessionCache("default", "preserved")).toBeDefined();
    await expect(reopened.deleteGatewayPool("default", "other")).resolves.toBe(true);
    expect(reopened.listGatewayPools("default")).toEqual([]);
    expect(reopened.getGatewayListenerSettings("default").port).toBe(47001);
  });

  it("rejects stale guarded observations after deletion and same-ID recreation but accepts the current revision", async () => {
    const { root, store } = await makeStore(backend);
    await store.saveGatewayPool(pool("same"));
    await store.saveGatewayPool(pool("same", "work"));
    const revision = store.getGatewayPoolRevision("default", "same");
    const observation = { profile: "default", poolId: "same", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, latencyMs: 12 };
    await store.recordGatewayProbe({ ...observation, id: "before" }, revision);
    await store.deleteGatewayPool("default", "same");
    await store.recordGatewayProbe({ ...observation, id: "deleted-old" }, revision);
    await store.recordGatewayProbe({ ...observation, id: "deleted-current" }, store.getGatewayPoolRevision("default", "same"));
    expect(store.listGatewayProbeHistory("default", "same")).toEqual([]);
    await store.saveGatewayPool(pool("same"));
    await store.recordGatewayProbe({ ...observation, id: "recreated-old" }, revision);
    expect(store.getGatewayHealth("default", "same")).toEqual({});
    await store.recordGatewayProbe({ ...observation, id: "current" }, store.getGatewayPoolRevision("default", "same"));
    await store.recordGatewayProbe({ ...observation, profile: "work", id: "work-current" }, revision);
    expect(store.listGatewayProbeHistory("default", "same").map((item) => item.id)).toEqual(["current"]);
    expect(store.listGatewayProbeHistory("work", "same").map((item) => item.id)).toEqual(["work-current"]);
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayProbeHistory("default", "same").map((item) => item.id)).toEqual(["current"]);
    expect(reopened.getGatewayPoolRevision("default", "same")).toBe(0);
  });

  it("idempotently clears orphan history without touching another Profile", async () => {
    const { root, store } = await makeStore(backend);
    const observation = { poolId: "orphan", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: false, latencyMs: 12 };
    await store.recordGatewayProbe({ ...observation, profile: "default" });
    await store.recordGatewayProbe({ ...observation, profile: "work" });
    await expect(store.deleteGatewayPool("default", "orphan")).resolves.toBe(false);
    await expect(store.deleteGatewayPool("default", "orphan")).resolves.toBe(false);
    expect(store.getGatewayPoolRevision("default", "orphan")).toBe(2);
    expect(store.getGatewayHealth("default", "orphan")).toEqual({});
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayProbeHistory("default", "orphan")).toEqual([]);
    expect(reopened.listGatewayProbeHistory("work", "orphan")).toHaveLength(1);
  });

  it("restores routing input, history, settings and revision when deletion persistence fails", async () => {
    const { root, store } = await makeStore(backend);
    const target = pool("same");
    await store.saveGatewayPool(target);
    await store.saveGatewayPool(pool("same", "work"));
    await store.setGatewayListenerPort("default", 47001);
    const observation = { id: "preserved", profile: "default", poolId: "same", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, latencyMs: 12 };
    await store.recordGatewayProbe(observation);
    const database = backend === "auto" ? new SqliteDatabaseSync(path.join(root, "metadata.sqlite")) : undefined;
    const rename = backend === "json" ? vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("delete blocked")) : undefined;
    try {
      database?.exec("CREATE TRIGGER reject_gateway_history_delete BEFORE DELETE ON gateway_probe_history BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;");
      await expect(store.deleteGatewayPool("default", "same")).rejects.toThrow("delete blocked");
    } finally {
      rename?.mockRestore();
      database?.exec("DROP TRIGGER IF EXISTS reject_gateway_history_delete");
      database?.close();
    }
    expect(store.listGatewayPools("default")).toEqual([target]);
    expect(store.listGatewayPools("work")).toEqual([pool("same", "work")]);
    expect(store.listGatewayProbeHistory("default", "same")).toEqual([observation]);
    expect(store.getGatewayHealth("default", "same")["same:one"]).toBeDefined();
    expect(store.getGatewayListenerSettings("default").port).toBe(47001);
    expect(store.getGatewayPoolRevision("default", "same")).toBe(0);
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayPools("default")).toEqual([target]);
    expect(reopened.listGatewayProbeHistory("default", "same")).toEqual([observation]);
    expect(reopened.getGatewayListenerSettings("default").port).toBe(47001);
    await reopened.recordGatewayProbe({ ...observation, id: "after-failure" }, 0);
    expect(reopened.listGatewayProbeHistory("default", "same")).toHaveLength(2);
  });

  if (backend === "json") it("keeps pool and history durable when an earlier queued writer succeeds and deletion fails", async () => {
    const { root, store } = await makeStore(backend);
    const target = pool("target");
    const observation = { id: "preserved", profile: "default", poolId: "target", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, latencyMs: 12 };
    await store.saveGatewayPool(target);
    await store.recordGatewayProbe(observation);
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const originalMkdir = fs.mkdir.bind(fs);
    const originalRename = fs.rename.bind(fs);
    const mkdir = vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
      entered();
      await blocked;
      return originalMkdir(...args);
    });
    const rename = vi.spyOn(fs, "rename")
      .mockImplementationOnce(originalRename)
      .mockRejectedValueOnce(Object.assign(new Error("delete blocked"), { code: "EPERM" }));
    try {
      const earlier = store.setProviderLabel("openai", "Earlier writer");
      await entering;
      const deletion = expect(store.deleteGatewayPool("default", "target")).rejects.toThrow("delete blocked");
      expect(store.listGatewayPools("default")).toEqual([target]);
      expect(store.listGatewayProbeHistory("default", "target")).toEqual([observation]);
      release();
      await earlier;
      await deletion;
      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      release();
      mkdir.mockRestore();
      rename.mockRestore();
    }
    expect(store.listGatewayPools("default")).toEqual([target]);
    expect(store.listGatewayProbeHistory("default", "target")).toEqual([observation]);
    expect(store.getGatewayPoolRevision("default", "target")).toBe(0);
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayPools("default")).toEqual([target]);
    expect(reopened.listGatewayProbeHistory("default", "target")).toEqual([observation]);
    expect(reopened.getProviderLabels()).toEqual({ openai: "Earlier writer" });
  });

  if (backend === "json") it("retains the authoritative listener port after a real rename failure and later unrelated write", async () => {
    const { root, store } = await makeStore(backend);
    await store.setGatewayListenerPort("default", 47001);
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementationOnce((source) => originalRename(source, path.join(root, "missing", "metadata.sqlite.json")));
    try {
      await expect(store.setGatewayListenerPort("default", 47002)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rename.mockRestore();
    }
    expect(store.getGatewayListenerSettings("default").port).toBe(47001);
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.getGatewayListenerSettings("default").port).toBe(47001);
    await store.setProviderLabel("openai", "Unrelated later writer");
    await reopened.init();
    expect(reopened.getGatewayListenerSettings("default").port).toBe(47001);
    expect(reopened.getProviderLabels()).toEqual({ openai: "Unrelated later writer" });
  });

  if (backend === "json") it("checks queued observation generations when deletions execute rather than when admitted", async () => {
    const { root, store } = await makeStore(backend);
    await store.saveGatewayPool(pool("target"));
    const observation = { profile: "default", poolId: "target", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, latencyMs: 12 };
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const originalMkdir = fs.mkdir.bind(fs);
    const mkdir = vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
      entered();
      await blocked;
      return originalMkdir(...args);
    });
    try {
      const earlier = store.setPreference("earlier", true);
      await entering;
      const queued = [
        store.deleteGatewayPool("default", "target"),
        store.recordGatewayProbe({ ...observation, id: "deleted-old" }, 0),
        store.saveGatewayPool(pool("target")),
        store.recordGatewayProbe({ ...observation, id: "recreated-old" }, 0),
        store.deleteGatewayPool("default", "target"),
        store.saveGatewayPool(pool("target")),
        store.recordGatewayProbe({ ...observation, id: "second-generation-old" }, 1),
      ];
      release();
      await earlier;
      await Promise.all(queued);
    } finally {
      release();
      mkdir.mockRestore();
    }
    expect(store.getGatewayPoolRevision("default", "target")).toBe(2);
    expect(store.listGatewayProbeHistory("default", "target")).toEqual([]);
    await store.recordGatewayProbe({ ...observation, id: "current" }, 2);
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayProbeHistory("default", "target").map((item) => item.id)).toEqual(["current"]);
  });

  if (backend === "json") it("preserves concurrent unrelated JSON updates when deletion replacement fails", async () => {
    const { root, store } = await makeStore(backend);
    await store.saveGatewayPool(pool("target"));
    await store.setGatewayListenerPort("default", 47001);
    const observation = { id: "original", profile: "default", poolId: "target", upstreamId: "one", timestamp: "2026-11-04T00:00:00Z", ok: true, latencyMs: 12 };
    await store.recordGatewayProbe(observation);
    const originalFile = await fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8");
    let entered!: () => void;
    let release!: () => void;
    const replacing = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
      entered();
      await blocked;
      throw new Error("delete blocked");
    });
    try {
      const deletion = expect(store.deleteGatewayPool("default", "target")).rejects.toThrow("delete blocked");
      await replacing;
      expect(await fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8")).toBe(originalFile);
      const updates = [
        store.saveGatewayPool(pool("other", "work")),
        store.recordGatewayProbe({ ...observation, id: "unrelated", profile: "work", poolId: "other" }),
        store.setGatewayListenerPort("work", 47002),
        store.setPreference("unrelated", { updated: true }),
        store.setProviderLabel("openai", "Updated during deletion"),
      ];
      release();
      await deletion;
      await Promise.all(updates);
    } finally {
      release();
      rename.mockRestore();
    }
    expect(store.getGatewayPoolRevision("default", "target")).toBe(0);
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayPools("default")).toEqual([pool("target")]);
    expect(reopened.listGatewayProbeHistory("default", "target")).toEqual([observation]);
    expect(reopened.listGatewayPools("work")).toEqual([pool("other", "work")]);
    expect(reopened.listGatewayProbeHistory("work", "other").map((item) => item.id)).toEqual(["unrelated"]);
    expect(reopened.getGatewayListenerSettings("default").port).toBe(47001);
    expect(reopened.getGatewayListenerSettings("work").port).toBe(47002);
    expect(reopened.getPreference("unrelated")).toEqual({ updated: true });
    expect(reopened.getProviderLabels()).toEqual({ openai: "Updated during deletion" });
  });

  it("scopes history, health and retention to the profile", async () => {
    const { root, store } = await makeStore(backend);
    const probe = { poolId: "shared", upstreamId: "one", timestamp: "2026-08-24T00:00:00.000Z", ok: false, latencyMs: 10 };
    await store.recordGatewayProbe({ ...probe, profile: "work" });
    await store.recordGatewayProbe({ ...probe, profile: "default", poolId: "other" });
    await store.recordGatewayProbe({ ...probe, profile: "default", upstreamId: "two" });
    for (let index = 0; index < 55; index++) {
      await store.recordGatewayProbe({ ...probe, profile: "default", ok: true, timestamp: new Date(Date.UTC(2026, 7, 24, 0, index)).toISOString() });
    }
    expect(store.listGatewayProbeHistory("default", "shared", "one")).toHaveLength(50);
    expect(store.listGatewayProbeHistory("default", "shared", "one")[49].timestamp).toBe("2026-08-24T00:05:00.000Z");
    expect(store.listGatewayProbeHistory("work", "shared", "one")).toHaveLength(1);
    expect(store.listGatewayProbeHistory("default", "other")).toHaveLength(1);
    expect(store.listGatewayProbeHistory("default", undefined, "two")).toHaveLength(1);
    expect(store.getGatewayHealth("default", "shared")["shared:one"].healthState).toBe("healthy");
    expect(store.getGatewayHealth("work", "shared")["shared:one"].healthState).toBe("unhealthy");
    expect(store.getGatewayHealth("missing")).toEqual({});
    store.close();
    const reopened = new MetadataStore(root, { backend });
    openStores.push(reopened);
    await reopened.init();
    expect(reopened.listGatewayProbeHistory("default", "shared", "one")).toHaveLength(50);
    expect(reopened.listGatewayProbeHistory("work", "shared", "one")).toHaveLength(1);
  });

  it("persists summaries, private cache state and usage by profile", async () => {
    const { store } = await makeStore(backend);
    await store.replaceSessionCaches("default", [sessionCache("one", "default", 1), sessionCache("two", "default", 2)]);
    await store.replaceSessionCaches("work", [sessionCache("three", "work", 3)]);
    expect(store.listSessionSummaries("default").map((summary) => summary.id)).toEqual(["two", "one"]);
    expect(store.listSessionUsage("default").map((usage) => usage.id).sort()).toEqual(["usage-one", "usage-two"]);
    expect(store.getSessionCache("default", "one")?.relativePath).toContain("project/");

    await store.replaceSessionCaches("default", [sessionCache("four", "default", 4)]);
    expect(store.listSessionSummaries("default").map((summary) => summary.id)).toEqual(["four"]);
    expect(store.listSessionSummaries("work").map((summary) => summary.id)).toEqual(["three"]);
  });

  it("removes selected cache, usage and search rows without touching other profiles", async () => {
    const { root, store } = await makeStore(backend);
    await store.replaceSessionCaches("default", [sessionCache("one"), sessionCache("two", "default", 2)]);
    await store.replaceSessionCaches("work", [sessionCache("three", "work", 3)]);
    store.indexSessionMessagesForFts("default", "one", [{ text: "deletionneedle" }]);
    store.indexSessionMessagesForFts("default", "two", [{ text: "deletionneedle" }]);
    store.indexSessionMessagesForFts("work", "one", [{ text: "deletionneedle" }]);
    expect(store.hasSessionCache("default", "one")).toBe(true);
    expect(store.hasSessionCache("work", "one")).toBe(false);
    if (backend === "auto") {
      expect(store.activeBackend).toBe("sqlite");
      expect(store.searchSessionFts("default", "deletionneedle")).toHaveLength(2);
    }
    await store.removeSessions("default", ["one", "one", "three", "missing"]);
    expect(store.hasSessionCache("default", "one")).toBe(false);
    expect(store.hasSessionCache("default", "two")).toBe(true);
    expect(store.listSessionUsage("default").map((usage) => usage.sessionId)).toEqual(["two"]);
    expect(store.listSessionSummaries("work").map((summary) => summary.id)).toEqual(["three"]);
    expect(store.hasIndexedSession("default", "one")).toBe(false);
    if (backend === "auto") {
      expect(store.searchSessionFts("default", "deletionneedle").map((row) => row.sessionId)).toEqual(["two"]);
      expect(store.searchSessionFts("work", "deletionneedle").map((row) => row.sessionId)).toEqual(["one"]);
    } else {
      expect(store.searchSessionFts("default", "deletionneedle")).toEqual([]);
    }
    store.close();
    const reopened = new MetadataStore(root, { backend });
    await reopened.init();
    openStores.push(reopened);
    expect(reopened.hasSessionCache("default", "one")).toBe(false);
    expect(reopened.listSessionUsage("default").map((usage) => usage.sessionId)).toEqual(["two"]);
    expect(reopened.hasSessionCache("work", "three")).toBe(true);
  });

  it("rolls back cache, usage and FTS removal together on SQLite failure", async () => {
    if (backend !== "auto") return;
    const { root, store } = await makeStore(backend);
    expect(store.activeBackend).toBe("sqlite");
    await store.replaceSessionCaches("default", [sessionCache("one")]);
    store.indexSessionMessagesForFts("default", "one", [{ text: "rollbackneedle" }]);
    const db = new SqliteDatabaseSync(path.join(root, "metadata.sqlite"));
    try {
      db.exec("CREATE TRIGGER reject_session_delete BEFORE DELETE ON session_cache BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;");
      await expect(store.removeSessions("default", ["one"])).rejects.toThrow("delete blocked");
      expect(store.hasSessionCache("default", "one")).toBe(true);
      expect(store.listSessionUsage("default").map((usage) => usage.sessionId)).toEqual(["one"]);
      expect(store.searchSessionFts("default", "rollbackneedle").map((row) => row.sessionId)).toEqual(["one"]);
      db.exec("DROP TRIGGER reject_session_delete");
      await store.removeSessions("default", ["one"]);
      expect(store.hasSessionCache("default", "one")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("stores preferences of every JSON shape", async () => {
    const { store } = await makeStore(backend);
    expect(store.getPreference("missing")).toBeUndefined();
    await store.setPreference("catalog.refresh", 46999);
    await store.setPreference("catalog.entries", [{ id: "custom" }]);
    await store.setPreference("catalog.refresh", 47000);
    expect(store.getPreference<number>("catalog.refresh")).toBe(47000);
    expect(store.getPreference<Array<{ id: string }>>("catalog.entries")).toEqual([{ id: "custom" }]);
  });

  it("merges concurrent preference updates against the latest durable value", async () => {
    const { root, store } = await makeStore(backend);
    type Prices = Record<string, { input: number }>;
    const update = (key: string, input: number) => store.updatePreference<Prices>("usage.pricing", (current) => {
      const prices = current ?? {};
      prices[key] = { input };
      return prices;
    });
    await Promise.all([update("review/one", 1), update("review/two", 2)]);
    const expected = { "review/one": { input: 1 }, "review/two": { input: 2 } };
    expect(store.getPreference("usage.pricing")).toEqual(expected);
    const reopened = new MetadataStore(root, { backend });
    await reopened.init();
    openStores.push(reopened);
    expect(reopened.getPreference("usage.pricing")).toEqual(expected);
  });

  it.runIf(backend === "json")("discards a failed mutable preference update before applying the next queued update", async () => {
    const { root, store } = await makeStore(backend);
    const initial = { nested: { retained: true }, keys: ["original"] };
    await store.setPreference("review.update", initial);
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("preference replacement failed"));
    const failure = store.updatePreference<typeof initial>("review.update", (current) => {
      current!.nested.retained = false;
      current!.keys.push("failed");
      return current!;
    });
    const next = store.updatePreference<typeof initial>("review.update", (current) => {
      current!.keys.push("accepted");
      return current!;
    });
    try {
      await expect(failure).rejects.toThrow("preference replacement failed");
      await next;
    } finally {
      rename.mockRestore();
    }
    const expected = { nested: { retained: true }, keys: ["original", "accepted"] };
    expect(store.getPreference("review.update")).toEqual(expected);
    const reopened = new MetadataStore(root, { backend });
    await reopened.init();
    openStores.push(reopened);
    expect(reopened.getPreference("review.update")).toEqual(expected);
  });

  it("survives a reopen of the same directory", async () => {
    const { root, store } = await makeStore(backend);
    await store.setGatewayListenerPort("default", 46123);
    await store.replaceSessionCaches("default", [sessionCache("one")]);

    const reopened = new MetadataStore(root, { backend });
    await reopened.init();
    openStores.push(reopened);
    expect(reopened.getGatewayListenerSettings("default")).toEqual({ port: 46123, conflictingPorts: [] });
    expect(reopened.listSessionSummaries("default").map((summary) => summary.id)).toEqual(["one"]);
  });
});

describe("MetadataStore migration", () => {
  it.each(["gatewayPools", "gatewayProbeHistory"] as const)("rejects null %s migration records without replacing unrelated disk state", async (key) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-invalid-migration-"));
    tempRoots.push(root);
    const target = path.join(root, "metadata.sqlite.json");
    const original = JSON.stringify({
      version: 3, providerLabels: { openai: "Preserved" },
      snapshots: [{ id: "snapshot", profile: "work", createdAt: "2026-11-04T00:00:00Z" }],
      gatewayPools: [pool("owned", "work")], gatewayProbeHistory: [], sessionCaches: [],
      preferences: { unrelated: { retained: true } }, [key]: [null],
    });
    await fs.writeFile(target, original, "utf8");
    const store = new MetadataStore(root, { backend: "json" });
    openStores.push(store);
    await expect(store.init()).rejects.toThrow(`Invalid metadata ${key}: expected object records`);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    await expect(store.init()).rejects.toThrow(`Invalid metadata ${key}: expected object records`);
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });

  it("rolls back listener settings, pool port removal and obsolete preferences together", async () => {
    const { root, store } = await makeStore("auto");
    store.close();
    const databasePath = path.join(root, "metadata.sqlite");
    const legacy = { ...pool("legacy", "work"), port: 47011 };
    const database = new SqliteDatabaseSync(databasePath);
    try {
      database.prepare("INSERT INTO gateway_pools VALUES (?, ?, ?)").run(legacy.id, legacy.profile, JSON.stringify(legacy));
      database.prepare("INSERT INTO preferences VALUES (?, ?)").run("gateway.port", "49000");
      database.exec("CREATE TRIGGER reject_listener_settings BEFORE INSERT ON preferences WHEN NEW.key LIKE 'gateway.listener.%' BEGIN SELECT RAISE(ABORT, 'listener migration blocked'); END;");
    } finally {
      database.close();
    }
    const migrating = new MetadataStore(root);
    openStores.push(migrating);
    await expect(migrating.init()).rejects.toThrow("listener migration blocked");
    const preserved = new SqliteDatabaseSync(databasePath);
    try {
      expect(preserved.prepare("SELECT payload FROM gateway_pools").all()).toEqual([{ payload: JSON.stringify(legacy) }]);
      expect(preserved.prepare("SELECT key, payload FROM preferences").all()).toEqual([{ key: "gateway.port", payload: "49000" }]);
      preserved.exec("DROP TRIGGER reject_listener_settings");
    } finally {
      preserved.close();
    }
    await migrating.init();
    expect(migrating.getGatewayListenerSettings("work")).toEqual({ port: 47011, conflictingPorts: [] });
    expect(migrating.listGatewayPools("work")).toEqual([pool("legacy", "work")]);
    expect(migrating.getPreference("gateway.port")).toBeUndefined();
  });

  it("propagates JSON migration write failures without emptying loaded state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-json-write-failure-"));
    tempRoots.push(root);
    const target = path.join(root, "metadata.sqlite.json");
    const legacy = { id: "legacy", poolId: "owned", upstreamId: "one", timestamp: "2026-08-24T00:00:00Z", ok: true, latencyMs: 20 };
    const original = JSON.stringify({ version: 3, providerLabels: { openai: "Preserved" }, snapshots: [], gatewayPools: [{ ...pool("owned", "work"), port: 47011 }], gatewayProbeHistory: [legacy], sessionCaches: [], preferences: { "gateway.port": 46001 } });
    await fs.writeFile(target, original, "utf8");
    const store = new MetadataStore(root, { backend: "json" });
    openStores.push(store);
    const failure = new Error("Migration rename failed");
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    try {
      await expect(store.init()).rejects.toBe(failure);
    } finally {
      rename.mockRestore();
    }
    expect(store.listGatewayPools("work")).toEqual([pool("owned", "work")]);
    expect(store.getProviderLabels()).toEqual({ openai: "Preserved" });
    expect(store.getPreference("gateway.port")).toBeUndefined();
    expect(store.getGatewayListenerSettings("work")).toEqual({ port: 47011, conflictingPorts: [] });
    expect(store.listGatewayProbeHistory("work")).toEqual([{ ...legacy, profile: "work" }]);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    await store.init();
    const persisted = JSON.parse(await fs.readFile(target, "utf8"));
    expect(persisted.gatewayProbeHistory).toEqual([{ ...legacy, profile: "work" }]);
    expect(persisted.providerLabels).toEqual({ openai: "Preserved" });
    expect(persisted.gatewayPools).toEqual([pool("owned", "work")]);
    expect(persisted.preferences["gateway.listener.work"]).toEqual({ port: 47011, conflictingPorts: [] });
  });

  it("transactionally upgrades the legacy SQLite pool key without losing data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-gateway-key-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "metadata.sqlite");
    const database = new SqliteDatabaseSync(databasePath);
    database.exec("CREATE TABLE gateway_pools (id TEXT PRIMARY KEY, profile TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE gateway_probe_history (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);");
    database.prepare("INSERT INTO gateway_pools VALUES (?, ?, ?)").run("shared", "default", JSON.stringify(pool("shared")));
    const legacy = { id: "legacy", poolId: "shared", upstreamId: "one", timestamp: "2026-08-24T00:00:00Z", ok: true, latencyMs: 20 };
    database.prepare("INSERT INTO gateway_probe_history VALUES (?, ?, ?, ?, ?)").run(legacy.id, legacy.poolId, legacy.upstreamId, legacy.timestamp, JSON.stringify(legacy));
    database.close();
    const store = new MetadataStore(root);
    openStores.push(store);
    await store.init();
    expect(store.activeBackend).toBe("sqlite");
    expect(store.listGatewayPools("default")).toEqual([pool("shared")]);
    expect(store.listGatewayProbeHistory("default")).toEqual([{ ...legacy, profile: "default" }]);
    await store.saveGatewayPool(pool("shared", "work"));
    await store.setProviderLabel("openai", "Preserved");
    store.close();
    await store.init();
    await store.init();
    expect(store.listGatewayPools()).toHaveLength(2);
    expect(store.getProviderLabels()).toEqual({ openai: "Preserved" });
    expect(store.getGatewayHealth("default")["shared:one"].healthState).toBe("healthy");
    expect(store.getGatewayHealth("work")).toEqual({});
  });

  it.each(["auto", "json"] as const)("migrates %s legacy probe ownership only when unique and preserves unresolved rows", async (backend) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-gateway-owner-"));
    tempRoots.push(root);
    const pools = [pool("owned", "work"), pool("shared"), pool("shared", "work")];
    const records = ["owned", "shared", "orphan"].map((poolId) => ({ id: poolId, poolId, upstreamId: "one", timestamp: "2026-08-24T00:00:00Z", ok: true, latencyMs: 20 }));
    const cache = sessionCache("preserved", "work");
    const snapshot = { id: "snapshot", profile: "work", createdAt: "2026-08-24T00:00:00Z" };
    if (backend === "json") {
      await fs.writeFile(path.join(root, "metadata.sqlite.json"), JSON.stringify({
        version: 3, providerLabels: { openai: "Preserved" }, snapshots: [snapshot], gatewayPools: pools,
        gatewayProbeHistory: records, sessionCaches: [cache], preferences: { "gateway.port": 46001 },
      }), "utf8");
    } else {
      const database = new SqliteDatabaseSync(path.join(root, "metadata.sqlite"));
      database.exec("CREATE TABLE gateway_pools (id TEXT NOT NULL, profile TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile, id)); CREATE TABLE gateway_probe_history (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE provider_meta (provider_id TEXT PRIMARY KEY, label TEXT NOT NULL); CREATE TABLE preferences (key TEXT PRIMARY KEY, payload TEXT NOT NULL);");
      for (const item of pools) database.prepare("INSERT INTO gateway_pools VALUES (?, ?, ?)").run(item.id, item.profile, JSON.stringify(item));
      for (const item of records) database.prepare("INSERT INTO gateway_probe_history VALUES (?, ?, ?, ?, ?)").run(item.id, item.poolId, item.upstreamId, item.timestamp, JSON.stringify(item));
      database.prepare("INSERT INTO provider_meta VALUES (?, ?)").run("openai", "Preserved");
      database.prepare("INSERT INTO preferences VALUES (?, ?)").run("gateway.port", "46001");
      database.close();
    }
    const store = new MetadataStore(root, { backend });
    openStores.push(store);
    await store.init();
    expect(store.activeBackend).toBe(backend === "auto" ? "sqlite" : "json");
    if (backend === "auto") {
      await store.replaceSessionCaches("work", [cache]);
      await store.addSnapshot(snapshot);
    }
    for (let round = 0; round < 2; round++) {
      expect(store.listGatewayPools()).toHaveLength(round === 0 ? 3 : 4);
      expect(store.listGatewayProbeHistory("work")).toEqual([{ ...records[0], profile: "work" }]);
      expect(store.listGatewayProbeHistory("default")).toEqual([]);
      expect(store.getGatewayHealth("work")["owned:one"].healthState).toBe("healthy");
      expect(store.getGatewayHealth("work", "shared")).toEqual({});
      expect(store.getGatewayHealth("default", "shared")).toEqual({});
      expect(store.getGatewayHealth("work", "orphan")).toEqual({});
      expect(store.listGatewayProbeHistory("work", "orphan")).toEqual([]);
      expect(store.getProviderLabels()).toEqual({ openai: "Preserved" });
      expect(store.getPreference("gateway.port")).toBeUndefined();
      expect(store.listSnapshots("work")).toEqual([snapshot]);
      expect(store.getSessionCache("work", cache.id)).toEqual(cache);
      if (round === 0) await store.saveGatewayPool(pool("orphan", "work"));
      store.close();
      await store.init();
      await store.init();
    }
    store.close();
    if (backend === "json") {
      const persisted = JSON.parse(await fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8"));
      expect(persisted.gatewayProbeHistory).toEqual([{ ...records[0], profile: "work" }, { ...records[1], profile: "" }, { ...records[2], profile: "" }]);
    } else {
      const database = new SqliteDatabaseSync(path.join(root, "metadata.sqlite"));
      const rows = database.prepare("SELECT profile, payload FROM gateway_probe_history ORDER BY id").all() as Array<{ profile: string | null; payload: string }>;
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.profile === "").map((row) => JSON.parse(row.payload))).toEqual([{ ...records[2], profile: "" }, { ...records[1], profile: "" }]);
      database.close();
    }
  });

  it("rolls back SQLite gateway migration failures instead of silently opening JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-gateway-failure-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "metadata.sqlite");
    const database = new SqliteDatabaseSync(databasePath);
    database.exec("CREATE TABLE gateway_pools (id TEXT PRIMARY KEY, profile TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE gateway_probe_history (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, upstream_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);");
    database.prepare("INSERT INTO gateway_pools VALUES (?, ?, ?)").run("owned", "work", JSON.stringify(pool("owned", "work")));
    database.prepare("INSERT INTO gateway_probe_history VALUES (?, ?, ?, ?, ?)").run("bad", "owned", "one", "2026-08-24T00:00:00Z", "invalid JSON");
    database.close();
    const store = new MetadataStore(root);
    openStores.push(store);
    await expect(store.init()).rejects.toThrow();
    const preserved = new SqliteDatabaseSync(databasePath);
    try {
      expect(preserved.prepare("SELECT payload FROM gateway_pools").all()).toEqual([{ payload: JSON.stringify(pool("owned", "work")) }]);
      expect(preserved.prepare("SELECT payload FROM gateway_probe_history").all()).toEqual([{ payload: "invalid JSON" }]);
      const columns = preserved.prepare("PRAGMA table_info(gateway_pools)").all() as Array<{ name: string; pk: number }>;
      expect(columns.find((column) => column.name === "profile")?.pk).toBe(0);
      expect((preserved.prepare("PRAGMA table_info(gateway_probe_history)").all() as Array<{ name: string }>).some((column) => column.name === "profile")).toBe(false);
    } finally {
      preserved.close();
    }
    await expect(fs.stat(path.join(root, "metadata.sqlite.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("upgrades a legacy JSON cache without retaining event paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-legacy-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "metadata.sqlite.json"), JSON.stringify({
      version: 2,
      providerLabels: { openai: "OpenAI" },
      preferences: { "gateway.port": 46831 },
      sessionIndex: [{ filePath: "C:/sensitive/session.jsonl", offset: 0 }],
    }), "utf8");
    const store = new MetadataStore(root, { backend: "json" });
    await store.init();
    openStores.push(store);
    expect(store.getProviderLabels()).toEqual({ openai: "OpenAI" });
    expect(store.getPreference("gateway.port")).toBeUndefined();
    expect(store.listSessionCaches("default")).toEqual([]);
    await expect(fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8")).resolves.not.toContain("C:/sensitive");
  });

  it("uses the JSON file when the fallback is forced", async () => {
    const { root, store } = await makeStore("json");
    expect(store.activeBackend).toBe("json");
    await store.setGatewayListenerPort("default", 46001);
    await expect(fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8")).resolves.toContain("46001");
  });

  it("removes obsolete message offsets from a current JSON cache", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-offset-json-"));
    tempRoots.push(root);
    const legacy = { ...sessionCache("one"), messageOffsets: [{ id: "message-one", offset: 0, length: 100 }] };
    await fs.writeFile(path.join(root, "metadata.sqlite.json"), JSON.stringify({
      version: 3,
      providerLabels: {},
      snapshots: [],
      gatewayPools: [],
      sessionCaches: [legacy],
      preferences: {},
    }), "utf8");
    const store = new MetadataStore(root, { backend: "json" });
    await store.init();
    openStores.push(store);

    expect(store.getSessionCache("default", "one")).toBeDefined();
    await expect(fs.readFile(path.join(root, "metadata.sqlite.json"), "utf8")).resolves.not.toContain("messageOffsets");
  });

  it("removes obsolete message offsets and event tables from SQLite", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metadata-offset-sqlite-"));
    tempRoots.push(root);
    const { DatabaseSync } = await import("node:sqlite");
    const databasePath = path.join(root, "metadata.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE session_cache (id TEXT PRIMARY KEY, profile TEXT NOT NULL, relative_path TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE session_index (id TEXT PRIMARY KEY);");
    const { usage: _usage, ...payload } = sessionCache("one");
    database.prepare("INSERT INTO session_cache(id, profile, relative_path, payload) VALUES(?, ?, ?, ?)").run(
      payload.id,
      payload.profile,
      payload.relativePath,
      JSON.stringify({ ...payload, messageOffsets: [{ id: "message-one", offset: 0, length: 100 }] }),
    );
    database.close();

    const store = new MetadataStore(root, { backend: "auto" });
    await store.init();
    expect(store.activeBackend).toBe("sqlite");
    expect(store.getSessionCache("default", "one")).toBeDefined();
    store.close();

    const verify = new DatabaseSync(databasePath);
    const row = verify.prepare("SELECT payload FROM session_cache WHERE id = ?").get("one") as { payload: string };
    expect(JSON.parse(row.payload)).not.toHaveProperty("messageOffsets");
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_index'").get()).toBeUndefined();
    verify.close();
  });

  it("persists gateway probe history and computes health state across backends", async () => {
    for (const backend of ["auto", "json"] as const) {
      const { store } = await makeStore(backend);
      await store.recordGatewayProbe({
        profile: "default",
        poolId: "pool-1",
        upstreamId: "up-1",
        timestamp: "2026-08-24T08:00:00.000Z",
        ok: true,
        status: 200,
        latencyMs: 150,
      });
      await store.recordGatewayProbe({
        profile: "default",
        poolId: "pool-1",
        upstreamId: "up-1",
        timestamp: "2026-08-24T08:01:00.000Z",
        ok: true,
        status: 200,
        latencyMs: 120,
      });
      await store.recordGatewayProbe({
        profile: "default",
        poolId: "pool-1",
        upstreamId: "up-2",
        timestamp: "2026-08-24T08:02:00.000Z",
        ok: false,
        status: 500,
        latencyMs: 3200,
        error: "HTTP 500",
      });

      const history = store.listGatewayProbeHistory("default", "pool-1");
      expect(history).toHaveLength(3);

      const health = store.getGatewayHealth("default", "pool-1");
      expect(health["pool-1:up-1"]).toBeDefined();
      expect(health["pool-1:up-1"].healthState).toBe("healthy");
      expect(health["pool-1:up-1"].lastLatencyMs).toBe(120);

      expect(health["pool-1:up-2"]).toBeDefined();
      expect(health["pool-1:up-2"].healthState).toBe("unhealthy");
      expect(health["pool-1:up-2"].consecutiveFailures).toBe(1);
    }
  });

  it("indexes session messages and performs FTS full-text search with snippets", async () => {
    const { store } = await makeStore("auto");
    store.indexSessionMessagesForFts("default", "session-1", [
      { role: "user", text: "How do I fix Docker container port conflict in production?" },
      { role: "assistant", text: "To resolve the port conflict, edit docker-compose.yml and bind to an unused host port like 8080:80." },
    ]);
    store.indexSessionMessagesForFts("default", "session-2", [
      { role: "user", text: "Show me how to write a Rust macro" },
      { role: "assistant", text: "Rust macros are defined using macro_rules! syntax." },
    ]);

    const results = store.searchSessionFts("default", "docker conflict");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.sessionId).toBe("session-1");
    expect(results[0]?.snippet).toContain("<mark>");

    const empty = store.searchSessionFts("default", "nonexistentquery12345");
    expect(empty).toHaveLength(0);
  });
});
