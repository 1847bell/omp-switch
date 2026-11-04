import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatewayPool } from "@omp-switch/core";
import { MetadataStore } from "./metadata-store";
import { GatewayConfigCoordinator } from "./gateway-config";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: http.Server): Promise<number> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

async function fixture(backend: "auto" | "json") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-config-"));
  const store = new MetadataStore(root, { backend });
  await store.init();
  cleanups.push(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ route: request.url, model: JSON.parse(Buffer.concat(chunks).toString()).model,
      authorization: request.headers.authorization, owner: request.headers["x-owner"] }));
  });
  const upstreamPort = await listen(upstream);
  cleanups.push(async () => { const closed = once(upstream, "close"); upstream.close(); await closed; });
  const reservation = http.createServer();
  const port = await listen(reservation);
  const released = once(reservation, "close");
  reservation.close();
  await released;
  const baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const controls = {
    tokenError: false, resolverError: false, revision: "original",
    beforeResolve: undefined as (() => Promise<void>) | undefined,
  };
  const config = new GatewayConfigCoordinator({
    loadToken: async () => {
      if (controls.tokenError) throw new Error("token failed");
      return "test-token";
    },
    resolveForwarder: async (profile) => {
      if (controls.resolverError) throw new Error("resolver failed");
      const revision = controls.revision;
      const beforeResolve = controls.beforeResolve;
      return { resolve: async (target) => {
        await beforeResolve?.();
        return { baseUrl: `${baseUrl}/${profile}/${revision}/${target.providerId}`, apiKey: `${profile}-${revision}-key`, headers: { "x-owner": `${profile}-${revision}` } };
      } };
    },
  });
  cleanups.push(() => config.stop(config.status().profileId ?? "alpha"));
  const pool: GatewayPool = {
    id: "shared", profile: "alpha", virtualModel: "virtual/original", port, enabled: true,
    upstreams: [
      { id: "one", providerId: "first", modelId: "model-one", kind: "secret", credentialId: "cred", enabled: true },
      { id: "two", providerId: "second", modelId: "model-two", kind: "secret", credentialId: "cred", enabled: true },
    ],
  };
  await config.save(store, pool);
  const start = () => config.start(store, "alpha");
  const stop = () => config.stop("alpha");
  const request = (model: string) => {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
    });
  };
  const models = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer test-token" } });
    return response.json() as Promise<{ data: Array<{ id: string }> }>;
  };
  return { root, store, config, pool, start, stop, request, models, controls };
}

describe.each(["auto", "json"] as const)("production gateway save boundary (%s)", (backend) => {
  it("applies virtual rename, upstream target, order and enable changes to the next HTTP request", async () => {
    const { store, config, pool, start, request, models } = await fixture(backend);
    await start();
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ route: "/alpha/original/first/v1/chat/completions", model: "model-one" });
    const renamed = { ...pool, virtualModel: "virtual/renamed" };
    await config.save(store, renamed);
    expect((await request(pool.virtualModel)).status).toBe(404);
    expect((await models()).data.map((entry) => entry.id)).toEqual([renamed.virtualModel]);
    expect((await request(renamed.virtualModel)).status).toBe(200);
    const reordered = { ...renamed, upstreams: [pool.upstreams[1], pool.upstreams[0]] };
    await config.save(store, reordered);
    expect(await (await request(renamed.virtualModel)).json()).toMatchObject({ route: "/alpha/original/second/v1/chat/completions", model: "model-two" });
    const disabledFirst = { ...reordered, upstreams: reordered.upstreams.map((target, index) => ({ ...target, enabled: index !== 0 })) };
    await config.save(store, disabledFirst);
    expect(await (await request(renamed.virtualModel)).json()).toMatchObject({ route: "/alpha/original/first/v1/chat/completions", model: "model-one" });
    await config.save(store, { ...disabledFirst, upstreams: [{ ...pool.upstreams[1], modelId: "replacement-model" }] });
    expect(await (await request(renamed.virtualModel)).json()).toMatchObject({ route: "/alpha/original/second/v1/chat/completions", model: "replacement-model" });
  });

  it("keeps listening with no enabled pools and re-enables the last pool without restarting", async () => {
    const { store, config, pool, start, request, models } = await fixture(backend);
    await start();
    await config.save(store, { ...pool, enabled: false });
    expect(config.status().running).toBe(true);
    expect((await models()).data).toEqual([]);
    expect((await request(pool.virtualModel)).status).toBe(404);
    await config.save(store, pool);
    expect((await request(pool.virtualModel)).status).toBe(200);
  });

  it("isolates other-profile saves and does not start a stopped gateway", async () => {
    const { store, config, pool, start, stop, request } = await fixture(backend);
    await config.save(store, { ...pool, virtualModel: "virtual/stopped" });
    expect(config.status().running).toBe(false);
    await start();
    await config.save(store, { ...pool, profile: "beta", virtualModel: "virtual/other", port: 46832 });
    expect((await request("virtual/stopped")).status).toBe(200);
    expect((await request("virtual/other")).status).toBe(404);
    expect(store.listGatewayPools("beta")[0].virtualModel).toBe("virtual/other");
    await stop();
    await config.save(store, { ...pool, virtualModel: "virtual/after-stop" });
    expect(config.status().running).toBe(false);
    expect(store.listGatewayPools("alpha")[0].virtualModel).toBe("virtual/after-stop");
  });

  it("rejects an active port edit before persistence and keeps current routes", async () => {
    const { store, config, pool, start, request } = await fixture(backend);
    await start();
    const port = pool.port === 65535 ? 65534 : pool.port + 1;
    await expect(config.save(store, { ...pool, port, virtualModel: "virtual/rejected" })).rejects.toThrow(/stop.*port/i);
    expect(store.listGatewayPools("alpha")[0]).toEqual(pool);
    expect((await request(pool.virtualModel)).status).toBe(200);
    expect((await request("virtual/rejected")).status).toBe(404);
    await config.save(store, { ...pool, virtualModel: "virtual/accepted" });
    expect((await request("virtual/accepted")).status).toBe(200);
  });

  it.each([true, false])("rejects duplicate upstream IDs before persistence even when enabled=%s", async (enabled) => {
    const { store, config, pool, start, request } = await fixture(backend);
    await start();
    const duplicate = { ...pool, virtualModel: "virtual/rejected-duplicate", upstreams: [pool.upstreams[0], { ...pool.upstreams[1], id: pool.upstreams[0].id, enabled }] };
    await expect(config.save(store, duplicate)).rejects.toThrow(/duplicate.*one/i);
    expect(store.listGatewayPools("alpha")[0]).toEqual(pool);
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ model: "model-one" });
    expect((await request(duplicate.virtualModel)).status).toBe(404);
  });

  it("serializes concurrent saves with start and stop without stale routes or resurrection", async () => {
    const { store, config, pool, start, stop, request } = await fixture(backend);
    const starting = start();
    const savedDuringStart = config.save(store, pool);
    await Promise.all([starting, savedDuringStart]);
    expect((await request(pool.virtualModel)).status).toBe(200);
    await Promise.all([
      config.save(store, { ...pool, virtualModel: "virtual/second" }),
      config.save(store, { ...pool, virtualModel: "virtual/latest" }),
    ]);
    expect((await request(pool.virtualModel)).status).toBe(404);
    expect((await request("virtual/second")).status).toBe(404);
    expect((await request("virtual/latest")).status).toBe(200);
    await Promise.all([stop(), config.save(store, { ...pool, virtualModel: "virtual/stopped-latest" })]);
    expect(config.status().running).toBe(false);
    expect(store.listGatewayPools("alpha")[0].virtualModel).toBe("virtual/stopped-latest");
  });
});

describe.each(["auto", "json"] as const)("gateway lifecycle ownership (%s)", (backend) => {
  it("persists request history before stop completes", async () => {
    const { root, store, pool, start, stop, request } = await fixture(backend);
    await start();
    const response = await request(pool.virtualModel);
    expect(response.status).toBe(200);
    await response.text();
    await stop();
    store.close();
    const reopened = new MetadataStore(root, { backend });
    await reopened.init();
    try {
      expect(reopened.listGatewayProbeHistory("alpha", pool.id, "one")).toEqual([
        expect.objectContaining({ profile: "alpha", poolId: pool.id, upstreamId: "one", ok: true, status: 200 }),
      ]);
    } finally {
      reopened.close();
    }
  });

  it("switches shared IDs both ways and reloads same-profile resolver, key and headers", async () => {
    const { store, config, pool, start, request, controls } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta" });
    await start();
    for (const profile of ["alpha", "beta", "alpha"]) {
      expect(await config.start(store, profile)).toEqual({ running: true, profileId: profile, port: pool.port, token: "test-token" });
      expect(await (await request(pool.virtualModel)).json()).toMatchObject({
        route: `/${profile}/original/first/v1/chat/completions`, authorization: `Bearer ${profile}-original-key`, owner: `${profile}-original`,
      });
      expect(config.status()).toMatchObject({ running: true, profileId: profile, port: pool.port });
    }
    controls.revision = "reloaded";
    await start();
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({
      route: "/alpha/reloaded/first/v1/chat/completions", authorization: "Bearer alpha-reloaded-key", owner: "alpha-reloaded",
    });
    await config.start(store, "beta");
    await expect(config.stop("alpha")).rejects.toThrow(/stale stop/i);
    expect(config.status().profileId).toBe("beta");
    await config.stop("beta");
    expect(config.status()).toEqual({ running: false, profileId: null, port: null, upstreams: [] });
  });

  it("preserves alpha routes and ownership on resolver, token, preference and port failures", async () => {
    const { store, config, pool, start, request, controls } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta" });
    await start();
    await expect(config.start(store, "missing")).rejects.toThrow(/no enabled gateway pools/i);
    controls.resolverError = true;
    await expect(config.start(store, "beta")).rejects.toThrow("resolver failed");
    controls.resolverError = false;
    controls.tokenError = true;
    await expect(config.start(store, "beta")).rejects.toThrow("token failed");
    controls.tokenError = false;
    const preference = vi.spyOn(store, "setPreference").mockRejectedValueOnce(new Error("preference failed"));
    await expect(config.start(store, "beta")).rejects.toThrow("preference failed");
    preference.mockRestore();
    await config.save(store, { ...pool, profile: "beta", port: pool.port === 65535 ? 65534 : pool.port + 1 });
    await expect(config.start(store, "beta")).rejects.toThrow(/stop.*port/i);
    expect(config.status()).toMatchObject({ running: true, profileId: "alpha", port: pool.port });
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ route: "/alpha/original/first/v1/chat/completions", owner: "alpha-original" });
  });

  it("does not claim ownership after initial bind or preference failure", async () => {
    const { store, config, pool, start } = await fixture(backend);
    const occupied = http.createServer();
    const listening = once(occupied, "listening");
    occupied.listen(pool.port, "127.0.0.1");
    await listening;
    try {
      await expect(start()).rejects.toThrow();
      expect(config.status()).toEqual({ running: false, profileId: null, port: null, upstreams: [] });
    } finally {
      const closed = once(occupied, "close"); occupied.close(); await closed;
    }
    const preference = vi.spyOn(store, "setPreference").mockRejectedValueOnce(new Error("preference failed"));
    await expect(start()).rejects.toThrow("preference failed");
    preference.mockRestore();
    expect(config.status()).toEqual({ running: false, profileId: null, port: null, upstreams: [] });
    await start();
    expect(config.status().profileId).toBe("alpha");
  });

  it("keeps delayed alpha resolver and history ownership without repopulating beta stats", async () => {
    const { store, config, pool, start, request, controls } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta" });
    const gate = new EventEmitter();
    const entered = once(gate, "entered");
    controls.beforeResolve = async () => {
      const released = once(gate, "released");
      gate.emit("entered");
      await released;
    };
    await start();
    const pending = request(pool.virtualModel);
    await entered;
    controls.beforeResolve = undefined;
    await config.start(store, "beta");
    gate.emit("released");
    expect(await (await pending).json()).toMatchObject({ route: "/alpha/original/first/v1/chat/completions", owner: "alpha-original" });
    expect(config.status().upstreams).toEqual([]);
    expect(store.listGatewayProbeHistory("alpha", pool.id, "one")).toEqual([
      expect.objectContaining({ profile: "alpha", poolId: pool.id, upstreamId: "one", status: 200 }),
    ]);
    expect(store.listGatewayProbeHistory("beta", pool.id)).toEqual([]);
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ owner: "beta-original" });
    expect(config.status().upstreams).toHaveLength(1);
  });
});
