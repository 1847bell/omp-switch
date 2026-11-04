import http from "node:http";
import { once } from "node:events";
import { brotliCompressSync, constants, createGzip, deflateSync, gzipSync, zstdCompressSync, type Gzip } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayPool } from "./domain";
import { forwardGatewayRequest, GatewayServer, probeGatewayUpstream } from "./gateway";

const pool: GatewayPool = {
  id: "stream", profile: "default", virtualModel: "omp-switch/stream", enabled: true,
  upstreams: ["one", "two"].map((id) => ({ id, providerId: "local", modelId: id, kind: "secret", enabled: true })),
};
const upstreams: http.Server[] = [];
const gateways: GatewayServer[] = [];
// Keep native fetch responses reachable so GC cannot accidentally dispose an abandoned body.
const retainedResponses: Response[] = [];
const retainingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  retainedResponses.push(response);
  return response;
};
afterEach(async () => {
  vi.useRealTimers();
  for (const server of upstreams) server.closeAllConnections();
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const server of upstreams.splice(0)) await once(server.close(), "close");
  retainedResponses.length = 0;
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

async function responseGateway(handler: http.RequestListener) {
  const upstream = http.createServer(handler);
  upstreams.push(upstream);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP server");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const gateway = new GatewayServer({ resolve: async () => ({ baseUrl }), fetchImpl: retainingFetch }, [pool], { token: "compression-test-only" });
  gateways.push(gateway);
  const port = await gateway.start(0);
  return { baseUrl, url: `http://127.0.0.1:${port}` };
}

function compressionRequest(url: string, path = "/v1/responses") {
  return fetch(`${url}${path}`, {
    method: "POST", headers: { authorization: "Bearer compression-test-only", "content-type": "application/json" },
    body: JSON.stringify({ model: pool.virtualModel, stream: true }), signal: AbortSignal.timeout(3000),
  });
}

describe("gateway response compression", () => {
  const expected = { id: "compressed-reply", output: [{ role: "assistant", content: "压缩响应 ✓" }] };
  const plaintext = Buffer.from(JSON.stringify(expected));

  it.each([
    { encoding: undefined, encode: (body: Buffer) => body, path: "/v1/chat/completions" },
    { encoding: "gzip", encode: gzipSync, path: "/v1/chat/completions" },
    { encoding: "gzip", encode: gzipSync, path: "/v1/responses" },
    { encoding: "x-gzip", encode: gzipSync, path: "/v1/responses" },
    { encoding: "GZip", encode: gzipSync, path: "/v1/responses" },
    { encoding: "deflate", encode: deflateSync, path: "/v1/responses" },
    { encoding: "br", encode: brotliCompressSync, path: "/v1/responses" },
    { encoding: "gzip, br", encode: (body: Buffer) => brotliCompressSync(gzipSync(body)), path: "/v1/responses" },
  ])("serves readable JSON for $encoding on $path", async ({ encoding, encode, path }) => {
    const encoded = encode(plaintext);
    const { url } = await responseGateway((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json", "content-length": encoded.length, ...(encoding ? { "content-encoding": encoding } : {}) });
      response.end(encoded);
    });
    const response = await compressionRequest(url, path);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expected);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("keeps Zstandard bytes and metadata consistent with the native Fetch decoder", async () => {
    const encoded = zstdCompressSync(plaintext);
    const { baseUrl, url } = await responseGateway((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "zstd", "content-length": encoded.length });
      response.end(encoded);
    });
    const native = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
    const nativeBytes = Buffer.from(await native.arrayBuffer());
    const decoded = nativeBytes.equals(plaintext);
    const response = await compressionRequest(url);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(decoded ? plaintext : encoded);
    expect(response.headers.get("content-encoding")).toBe(decoded ? null : "zstd");
  });

  it("normalizes decoded headers for direct callers as well as HTTP clients", async () => {
    const encoded = gzipSync(plaintext);
    const { baseUrl } = await responseGateway((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": encoded.length });
      response.end(encoded);
    });
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: {} }, { resolve: async () => ({ baseUrl }) });
    await expect(response.json()).resolves.toEqual(expected);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it.each([
    { encoding: "x-opaque", encode: gzipSync },
    { encoding: "gzip, x-opaque", encode: gzipSync },
    { encoding: "gzip, identity", encode: gzipSync },
    { encoding: "x-deflate", encode: deflateSync },
  ])("preserves bytes and encoding for an undecoded $encoding response", async ({ encoding, encode }) => {
    const encoded = encode(plaintext);
    const { url } = await responseGateway((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": encoding });
      response.end(encoded);
    });
    const response = await compressionRequest(url);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(encoded);
    expect(response.headers.get("content-encoding")).toBe(encoding);
  });

  it("delivers a gzip SSE frame before the upstream ends and then reaches DONE", async () => {
    let compressor!: Gzip;
    const { url } = await responseGateway((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      compressor = createGzip({ flush: constants.Z_SYNC_FLUSH });
      response.once("close", () => compressor.destroy());
      compressor.pipe(response);
      compressor.write("data: first\n\n");
    });
    const response = await compressionRequest(url);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    compressor.end("data: [DONE]\n\n");
    const tail: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail.push(new TextDecoder().decode(value));
    }
    reader.releaseLock();
    expect(tail.join("")).toBe("data: [DONE]\n\n");
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});

describe("gateway discarded responses", () => {
  it.each([
    { status: 200, via: "direct" },
    { status: 429, via: "http" },
    { status: 503, via: "direct" },
  ])("releases infinite bodies after repeated $status probes ($via)", async ({ status, via }) => {
    const closed: Promise<unknown>[] = [];
    const { baseUrl, url } = await responseGateway((request, response) => {
      request.resume();
      closed.push(once(response, "close", { signal: AbortSignal.timeout(2000) }));
      response.writeHead(status, { "content-type": "application/json" });
      response.write('{"unfinished":');
    });
    for (let index = 0; index < 3; index++) {
      const result = via === "direct"
        ? await probeGatewayUpstream(pool.upstreams[0], { resolve: async () => ({ baseUrl }), fetchImpl: retainingFetch }, { timeoutMs: 10_000 })
        : await fetch(`${url}/v1/probe`, {
          method: "POST", headers: { authorization: "Bearer compression-test-only", "content-type": "application/json" },
          body: JSON.stringify({ poolId: pool.id, upstreamId: "one", timeoutMs: 10_000 }), signal: AbortSignal.timeout(3000),
        }).then((response) => response.json());
      expect(result).toMatchObject({ status, ok: status === 200 });
      if (status !== 200) expect(result.error).toBe(`HTTP ${status}`);
    }
    await Promise.all(closed);
  });

  it.each([
    { discardedStatus: 429, finalStatus: 200, stream: false, via: "direct" },
    { discardedStatus: 503, finalStatus: 200, stream: true, via: "http" },
    { discardedStatus: 429, finalStatus: 503, stream: true, via: "direct" },
  ])("releases a discarded $discardedStatus body and preserves the final $finalStatus response ($via, stream: $stream)", async ({ discardedStatus, finalStatus, stream, via }) => {
    const closed: Promise<unknown>[] = [];
    let finalResponse!: http.ServerResponse;
    const { baseUrl, url } = await responseGateway(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
      if (body.model === "one") {
        closed.push(once(response, "close", { signal: AbortSignal.timeout(2000) }));
        response.writeHead(discardedStatus, { "content-type": "application/json" });
        response.write('{"unfinished":');
      } else {
        finalResponse = response;
        response.writeHead(finalStatus, { "content-type": stream ? "text/event-stream" : "application/json" });
        if (stream) response.write("data: first\n\n");
        else response.end(JSON.stringify({ id: "final-response", output: "kept readable" }));
      }
    });
    const response = via === "direct"
      ? await forwardGatewayRequest(pool, { path: "/v1/responses", body: { model: pool.virtualModel, stream } }, { resolve: async () => ({ baseUrl }), fetchImpl: retainingFetch })
      : await fetch(`${url}/v1/responses`, {
        method: "POST", headers: { authorization: "Bearer compression-test-only", "content-type": "application/json" },
        body: JSON.stringify({ model: pool.virtualModel, stream }), signal: AbortSignal.timeout(3000),
      });
    expect(response.status).toBe(finalStatus);
    if (stream) {
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
      await Promise.all(closed);
      finalResponse.end("data: [DONE]\n\n");
      const tail: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail.push(new TextDecoder().decode(value));
      }
      reader.releaseLock();
      expect(tail.join("")).toBe("data: [DONE]\n\n");
    } else {
      await Promise.all(closed);
      await expect(response.json()).resolves.toEqual({ id: "final-response", output: "kept readable" });
    }
  });
});
