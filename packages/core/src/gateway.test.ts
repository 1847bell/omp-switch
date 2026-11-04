import http from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { evaluateUpstreamHealth, forwardGatewayRequest, GatewayServer, isLoopbackHostHeader, isRetryableGatewayStatus, probeGatewayUpstream, validateGatewayPool } from "./gateway";

const pool = {
  id: "fast",
  profile: "default",
  virtualModel: "omp-switch/fast",
  port: 46831,
  enabled: true,
  upstreams: [
    { id: "one", providerId: "one", modelId: "model-one", kind: "secret" as const, credentialId: "one", enabled: true },
    { id: "two", providerId: "two", modelId: "model-two", kind: "omp-auth-gateway" as const, enabled: true },
  ],
};

async function listenLoopback(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address");
  return address.port;
}

describe("gateway routing", () => {
  it("only retries transient status codes", () => {
    expect(isRetryableGatewayStatus(429)).toBe(true);
    expect(isRetryableGatewayStatus(503)).toBe(true);
    expect(isRetryableGatewayStatus(401)).toBe(false);
  });

  it("fails over before a response is relayed", async () => {
    const requests: Array<{ url: string; model: string }> = [];
    const response = await forwardGatewayRequest(pool, { path: "/v1/chat/completions", body: { model: "omp-switch/fast", messages: [] } }, {
      resolve: async (upstream) => ({ baseUrl: `https://${upstream.id}.example/v1`, apiKey: upstream.id }),
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requests.push({ url: String(url), model: body.model });
        return new Response("ok", { status: requests.length === 1 ? 429 : 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(requests).toEqual([
      { url: "https://one.example/v1/chat/completions", model: "model-one" },
      { url: "https://two.example/v1/chat/completions", model: "model-two" },
    ]);
  });

  it("does not retry a rejected credential", async () => {
    let calls = 0;
    const response = await forwardGatewayRequest(pool, { path: "/v1/responses", body: { model: "omp-switch/fast" } }, {
      resolve: async () => ({ baseUrl: "https://one.example/v1" }),
      fetchImpl: async () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      },
    });
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("rejects unsafe pool and upstream identifiers", () => {
    expect(() => validateGatewayPool({ ...pool, id: "../escape" })).toThrow();
    expect(() => validateGatewayPool({ ...pool, upstreams: [{ ...pool.upstreams[0], credentialId: "bad value" }] })).toThrow();
    expect(() => validateGatewayPool(pool)).not.toThrow();
  });

  it("serves loopback health and virtual model listings", async () => {
    const server = new GatewayServer({ resolve: async () => ({ baseUrl: "https://example.test" }) }, [pool], { token: "test-token" });
    const port = await server.start(0);
    try {
      await expect(fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json())).resolves.toMatchObject({ ok: true, pools: 1, authRequired: true });
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer test-token" } });
      await expect(models.json()).resolves.toMatchObject({ data: [{ id: "omp-switch/fast" }] });
    } finally {
      await server.stop();
    }
  });

  it("refuses to start without a bearer token unless anonymous access is explicit", async () => {
    const forwarder = { resolve: async () => ({ baseUrl: "https://example.test" }) };
    await expect(new GatewayServer(forwarder, [pool]).start(0)).rejects.toThrow(/bearer token/);
    const open = new GatewayServer(forwarder, [pool], { allowAnonymous: true });
    const port = await open.start(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(200);
    } finally {
      await open.stop();
    }
  });

  it("rejects a missing token, a wrong token, and a browser origin", async () => {
    const server = new GatewayServer({ resolve: async () => ({ baseUrl: "https://example.test" }) }, [pool], { token: "test-token" });
    const port = await server.start(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
      // A web page can reach 127.0.0.1; it must not be able to spend the user's credentials.
      expect((await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: "Bearer test-token", origin: "https://evil.example" },
      })).status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it("rejects a non-loopback Host header so DNS rebinding cannot reach the gateway", async () => {
    const server = new GatewayServer({ resolve: async () => ({ baseUrl: "https://example.test" }) }, [pool], { token: "test-token" });
    const port = await server.start(0);
    try {
      // fetch() forbids overriding Host, so drive the socket directly.
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          { host: "127.0.0.1", port, path: "/v1/models", method: "GET", headers: { host: "attacker.example", authorization: "Bearer test-token" } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(status).toBe(421);
    } finally {
      await server.stop();
    }
    expect(isLoopbackHostHeader("127.0.0.1:46831")).toBe(true);
    expect(isLoopbackHostHeader("localhost")).toBe(true);
    expect(isLoopbackHostHeader("[::1]:46831")).toBe(true);
    expect(isLoopbackHostHeader("attacker.example")).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });

  it.each(["/v1/chat/completions", "/v1/responses"] as const)("forwards a completed HTTP request to %s", async (requestPath) => {
    const received: Array<{ path: string | undefined; body: unknown; authorization: string | undefined }> = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "local-response", output: "hello" }));
    });
    const upstreamPort = await listenLoopback(upstream);
    const server = new GatewayServer({
      resolve: async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "local-key" }),
    }, [pool], { token: "test-token" });
    const port = await server.start(0);
    const input = requestPath === "/v1/responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] };
    try {
      const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: pool.virtualModel, ...input }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ id: "local-response", output: "hello" });
      expect(received).toEqual([{ path: requestPath, body: { model: "model-one", ...input }, authorization: "Bearer local-key" }]);
    } finally {
      await server.stop();
      upstream.closeAllConnections();
      await once(upstream.close(), "close");
    }
  });

  it("waits for a chunked upload to finish before forwarding", async () => {
    const received: unknown[] = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.end("uploaded");
    });
    const upstreamPort = await listenLoopback(upstream);
    const server = new GatewayServer({ resolve: async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }) }, [pool], { token: "test-token" });
    const port = await server.start(0);
    try {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" } });
      const responseReceived = once(request, "response");
      request.write(`{"model":"${pool.virtualModel}",`);
      setImmediate(() => request.end('"messages":[{"role":"user","content":"chunked"}]}'));
      const [response] = await responseReceived as [http.IncomingMessage];
      let body = "";
      response.setEncoding("utf8");
      for await (const chunk of response) body += chunk;
      expect(response.statusCode).toBe(200);
      expect(body).toBe("uploaded");
      expect(received).toEqual([{ model: "model-one", messages: [{ role: "user", content: "chunked" }] }]);
    } finally {
      await server.stop();
      upstream.closeAllConnections();
      await once(upstream.close(), "close");
    }
  });

  it.each([false, true])("closes the upstream when the client disconnects (streaming: %s)", async (streaming) => {
    const upstream = http.createServer((request, response) => {
      request.resume();
      if (streaming) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: hello\n\n");
      }
    });
    const upstreamPort = await listenLoopback(upstream);
    const server = new GatewayServer({ resolve: async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }) }, [pool], { token: "test-token" });
    const port = await server.start(0);
    const controller = new AbortController();
    const upstreamRequested = once(upstream, "request");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const client = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: pool.virtualModel, stream: streaming }),
        signal: controller.signal,
      });
      const clientResult = client.catch((error: unknown) => error);
      const [, upstreamResponse] = await upstreamRequested as [http.IncomingMessage, http.ServerResponse];
      const upstreamClosed = once(upstreamResponse, "close");
      if (streaming) {
        const response = await client;
        expect(response.status).toBe(200);
        reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe("data: hello\n\n");
      }
      controller.abort();
      if (reader) await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
      else expect(await clientResult).toMatchObject({ name: "AbortError" });
      await upstreamClosed;
      expect(upstreamResponse.destroyed).toBe(true);
      expect(server.getStats().some((stat) => stat.upstreamId === "two")).toBe(false);
    } finally {
      controller.abort();
      reader?.releaseLock();
      upstream.closeAllConnections();
      await server.stop();
      await once(upstream.close(), "close");
    }
  });

  it("relays only safe response headers", async () => {
    const server = new GatewayServer({
      resolve: async () => ({ baseUrl: "https://one.example/v1" }),
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "session=leak", "transfer-encoding": "chunked" },
      }),
    }, [pool], { token: "test-token" });
    const port = await server.start(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "omp-switch/fast" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({});
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("content-type")).toContain("application/json");
    } finally {
      await server.stop();
    }
  });

  it("aborts an upstream that never responds and records the failure", async () => {
    const observed: Array<{ upstreamId: string; error?: string }> = [];
    const single = { ...pool, upstreams: [pool.upstreams[0]] };
    const response = await forwardGatewayRequest(single, { path: "/v1/responses", body: { model: "omp-switch/fast" } }, {
      resolve: async () => ({ baseUrl: "https://slow.example/v1" }),
      timeoutMs: 20,
      onAttempt: (observation) => observed.push({ upstreamId: observation.upstreamId, error: observation.error }),
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { message: expect.stringContaining("20ms") } });
    expect(observed).toEqual([{ upstreamId: "one", error: expect.stringContaining("20ms") }]);
  });

  it("probes an upstream and reports latency and status", async () => {
    const upstream = pool.upstreams[0];
    const result = await probeGatewayUpstream(upstream, {
      resolve: async () => ({ baseUrl: "https://one.example/v1", apiKey: "secret" }),
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    }, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.error).toBeUndefined();
  });

  it("handles client cancellation via signal in forwardGatewayRequest", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const response = await forwardGatewayRequest(pool, {
      path: "/v1/chat/completions",
      body: { model: "omp-switch/fast" },
      signal: abortController.signal,
    }, {
      resolve: async () => ({ baseUrl: "https://one.example/v1" }),
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    expect(response.status).toBe(499);
  });

  it("handles /v1/probe endpoint through GatewayServer", async () => {
    const server = new GatewayServer({
      resolve: async () => ({ baseUrl: "https://one.example/v1" }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    }, [pool], { token: "test-token" });
    const port = await server.start(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/probe`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ poolId: "fast", upstreamId: "one" }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({ ok: true, status: 200 });
    } finally {
      await server.stop();
    }
  });

  it("evaluates upstream health state and latency trends correctly", () => {
    // Untested
    expect(evaluateUpstreamHealth("pool-1", "up-1", [])).toMatchObject({
      healthState: "untested",
      consecutiveFailures: 0,
      ok: false,
    });

    // Healthy
    const healthyHistory = [
      { profile: "default", poolId: "p", upstreamId: "u", timestamp: "2026-08-24T08:00:00Z", ok: true, status: 200, latencyMs: 120 },
      { profile: "default", poolId: "p", upstreamId: "u", timestamp: "2026-08-24T07:59:00Z", ok: true, status: 200, latencyMs: 110 },
    ];
    expect(evaluateUpstreamHealth("p", "u", healthyHistory)).toMatchObject({
      healthState: "healthy",
      lastLatencyMs: 120,
      consecutiveFailures: 0,
      ok: true,
    });

    // Degraded
    const degradedHistory = [
      { profile: "default", poolId: "p", upstreamId: "u", timestamp: "2026-08-24T08:00:00Z", ok: true, status: 200, latencyMs: 950 },
    ];
    expect(evaluateUpstreamHealth("p", "u", degradedHistory)).toMatchObject({
      healthState: "degraded",
      lastLatencyMs: 950,
      ok: true,
    });

    // Unhealthy due to failures
    const unhealthyHistory = [
      { profile: "default", poolId: "p", upstreamId: "u", timestamp: "2026-08-24T08:01:00Z", ok: false, status: 502, latencyMs: 3100, error: "HTTP 502" },
      { profile: "default", poolId: "p", upstreamId: "u", timestamp: "2026-08-24T08:00:00Z", ok: false, status: 502, latencyMs: 3200, error: "HTTP 502" },
    ];
    expect(evaluateUpstreamHealth("p", "u", unhealthyHistory)).toMatchObject({
      healthState: "unhealthy",
      consecutiveFailures: 2,
      ok: false,
    });
  });
});
