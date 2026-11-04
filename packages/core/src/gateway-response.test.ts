import http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayPool } from "./domain";
import { forwardGatewayRequest, GatewayServer } from "./gateway";

const pool: GatewayPool = {
  id: "stream", profile: "default", virtualModel: "omp-switch/stream", port: 46831, enabled: true,
  upstreams: ["one", "two"].map((id) => ({ id, providerId: "local", modelId: id, kind: "secret", enabled: true })),
};
const upstreams: http.Server[] = [];
const gateways: GatewayServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of upstreams) server.closeAllConnections();
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const server of upstreams.splice(0)) await once(server.close(), "close");
});

async function streamingUpstream(firstFrame = true) {
  const paths: string[] = [];
  const responses: http.ServerResponse[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    paths.push(request.url ?? "");
    responses.push(response);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (firstFrame) response.write("data: hello\n\n");
    else response.flushHeaders();
  });
  upstreams.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP server");
  return { port: address.port, paths, responses };
}

describe("gateway response lifecycle", () => {
  it.each([false, true])("honors caller cancellation after response headers (read first frame: %s)", async (readFirst) => {
    const upstream = await streamingUpstream();
    const controller = new AbortController();
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: { model: pool.virtualModel }, signal: controller.signal }, {
      resolve: async (target) => ({ baseUrl: `http://127.0.0.1:${upstream.port}/${target.id}` }),
      timeoutMs: 10_000,
    });
    const reader = response.body!.getReader();
    if (readFirst) expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
    const closed = once(upstream.responses[0], "close", { signal: AbortSignal.timeout(1000) });
    controller.abort();
    await closed;
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    reader.releaseLock();
    expect(upstream.paths).toEqual(["/one/v1/responses"]);
  });

  it.each([false, true])("expires a stalled direct body without retrying (after first frame: %s)", async (firstFrame) => {
    const upstream = await streamingUpstream(firstFrame);
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: { model: pool.virtualModel } }, {
      resolve: async (target) => ({ baseUrl: `http://127.0.0.1:${upstream.port}/${target.id}` }),
      timeoutMs: 500,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    if (firstFrame) expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
    await once(upstream.responses[0], "close", { signal: AbortSignal.timeout(3000) });
    await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError", message: expect.stringContaining("500ms") });
    reader.releaseLock();
    expect(upstream.paths).toEqual(["/one/v1/responses"]);
  });

  it.each(["/v1/chat/completions", "/v1/responses"] as const)("terminates stalled HTTP SSE on %s without failover or a second response", async (path) => {
    const upstream = await streamingUpstream();
    const gateway = new GatewayServer({
      resolve: async (target) => ({ baseUrl: `http://127.0.0.1:${upstream.port}/${target.id}` }),
      timeoutMs: 150,
    }, [pool], { token: "local-test-only" });
    gateways.push(gateway);
    const port = await gateway.start(0);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { authorization: "Bearer local-test-only", "content-type": "application/json" },
      body: JSON.stringify({ model: pool.virtualModel, stream: true }), signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
    await once(upstream.responses[0], "close", { signal: AbortSignal.timeout(1000) });
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
    reader.releaseLock();
    expect(upstream.paths).toEqual([`/one${path}`]);
    expect(gateway.getStats().map((stat) => stat.upstreamId)).toEqual(["one"]);
  });

  it("releases the upstream when a direct caller cancels the returned body", async () => {
    const upstream = await streamingUpstream();
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: { model: pool.virtualModel } }, {
      resolve: async () => ({ baseUrl: `http://127.0.0.1:${upstream.port}` }), timeoutMs: 10_000,
    });
    const closed = once(upstream.responses[0], "close", { signal: AbortSignal.timeout(1000) });
    await response.body!.cancel();
    await closed;
    expect(upstream.paths).toEqual(["/v1/responses"]);
  });

  it("propagates an upstream body failure without retrying after a successful first frame", async () => {
    const upstream = await streamingUpstream();
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: { model: pool.virtualModel } }, {
      resolve: async (target) => ({ baseUrl: `http://127.0.0.1:${upstream.port}/${target.id}` }), timeoutMs: 10_000,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
    upstream.responses[0].destroy();
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
    reader.releaseLock();
    expect(upstream.paths).toEqual(["/one/v1/responses"]);
  });

  it("renews the idle deadline for each frame so a healthy stream can outlive one timeout window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: { stream: true } }, {
      resolve: async () => ({ baseUrl: "https://local.example" }), timeoutMs: 100,
      fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    const reader = response.body!.getReader();
    for (const frame of ["data: first\n\n", "data: next\n\n", "data: [DONE]\n\n"]) {
      await vi.advanceTimersByTimeAsync(80);
      source.enqueue(new TextEncoder().encode(frame));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);
    }
    source.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });
});
