import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigConflictError, ConfigValidationError, Diagnostic, OmpInstallation } from "./domain";
import { getProfilePaths, OmpPathEnv } from "./paths";
import { assertFileExpectation, sha256Text, writeTextAtomic } from "./yaml-config";

export interface McpConfigFile {
  profileId: string;
  path: string;
  exists: boolean;
  hash: string | null;
  content: string;
  diagnostics: Diagnostic[];
}

export interface McpConfigPreview {
  profileId: string;
  path: string;
  before: string;
  content: string;
  expectedHash: string | null;
  diagnostics: Diagnostic[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate known OMP fields without interpreting values or removing extension fields. */
export function validateMcpConfig(content: string): Diagnostic[] {
  if (typeof content !== "string") return [{ severity: "error", code: "mcp.content", message: "MCP content must be a string" }];
  const diagnostics: Diagnostic[] = [];
  const error = (field: string, message: string) => diagnostics.push({ severity: "error", code: "mcp.validation", path: field, message: `${field}: ${message}` });
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return [{ severity: "error", code: "mcp.json", message: "MCP configuration must be valid JSON" }];
  }
  if (!isObject(root)) {
    error("MCP configuration", "must be an object");
    return diagnostics;
  }
  if ("$schema" in root && typeof root.$schema !== "string") error("$schema", "must be a string");
  const stringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const stringMap = (value: unknown) => isObject(value) && Object.values(value).every((item) => typeof item === "string");
  for (const field of ["disabledServers", "enabledServers"]) {
    if (field in root && !stringArray(root[field])) error(field, "must be an array of strings");
  }
  if (!("mcpServers" in root)) return diagnostics;
  if (!isObject(root.mcpServers)) {
    error("mcpServers", "must be an object");
    return diagnostics;
  }
  for (const [name, server] of Object.entries(root.mcpServers)) {
    const field = `mcpServers.${name}`;
    if (name.length > 100 || !/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(name)) error(field, "invalid server name (maximum 100 characters)");
    if (!isObject(server)) {
      error(field, "must be an object");
      continue;
    }
    for (const key of ["command", "url", "cwd"]) {
      if (key in server && typeof server[key] !== "string") error(`${field}.${key}`, "must be a string");
    }
    for (const key of ["command", "url"]) {
      if (typeof server[key] === "string" && !server[key].trim()) error(`${field}.${key}`, "must not be empty");
    }
    if ("command" in server && "url" in server) error(field, "command and url cannot both be present");
    const transport = "type" in server ? server.type : ("url" in server ? "http" : "stdio");
    if (!["stdio", "http", "sse"].includes(transport as string)) error(`${field}.type`, "must be stdio, http or sse");
    if (transport === "stdio" && !("command" in server)) error(field, "stdio requires command");
    if ((transport === "http" || transport === "sse") && !("url" in server)) error(field, "HTTP/SSE requires url");
    if ("args" in server && !stringArray(server.args)) error(`${field}.args`, "must be an array of strings");
    for (const key of ["env", "headers"]) {
      if (key in server && !stringMap(server[key])) error(`${field}.${key}`, "must be an object of string values");
    }
    for (const key of ["enabled", "instructions"]) {
      if (key in server && typeof server[key] !== "boolean") error(`${field}.${key}`, "must be a boolean");
    }
    if ("timeout" in server && (typeof server.timeout !== "number" || !Number.isFinite(server.timeout) || server.timeout < 0)) error(`${field}.timeout`, "must be a finite nonnegative number");
    if ("requestIdFormat" in server && server.requestIdFormat !== "number" && server.requestIdFormat !== "string") error(`${field}.requestIdFormat`, 'must be "number" or "string"');
    for (const key of ["auth", "oauth"]) {
      if (key in server && !isObject(server[key])) error(`${field}.${key}`, "must be an object");
    }
  }
  return diagnostics;
}

export class OmpMcpAdapter {
  private readonly saves = new Map<string, Promise<unknown>>();
  private readonly pathEnv: OmpPathEnv;

  constructor(private readonly options: { homeDir: string; snapshotDir: string; pathEnv?: OmpPathEnv; installation?: OmpInstallation }) {
    this.pathEnv = { ...(options.pathEnv ?? {
      PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    }) };
  }

  private async guard(filePath: string): Promise<void> {
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`MCP configuration target must be a regular file, not a symlink: ${filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private readonlyDiagnostic(): Diagnostic[] {
    const installation = this.options.installation;
    return installation && !installation.supported
      ? [{ severity: "error", code: "mcp.readonly", message: installation.reason ?? "Unsupported OMP schema; MCP configuration is read-only" }]
      : [];
  }

  async load(profileId: string): Promise<McpConfigFile> {
    if (typeof profileId !== "string") throw new Error("MCP profileId must be a string");
    const filePath = path.join(getProfilePaths(this.options.homeDir, profileId, this.pathEnv).agentDir, "mcp.json");
    await this.guard(filePath);
    let content = "";
    let exists = true;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    return {
      profileId, path: filePath, exists, content, hash: exists ? sha256Text(content) : null,
      diagnostics: [
        ...(exists ? validateMcpConfig(content) : []),
        ...this.readonlyDiagnostic(),
        { severity: "info", code: "mcp.primary-only", message: "Edits only this profile's primary mcp.json. Legacy .mcp.json and project configurations are not edited or migrated." },
      ],
    };
  }

  async preview(profileId: string, content: string, expectedHash: string | null): Promise<McpConfigPreview> {
    if (expectedHash !== null && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash))) throw new Error("MCP expectedHash must be null or a SHA-256 hash");
    const current = await this.load(profileId);
    const diagnostics = [...validateMcpConfig(content), ...this.readonlyDiagnostic()];
    if (diagnostics.some((item) => item.severity === "error")) throw new ConfigValidationError(diagnostics);
    if (current.hash !== expectedHash) throw new ConfigConflictError(current.path);
    await assertFileExpectation(current.path, { exists: expectedHash !== null, hash: expectedHash ?? undefined });
    return { profileId, path: current.path, before: current.content, content, expectedHash, diagnostics };
  }

  save(profileId: string, content: string, expectedHash: string | null): Promise<McpConfigFile> {
    // A failed save must not poison the queue for later repair attempts.
    const previous = this.saves.get(profileId) ?? Promise.resolve();
    const save = previous.catch(() => undefined).then(() => this.saveQueued(profileId, content, expectedHash));
    this.saves.set(profileId, save);
    void save.finally(() => { if (this.saves.get(profileId) === save) this.saves.delete(profileId); }).catch(() => undefined);
    return save;
  }

  private async saveQueued(profileId: string, content: string, expectedHash: string | null): Promise<McpConfigFile> {
    const preview = await this.preview(profileId, content, expectedHash);
    await this.snapshot(preview);
    const expectation = { exists: expectedHash !== null, hash: expectedHash ?? undefined };
    await fs.mkdir(path.dirname(preview.path), { recursive: true, mode: 0o700 });
    // Stage in a private same-filesystem directory: the shared atomic writer's temporary
    // file must never expose env/header/auth secrets under the process's default umask.
    const stagingDir = await fs.mkdtemp(path.join(path.dirname(preview.path), ".omp-switch-mcp-"));
    try {
      await fs.chmod(stagingDir, 0o700);
      const stagedPath = path.join(stagingDir, "mcp.json");
      await writeTextAtomic(stagedPath, content);
      await fs.chmod(stagedPath, 0o600);
      await this.guard(preview.path);
      await assertFileExpectation(preview.path, expectation);
      await fs.rename(stagedPath, preview.path);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
    return this.load(profileId);
  }

  private async snapshot(preview: McpConfigPreview): Promise<void> {
    const root = path.join(this.options.snapshotDir, "mcp");
    const profileDir = path.join(root, preview.profileId);
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    await fs.chmod(profileDir, 0o700);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    const dir = path.join(profileDir, id);
    await fs.mkdir(dir, { mode: 0o700 });
    if (preview.expectedHash !== null) await fs.writeFile(path.join(dir, "mcp.json"), preview.before, { mode: 0o600, flag: "wx" });
    await fs.writeFile(path.join(dir, "snapshot.json"), JSON.stringify({ profileId: preview.profileId, path: preview.path, hash: preview.expectedHash, exists: preview.expectedHash !== null }), { mode: 0o600, flag: "wx" });
    const entries = (await fs.readdir(profileDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[\da-f-]+$/.test(entry.name))
      .map((entry) => entry.name).sort().reverse();
    await Promise.all(entries.slice(30).map((entry) => fs.rm(path.join(profileDir, entry), { recursive: true, force: true })));
  }
}
