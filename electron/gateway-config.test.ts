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

async function unusedPort(): Promise<number> {
  const reservation = http.createServer();
  const port = await listen(reservation);
  const released = once(reservation, "close");
  reservation.close();
  await released;
  return port;
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
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const controls = {
    tokenError: false, resolverError: false, revision: "original",
    token: "test-token",
    beforeResolve: undefined as (() => Promise<void>) | undefined,
  };
  const config = new GatewayConfigCoordinator({
    loadToken: async () => {
      if (controls.tokenError) throw new Error("token failed");
      return controls.token;
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
    id: "shared", profile: "alpha", virtualModel: "virtual/original", enabled: true,
    upstreams: [
      { id: "one", providerId: "first", modelId: "model-one", kind: "secret", credentialId: "cred", enabled: true },
      { id: "two", providerId: "second", modelId: "model-two", kind: "secret", credentialId: "cred", enabled: true },
    ],
  };
  await config.save(store, pool);
  await config.setPort(store, "alpha", port);
  await config.setPort(store, "beta", port);
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
  return { root, store, config, pool, port, start, stop, request, models, controls };
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
    const allDisabled = { ...renamed, upstreams: pool.upstreams.map((target) => ({ ...target, enabled: false })) };
    await config.save(store, allDisabled);
    expect((await request(renamed.virtualModel)).status).toBe(503);
    expect(config.status().upstreams).toEqual([]);
    await config.save(store, { ...allDisabled, upstreams: [pool.upstreams[1]] });
    expect(await (await request(renamed.virtualModel)).json()).toMatchObject({ model: "model-two" });
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
    await config.save(store, { ...pool, profile: "beta", virtualModel: "virtual/other" });
    expect((await request("virtual/stopped")).status).toBe(200);
    expect((await request("virtual/other")).status).toBe(404);
    expect(store.listGatewayPools("beta")[0].virtualModel).toBe("virtual/other");
    await stop();
    await config.save(store, { ...pool, virtualModel: "virtual/after-stop" });
    expect(config.status().running).toBe(false);
    expect(store.listGatewayPools("alpha")[0].virtualModel).toBe("virtual/after-stop");
  });

  it("rejects an active port edit before persistence and keeps current routes", async () => {
    const { store, config, pool, port, start, request } = await fixture(backend);
    await start();
    const nextPort = port === 65535 ? 65534 : port + 1;
    await expect(config.setPort(store, "alpha", nextPort)).rejects.toThrow(/stop.*port/i);
    expect(store.getGatewayListenerSettings("alpha").port).toBe(port);
    expect(config.status().port).toBe(port);
    expect((await request(pool.virtualModel)).status).toBe(200);
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
    const { store, config, pool, port, start, request, controls } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta" });
    await start();
    for (const profile of ["alpha", "beta", "alpha"]) {
      expect(await config.start(store, profile)).toEqual({ running: true, profileId: profile, port, token: "test-token" });
      expect(await (await request(pool.virtualModel)).json()).toMatchObject({
        route: `/${profile}/original/first/v1/chat/completions`, authorization: `Bearer ${profile}-original-key`, owner: `${profile}-original`,
      });
      expect(config.status()).toMatchObject({ running: true, profileId: profile, port });
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

  it("preserves alpha routes and ownership on resolver, token and port failures", async () => {
    const { store, config, pool, port, start, request, controls } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta" });
    await start();
    await expect(config.start(store, "missing")).rejects.toThrow(/no enabled gateway pools/i);
    controls.resolverError = true;
    await expect(config.start(store, "beta")).rejects.toThrow("resolver failed");
    controls.resolverError = false;
    controls.tokenError = true;
    await expect(config.start(store, "beta")).rejects.toThrow("token failed");
    controls.tokenError = false;
    await config.setPort(store, "beta", port === 65535 ? 65534 : port + 1);
    await expect(config.start(store, "beta")).rejects.toThrow(/stop.*port/i);
    expect(config.status()).toMatchObject({ running: true, profileId: "alpha", port });
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ route: "/alpha/original/first/v1/chat/completions", owner: "alpha-original" });
  });

  it("does not claim ownership after an initial bind failure", async () => {
    const { store, config, port, start } = await fixture(backend);
    const occupied = http.createServer();
    const listening = once(occupied, "listening");
    occupied.listen(port, "127.0.0.1");
    await listening;
    try {
      await expect(start()).rejects.toThrow(new RegExp(`port ${port}.*already in use`, "i"));
      expect(config.status()).toEqual({ running: false, profileId: null, port: null, upstreams: [] });
    } finally {
      const closed = once(occupied, "close"); occupied.close(); await closed;
    }
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

describe.each(["auto", "json"] as const)("gateway connection recovery (%s)", (backend) => {
  it("recovers the accepted runtime token only for its owner without reading a changed token source", async () => {
    const { config, pool, port, start, controls } = await fixture(backend);
    await start();
    controls.token = "unapplied-token";
    controls.tokenError = true;
    controls.resolverError = true;
    const connection = config.status("alpha");
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(response.status).toBe(200);
    const models = await response.json();
    expect(models).toMatchObject({ data: [{ id: pool.virtualModel }] });
    expect(config.status("beta").token).toBeUndefined();
    expect(config.status().token).toBeUndefined();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).not.toContain(connection.token);
    expect(JSON.stringify(models)).not.toContain(connection.token);
  });

  it("keeps the old accepted token on a failed switch and changes it only after a successful owner transition", async () => {
    const { store, config, pool, port, start, controls } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta" });
    await start();
    const original = config.status("alpha").token;
    controls.token = "replacement-token";
    controls.resolverError = true;
    await expect(config.start(store, "beta")).rejects.toThrow("resolver failed");
    const retained = config.status("alpha");
    expect(retained).toMatchObject({ running: true, profileId: "alpha" });
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${retained.token}` } })).status).toBe(200);
    expect(config.status("beta").token).toBeUndefined();
    controls.resolverError = false;
    await config.start(store, "beta");
    const switched = config.status("beta");
    expect(switched).toMatchObject({ running: true, profileId: "beta" });
    expect(config.status("alpha").token).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${switched.token}` } })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${original}` } })).status).toBe(401);
    await config.stop("beta");
    const stopped = config.status("beta");
    expect(stopped.running).toBe(false);
    expect(stopped.token).toBeUndefined();
  });
});

describe.each(["auto", "json"] as const)("profile listener settings (%s)", (backend) => {
  it("serves multiple pools on the configured listener and moves both only after stop", async () => {
    const { store, config, pool, port, start, stop, request, models } = await fixture(backend);
    const second = { ...pool, id: "second", virtualModel: "virtual/second", upstreams: [pool.upstreams[1]] };
    await config.save(store, second);
    expect((await start()).port).toBe(port);
    expect((await models()).data.map((entry) => entry.id).sort()).toEqual([pool.virtualModel, second.virtualModel].sort());
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ model: "model-one" });
    expect(await (await request(second.virtualModel)).json()).toMatchObject({ model: "model-two" });
    await stop();
    const nextPort = await unusedPort();
    await config.setPort(store, "alpha", nextPort);
    expect((await start()).port).toBe(nextPort);
    for (const [model, expected] of [[pool.virtualModel, "model-one"], [second.virtualModel, "model-two"]]) {
      const response = await fetch(`http://127.0.0.1:${nextPort}/v1/chat/completions`, {
        method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ model: expected });
    }
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("requires explicit resolution of conflicting legacy ports before binding", async () => {
    const { store, config, pool, port, start, request } = await fixture(backend);
    await store.setPreference("gateway.listener.alpha", { port: null, conflictingPorts: [port, port === 65535 ? 65534 : port + 1] });
    await expect(start()).rejects.toThrow(/choose and save.*listener port/i);
    expect(config.status().running).toBe(false);
    await config.setPort(store, "alpha", port);
    expect((await start()).port).toBe(port);
    expect((await request(pool.virtualModel)).status).toBe(200);
  });

  it("retains the saved listener on a failed settings write and uses the next successful value", async () => {
    const { store, config, port, start } = await fixture(backend);
    const nextPort = await unusedPort();
    const write = vi.spyOn(store, "setGatewayListenerPort").mockRejectedValueOnce(new Error("port persistence failed"));
    await expect(config.setPort(store, "alpha", nextPort)).rejects.toThrow("port persistence failed");
    expect(store.getGatewayListenerSettings("alpha")).toEqual({ port, conflictingPorts: [] });
    expect(config.status().running).toBe(false);
    write.mockRestore();
    await config.setPort(store, "alpha", nextPort);
    expect((await start()).port).toBe(nextPort);
    const health = await fetch(`http://127.0.0.1:${nextPort}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, pools: 1 });
  });

  it("serializes a port change with start so the listener uses the committed setting", async () => {
    const { store, config, start } = await fixture(backend);
    const nextPort = await unusedPort();
    const [settings, started] = await Promise.all([config.setPort(store, "alpha", nextPort), start()]);
    expect(settings.port).toBe(nextPort);
    expect(started.port).toBe(nextPort);
    const health = await fetch(`http://127.0.0.1:${nextPort}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, pools: 1 });
  });

  it("rejects obsolete per-pool ports rather than silently accepting ignored settings", async () => {
    const { store, config, pool, port, start, request } = await fixture(backend);
    await start();
    const obsolete = { ...pool, port: port === 65535 ? 65534 : port + 1, virtualModel: "virtual/obsolete" };
    await expect(config.save(store, obsolete)).rejects.toThrow(/port.*profile|profile.*port/i);
    expect(store.listGatewayPools("alpha")).toEqual([pool]);
    expect(config.status().port).toBe(port);
    expect((await request(pool.virtualModel)).status).toBe(200);
    expect((await request(obsolete.virtualModel)).status).toBe(404);
  });
});

describe.each(["auto", "json"] as const)("gateway pool deletion (%s)", (backend) => {
  it("removes only the selected Profile route and stats, leaving the last empty listener explicitly stoppable", async () => {
    const { store, config, pool, port, start, stop, request, models } = await fixture(backend);
    const second = { ...pool, id: "second", virtualModel: "virtual/second", upstreams: [pool.upstreams[1]] };
    await config.save(store, second);
    await config.save(store, { ...pool, profile: "beta" });
    await start();
    await (await request(pool.virtualModel)).text();
    await (await request(second.virtualModel)).text();
    await config.delete(store, "beta", pool.id);
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ model: "model-one" });
    await config.delete(store, "alpha", pool.id);
    expect((await request(pool.virtualModel)).status).toBe(404);
    expect((await models()).data.map((entry) => entry.id)).toEqual([second.virtualModel]);
    expect(store.getGatewayHealth("alpha", pool.id)).toEqual({});
    expect(config.status("alpha")).toMatchObject({ running: true, profileId: "alpha", port, token: "test-token",
      upstreams: [expect.objectContaining({ poolId: second.id, upstreamId: "two", lastStatus: 200 })] });
    expect(await (await request(second.virtualModel)).json()).toMatchObject({ model: "model-two" });
    await config.delete(store, "alpha", second.id);
    expect((await models()).data).toEqual([]);
    expect((await request(second.virtualModel)).status).toBe(404);
    expect(config.status("alpha")).toMatchObject({ running: true, port, token: "test-token", upstreams: [] });
    expect(store.getGatewayListenerSettings("alpha").port).toBe(port);
    await stop();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("allows an admitted request to finish without repopulating a deleted and recreated pool's health or stats", async () => {
    const { store, config, pool, start, stop, request, controls } = await fixture(backend);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    controls.beforeResolve = async () => { entered(); await gate; };
    await start();
    const pending = request(pool.virtualModel);
    try {
      await admitted;
      await config.delete(store, "alpha", pool.id);
      await config.save(store, { ...pool, virtualModel: "virtual/recreated", upstreams: [{ ...pool.upstreams[0], modelId: "new-model" }] });
    } finally {
      release();
    }
    expect(await (await pending).json()).toMatchObject({ model: "model-one" });
    expect(store.getGatewayHealth("alpha", pool.id)).toEqual({});
    expect(config.status().upstreams).toEqual([]);
    expect(await (await request("virtual/recreated")).json()).toMatchObject({ model: "new-model" });
    expect(config.status().upstreams).toEqual([expect.objectContaining({ poolId: pool.id, upstreamId: "one", lastStatus: 200 })]);
    await stop();
    expect(store.listGatewayProbeHistory("alpha", pool.id, "one")).toEqual([expect.objectContaining({ ok: true, status: 200 })]);
  });

  it("keeps the saved pool and running route on a failed deletion and permits retry", async () => {
    const { store, config, pool, start, request, models } = await fixture(backend);
    await start();
    const write = vi.spyOn(store, "deleteGatewayPool").mockRejectedValueOnce(new Error("delete persistence failed"));
    await expect(config.delete(store, "alpha", pool.id)).rejects.toThrow("delete persistence failed");
    expect(store.listGatewayPools("alpha")).toEqual([pool]);
    expect((await models()).data.map((entry) => entry.id)).toEqual([pool.virtualModel]);
    expect(await (await request(pool.virtualModel)).json()).toMatchObject({ model: "model-one" });
    write.mockRestore();
    await config.delete(store, "alpha", pool.id);
    expect((await request(pool.virtualModel)).status).toBe(404);
  });

  it("serializes deletion with ownership changes and never starts a listener for stopped deletions", async () => {
    const { store, config, pool, start, request } = await fixture(backend);
    await config.save(store, { ...pool, profile: "beta", virtualModel: "virtual/beta" });
    await start();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deleting = new Promise<void>((resolve) => { entered = resolve; });
    const remove = store.deleteGatewayPool.bind(store);
    const write = vi.spyOn(store, "deleteGatewayPool").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return remove(...args);
    });
    const deletion = config.delete(store, "alpha", pool.id);
    const switching = config.start(store, "beta");
    try {
      await deleting;
      expect(config.status().profileId).toBe("alpha");
      expect((await request(pool.virtualModel)).status).toBe(200);
    } finally {
      release();
    }
    await Promise.all([deletion, switching]);
    write.mockRestore();
    expect(config.status().profileId).toBe("beta");
    expect((await request(pool.virtualModel)).status).toBe(404);
    expect(await (await request("virtual/beta")).json()).toMatchObject({ model: "model-one", owner: "beta-original" });
    await config.stop("beta");
    await config.delete(store, "beta", pool.id);
    await expect(config.start(store, "beta")).rejects.toThrow(/no enabled gateway pools/i);
    expect(config.status().running).toBe(false);
  });
});
