import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigConflictError, ConfigValidationError } from "./domain";
import { OmpMcpAdapter, validateMcpConfig } from "./mcp";
import { sha256Text } from "./yaml-config";
import { classifyOmpInstallation } from "./schema";

const roots: string[] = [];

async function fixture(options: Partial<ConstructorParameters<typeof OmpMcpAdapter>[0]> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-switch-mcp-test-"));
  roots.push(root);
  const snapshotDir = path.join(root, "app-data", "snapshots");
  return { root, snapshotDir, adapter: new OmpMcpAdapter({ homeDir: root, snapshotDir, pathEnv: {}, ...options }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("OmpMcpAdapter", () => {
  it("previews without writing and creates/edits exact raw text including unknown/auth fields", async () => {
    const { adapter, snapshotDir } = await fixture();
    const missing = await adapter.load("default");
    expect(missing).toMatchObject({ exists: false, hash: null, content: "" });
    const text = '{\r\n  "future": {"keep": true}, "mcpServers": {"stdio server:1": {"command":"never-run", "args":["${TOKEN}"], "env":{"SECRET":"literal"}, "auth":{"future":"preserve"}, "oauth":{"clientSecret":"secret"}}}\r\n}\r\n';
    const preview = await adapter.preview("default", text, null);
    expect(preview).toMatchObject({ before: "", content: text, expectedHash: null, path: missing.path });
    await expect(fs.stat(missing.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(snapshotDir)).rejects.toMatchObject({ code: "ENOENT" });
    const created = await adapter.save("default", text, null);
    expect(created).toMatchObject({ content: text, hash: sha256Text(text), exists: true });
    const edited = `${text.trimEnd()}\n\n`;
    expect((await adapter.preview("default", edited, created.hash)).before).toBe(text);
    const saved = await adapter.save("default", edited, created.hash);
    expect(saved.content).toBe(edited);
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe(edited);
    if (process.platform !== "win32") expect((await fs.stat(saved.path)).mode & 0o777).toBe(0o600);
  });

  it("isolates named profiles, environment overrides, and legacy primary files", async () => {
    const { root, snapshotDir } = await fixture();
    const agentDir = path.join(root, "custom-agent");
    const adapter = new OmpMcpAdapter({ homeDir: root, snapshotDir, pathEnv: { PI_CONFIG_DIR: "custom-root", PI_CODING_AGENT_DIR: agentDir, OMP_MODELS_PATH: path.join(root, "models.yml"), OMP_PROFILE: "elsewhere" } });
    await fs.mkdir(agentDir, { recursive: true });
    const legacyPath = path.join(agentDir, ".mcp.json");
    await fs.writeFile(legacyPath, '{"legacy":true}');
    const current = await adapter.save("default", "{}\n", null);
    const named = await adapter.save("work", '{"mcpServers":{}}', null);
    expect(current.path).toBe(path.join(agentDir, "mcp.json"));
    expect(named.path).toBe(path.join(root, "custom-root", "profiles", "work", "agent", "mcp.json"));
    expect(current.diagnostics.some((item) => item.code === "mcp.primary-only")).toBe(true);
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe('{"legacy":true}');
    await expect(fs.stat(path.join(root, "models.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.load("../escape")).rejects.toThrow();
  });

  it.each([
    "{", "null", "[]", '{"$schema":42}', '{"mcpServers":[]}',
    '{"disabledServers":[1]}', '{"enabledServers":false}',
    '{"mcpServers":{"bad/name":{"command":"x"}}}',
    '{"mcpServers":{"s":null}}', '{"mcpServers":{"s":{}}}',
    '{"mcpServers":{"s":{"command":"x","url":"https://example.test"}}}',
    '{"mcpServers":{"s":{"type":"http","command":"x"}}}',
    '{"mcpServers":{"s":{"type":"stdio","url":"https://example.test"}}}',
    '{"mcpServers":{"s":{"type":null,"command":"x"}}}',
    '{"mcpServers":{"s":{"command":""}}}',
    '{"mcpServers":{"s":{"command":"x","args":[1]}}}',
    '{"mcpServers":{"s":{"command":"x","env":{"TOKEN":1}}}}',
    '{"mcpServers":{"s":{"url":"https://example.test","headers":[]}}}',
    '{"mcpServers":{"s":{"command":"x","cwd":1}}}',
    '{"mcpServers":{"s":{"command":"x","enabled":"yes"}}}',
    '{"mcpServers":{"s":{"command":"x","instructions":0}}}',
    '{"mcpServers":{"s":{"command":"x","timeout":-1}}}',
    '{"mcpServers":{"s":{"command":"x","timeout":1e999}}}',
    '{"mcpServers":{"s":{"command":"x","requestIdFormat":7}}}',
    '{"mcpServers":{"s":{"command":"x","auth":[]}}}',
  ])("rejects invalid JSON/known types without writes: %s", async (text) => {
    const { adapter, snapshotDir } = await fixture();
    const current = await adapter.load("default");
    expect(validateMcpConfig(text).some((item) => item.severity === "error")).toBe(true);
    await expect(adapter.preview("default", text, null)).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(adapter.save("default", text, null)).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(fs.stat(current.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(snapshotDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads broken raw JSON unchanged and permits repair with the original hash", async () => {
    const { adapter } = await fixture();
    const missing = await adapter.load("default");
    await fs.mkdir(path.dirname(missing.path), { recursive: true });
    const broken = '{"mcpServers": broken\r\n';
    await fs.writeFile(missing.path, broken);
    const loaded = await adapter.load("default");
    expect(loaded.content).toBe(broken);
    expect(loaded.hash).toBe(sha256Text(broken));
    expect(loaded.diagnostics.some((item) => item.severity === "error")).toBe(true);
    await expect(adapter.save("default", "{}", loaded.hash)).resolves.toMatchObject({ content: "{}" });
  });

  it("accepts inferred HTTP, SSE, shared options and forward-compatible fields without changing text", () => {
    const text = JSON.stringify({ $schema: "https://example.test/schema", future: 1, disabledServers: ["off"], enabledServers: ["on"], mcpServers: {
      "remote:1": { url: "${MCP_ENDPOINT}", headers: { Authorization: "Bearer ${TOKEN}" }, timeout: 0, instructions: false, requestIdFormat: "string", enabled: true, future: [1] },
      "remote sse": { type: "sse", url: "https://example.test", requestIdFormat: "number" },
      stdio: { command: "echo", args: [], env: {}, cwd: "${HOME}" },
    } });
    expect(validateMcpConfig(text)).toEqual([]);
    expect(validateMcpConfig(JSON.stringify({ mcpServers: { ["x".repeat(101)]: { command: "x" } } }))).not.toEqual([]);
  });

  it("rejects changed, deleted, and independently created targets without overwriting them", async () => {
    const { adapter } = await fixture();
    const created = await adapter.save("default", "{}", null);
    await fs.writeFile(created.path, '{"external":1}');
    await expect(adapter.preview("default", "{}", created.hash)).rejects.toBeInstanceOf(ConfigConflictError);
    await expect(adapter.save("default", "{}", created.hash)).rejects.toBeInstanceOf(ConfigConflictError);
    await expect(fs.readFile(created.path, "utf8")).resolves.toBe('{"external":1}');
    await fs.unlink(created.path);
    await expect(adapter.save("default", "{}", created.hash)).rejects.toBeInstanceOf(ConfigConflictError);
    const missing = await adapter.load("default");
    await fs.writeFile(missing.path, '{"createdElsewhere":true}');
    await expect(adapter.save("default", "{}", null)).rejects.toBeInstanceOf(ConfigConflictError);
  });

  it("serializes same-profile saves so only one writer can use an expected hash", async () => {
    const { adapter } = await fixture();
    const current = await adapter.save("default", "{}", null);
    const results = await Promise.allSettled([
      adapter.save("default", '{"winner":1}', current.hash),
      adapter.save("default", '{"winner":2}', current.hash),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(ConfigConflictError) });
    expect((await adapter.load("default")).content).toBe('{"winner":1}');
    const latest = await adapter.load("default");
    await expect(adapter.save("default", "{}", latest.hash)).resolves.toMatchObject({ content: "{}" });
  });

  it("snapshots raw previous text with private permissions and bounds retention to 30", async () => {
    const { adapter, snapshotDir } = await fixture();
    const original = '{\r\n "secret": "unchanged snapshot"\r\n}\r\n';
    let current = await adapter.save("default", original, null);
    current = await adapter.save("default", "{}", current.hash);
    const profileDir = path.join(snapshotDir, "mcp", "default");
    const dirs = await fs.readdir(profileDir);
    const snapshotFiles = await Promise.all(dirs.map(async (name) => {
      const dir = path.join(profileDir, name);
      const metadata = JSON.parse(await fs.readFile(path.join(dir, "snapshot.json"), "utf8"));
      if (process.platform !== "win32") {
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(dir, "snapshot.json"))).mode & 0o777).toBe(0o600);
      }
      if (!metadata.exists) return null;
      const file = path.join(dir, "mcp.json");
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      return fs.readFile(file, "utf8");
    }));
    expect(snapshotFiles).toContain(original);
    for (let i = 0; i < 31; i++) current = await adapter.save("default", JSON.stringify({ revision: i }), current.hash);
    expect(await fs.readdir(profileDir)).toHaveLength(30);
    if (process.platform !== "win32") expect((await fs.stat(profileDir)).mode & 0o777).toBe(0o700);
  });

  it("refuses to save when the snapshot cannot be created", async () => {
    const { root, adapter } = await fixture();
    const current = await adapter.save("default", "{}", null);
    const blockedDir = path.join(root, "not-a-directory");
    await fs.writeFile(blockedDir, "blocked");
    const blocked = new OmpMcpAdapter({ homeDir: root, snapshotDir: blockedDir, pathEnv: {} });
    await expect(blocked.save("default", '{"changed":true}', current.hash)).rejects.toThrow();
    await expect(fs.readFile(current.path, "utf8")).resolves.toBe("{}");
  });

  it.each([
    { executable: null, version: "19.0.0", supported: false, schemaStatus: "readonly" as const },
    { executable: "omp", version: "unrecognized", supported: false, schemaStatus: "unknown" as const },
  ])("allows loading but refuses edits for unsupported schemas", async (installation) => {
    const { adapter } = await fixture({ installation });
    const current = await adapter.load("default");
    expect(current.diagnostics.some((item) => item.code === "mcp.readonly")).toBe(true);
    await expect(adapter.preview("default", "{}", null)).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(adapter.save("default", "{}", null)).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(fs.stat(current.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("permits MCP creation in file-only mode when OMP is not installed", async () => {
    const installation = classifyOmpInstallation({ executable: null, version: null });
    const { adapter } = await fixture({ installation });
    const saved = await adapter.save("default", '{"mcpServers":{"local":{"command":"not-executed"}}}', null);
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe(saved.content);
    expect(saved.diagnostics.some((item) => item.code === "mcp.readonly")).toBe(false);
  });

  it("rejects malformed renderer arguments before writing", async () => {
    const { adapter, snapshotDir } = await fixture();
    await expect(adapter.load(42 as unknown as string)).rejects.toThrow("profileId must be a string");
    for (const hash of [undefined, "", "../file", 42]) {
      await expect(adapter.preview("default", "{}", hash as unknown as string)).rejects.toThrow("expectedHash");
      await expect(adapter.save("default", "{}", hash as unknown as string)).rejects.toThrow("expectedHash");
    }
    await expect(adapter.save("default", {} as unknown as string, null)).rejects.toThrow("content must be a string");
    await expect(fs.stat(snapshotDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-file targets", async () => {
    const { adapter } = await fixture();
    const current = await adapter.load("default");
    await fs.mkdir(current.path, { recursive: true });
    await expect(adapter.load("default")).rejects.toThrow("regular file");
    await expect(adapter.save("default", "{}", null)).rejects.toThrow("regular file");
  });

  it.skipIf(process.platform === "win32")("rejects symlinks without changing the linked file", async () => {
    const { root, adapter } = await fixture();
    const current = await adapter.load("default");
    await fs.mkdir(path.dirname(current.path), { recursive: true });
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, "{}");
    await fs.symlink(outside, current.path);
    await expect(adapter.load("default")).rejects.toThrow("symlink");
    await expect(adapter.save("default", '{"overwrite":true}', sha256Text("{}"))).rejects.toThrow("symlink");
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("{}");
  });
});
