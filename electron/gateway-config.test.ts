import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayPool } from "@omp-switch/core";
import { MetadataStore } from "./metadata-store";
import { GatewayConfigCoordinator } from "./gateway-config";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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
    response.end(JSON.stringify({ route: request.url, model: JSON.parse(Buffer.concat(chunks).toString()).model }));
  });
  const listening = once(upstream, "listening");
  upstream.listen(0, "127.0.0.1");
  await listening;
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address");
  cleanups.push(async () => {
    const closed = once(upstream, "close");
    upstream.close();
    await closed;
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const server = new GatewayServer({ resolve: async (target) => ({ baseUrl: `${baseUrl}/${target.providerId}` }) }, [], { token: "test-token" });
  cleanups.push(() => server.stop());
  let active: { server: GatewayServer; profile: string; port: number } | null = null;
  const config = new GatewayConfigCoordinator(() => active);
  const pool: GatewayPool = {
    id: "shared", profile: "alpha", virtualModel: "virtual/original", port: 46831, enabled: true,
    upstreams: [
      { id: "one", providerId: "first", modelId: "model-one", kind: "secret", credentialId: "cred", enabled: true },
      { id: "two", providerId: "second", modelId: "model-two", kind: "secret", credentialId: "cred", enabled: true },
    ],
  };
  await config.save(store, pool);
  const start = () => config.runExclusive(async () => {
    server.setPools(store.listGatewayPools("alpha").filter((candidate) => candidate.enabled));
    const port = await server.start(0);
    active = { server, profile: "alpha", port };
    pool.port = port;
    // Ephemeral test binding replaces the configured port before exercising active saves.
    await store.saveGatewayPool({ ...store.listGatewayPools("alpha")[0], port });
  });
  const stop = () => config.runExclusive(async () => {
    await server.stop();
    active = null;
  });
  const request = (model: string) => {
    if (!active) throw new Error("Gateway is stopped");
    return fetch(`http://127.0.0.1:${active.port}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
    });
  };
  const models = async () => {
    if (!active) throw new Error("Gateway is stopped");
    const response = await fetch(`http://127.0.0.1:${active.port}/v1/models`, { headers: { authorization: "Bearer test-token" } });
    return response.json() as Promise<{ data: Array<{ id: string }> }>;
  };
  return { store, config, pool, server, start, stop, request, models };
}

describe.each(["auto", "json"] as const)("production gateway save boundary (%s)", (backend) => {
  it("applies virtual rename, upstream target, order and enable changes to the next HTTP request", async () => {
    const { store, config, pool, start, request, models } = await fixture(backend);
    await start();
    expect(await (await request(pool.virtualModel)).json()).toEqual({ route: "/first/v1/chat/completions", model: "model-one" });
    const renamed = { ...pool, virtualModel: "virtual/renamed" };
    await config.save(store, renamed);
    expect((await request(pool.virtualModel)).status).toBe(404);
    expect((await models()).data.map((entry) => entry.id)).toEqual([renamed.virtualModel]);
    expect((await request(renamed.virtualModel)).status).toBe(200);
    const reordered = { ...renamed, upstreams: [pool.upstreams[1], pool.upstreams[0]] };
    await config.save(store, reordered);
    expect(await (await request(renamed.virtualModel)).json()).toEqual({ route: "/second/v1/chat/completions", model: "model-two" });
    const disabledFirst = { ...reordered, upstreams: reordered.upstreams.map((target, index) => ({ ...target, enabled: index !== 0 })) };
    await config.save(store, disabledFirst);
    expect(await (await request(renamed.virtualModel)).json()).toEqual({ route: "/first/v1/chat/completions", model: "model-one" });
    await config.save(store, { ...disabledFirst, upstreams: [{ ...pool.upstreams[1], modelId: "replacement-model" }] });
    expect(await (await request(renamed.virtualModel)).json()).toEqual({ route: "/second/v1/chat/completions", model: "replacement-model" });
  });

  it("keeps listening with no enabled pools and re-enables the last pool without restarting", async () => {
    const { store, config, pool, server, start, request, models } = await fixture(backend);
    await start();
    await config.save(store, { ...pool, enabled: false });
    expect(server.running).toBe(true);
    expect((await models()).data).toEqual([]);
    expect((await request(pool.virtualModel)).status).toBe(404);
    await config.save(store, pool);
    expect((await request(pool.virtualModel)).status).toBe(200);
  });

  it("isolates other-profile saves and does not start a stopped gateway", async () => {
    const { store, config, pool, server, start, stop, request } = await fixture(backend);
    await config.save(store, { ...pool, virtualModel: "virtual/stopped" });
    expect(server.running).toBe(false);
    await start();
    await config.save(store, { ...pool, profile: "beta", virtualModel: "virtual/other", port: 46832 });
    expect((await request("virtual/stopped")).status).toBe(200);
    expect((await request("virtual/other")).status).toBe(404);
    expect(store.listGatewayPools("beta")[0].virtualModel).toBe("virtual/other");
    await stop();
    await config.save(store, { ...pool, virtualModel: "virtual/after-stop" });
    expect(server.running).toBe(false);
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

  it("serializes concurrent saves with start and stop without stale routes or resurrection", async () => {
    const { store, config, pool, server, start, stop, request } = await fixture(backend);
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
    expect(server.running).toBe(false);
    expect(store.listGatewayPools("alpha")[0].virtualModel).toBe("virtual/stopped-latest");
  });
});
