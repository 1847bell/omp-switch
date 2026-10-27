import { isMap, isNode, parseDocument, type YAMLMap } from "yaml";
import { SharedError } from "./provider-form";

export interface McpEntry {
  key: string;
  value: Record<string, unknown>;
}

interface Member {
  key: string;
  start: number;
  keyEnd: number;
  valueStart: number;
  end: number;
}

interface McpDocument {
  root: YAMLMap;
  members: Member[];
  servers: YAMLMap | null;
  entries: Member[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(content: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (isObject(value)) return value;
  } catch {
    // Never expose JSON parser messages: they may include credentials from the input.
  }
  throw new SharedError(code);
}

function membersOf(content: string, map: YAMLMap): Member[] {
  const keys = new Set<string>();
  return map.items.map(({ key, value }) => {
    if (!isNode(key) || !key.range || !isNode(value) || !value.range) {
      throw new SharedError("mcp.invalidDocument");
    }
    // Decode keys with JSON, not YAML, including escaped duplicate spellings.
    const decoded: string = JSON.parse(content.slice(key.range[0], key.range[1]));
    if (keys.has(decoded)) throw new SharedError("mcp.invalidDocument");
    keys.add(decoded);
    return { key: decoded, start: key.range[0], keyEnd: key.range[1], valueStart: value.range[0], end: value.range[1] };
  });
}

function readDocument(content: string): McpDocument {
  const value = parseObject(content, "mcp.invalidDocument");
  // JSON.parse is the syntax gate; YAML supplies source ranges only. In particular,
  // never stringify its values, which could round numbers or normalize escapes.
  const document = parseDocument(content, { uniqueKeys: false, prettyErrors: false, strict: false });
  const root = document.contents;
  if (!isMap(root) || !root.range) throw new SharedError("mcp.invalidDocument");
  const members = membersOf(content, root);
  const index = members.findIndex((member) => member.key === "mcpServers");
  if (index === -1) return { root, members, servers: null, entries: [] };
  const servers = root.items[index]?.value;
  if (!isObject(value.mcpServers) || !isMap(servers) || !servers.range) {
    throw new SharedError("mcp.invalidDocument");
  }
  const entries = membersOf(content, servers);
  if (entries.some((entry) => !isObject((value.mcpServers as Record<string, unknown>)[entry.key]))) {
    throw new SharedError("mcp.invalidDocument");
  }
  return { root, members, servers, entries };
}

/** Reads only object-valued MCP servers, retaining their source order. */
export function readMcpEntries(content: string): McpEntry[] {
  if (content === "") return [];
  const { entries } = readDocument(content);
  return entries.map(({ key, valueStart, end }) => ({ key, value: JSON.parse(content.slice(valueStart, end)) }));
}

function validateKey(key: string): void {
  if (key.length < 1 || key.length > 100 || !/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(key)) {
    throw new SharedError("mcp.invalidKey");
  }
}

function insertMember(content: string, map: YAMLMap, members: Member[], key: string, objectJson: string): string {
  const start = map.range![0];
  const last = members.at(-1);
  let separator = "";
  const first = members[0];
  const whitespace = content.slice(start + 1, first?.start ?? map.range![1] - 1);
  if (whitespace.includes("\n")) {
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    if (first) {
      separator = newline + content.slice(content.lastIndexOf("\n", first.start) + 1, first.start);
    } else {
      const lineStart = content.lastIndexOf("\n", start) + 1;
      const indent = content.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? "";
      const unit = content.match(/(?:^|\n)([ \t]+)"/)?.[1] ?? "  ";
      separator = newline + indent + unit;
    }
  } else if (whitespace) {
    separator = whitespace;
  }
  const position = last?.end ?? start + 1;
  const addition = `${last ? "," : ""}${separator}${JSON.stringify(key)}: ${objectJson}`;
  return content.slice(0, position) + addition + content.slice(position);
}

/** Replaces just one key/object span, or appends a new server without rewriting siblings. */
export function patchMcpEntry(content: string, originalKey: string | null, key: string, objectJson: string): string {
  validateKey(key);
  parseObject(objectJson, "mcp.invalidObject");
  const object = objectJson.trim();
  const source = content === "" ? "{}" : content;
  const { root, members, servers, entries } = readDocument(source);
  const existing = originalKey === null ? undefined : entries.find((entry) => entry.key === originalKey);
  if (originalKey !== null && !existing) throw new SharedError("mcp.missingEntry");
  if (entries.some((entry) => entry.key === key && entry !== existing)) throw new SharedError("mcp.duplicateKey");
  if (existing) {
    const keyText = originalKey === key ? source.slice(existing.start, existing.keyEnd) : JSON.stringify(key);
    return source.slice(0, existing.start) + keyText + source.slice(existing.keyEnd, existing.valueStart) + object + source.slice(existing.end);
  }
  if (servers) return insertMember(source, servers, entries, key, object);
  return insertMember(source, root, members, "mcpServers", `{${JSON.stringify(key)}: ${object}}`);
}

/** Removes one server and only the adjacent comma needed to keep strict JSON valid. */
export function removeMcpEntry(content: string, key: string): string {
  if (content === "") throw new SharedError("mcp.missingEntry");
  const { entries } = readDocument(content);
  const index = entries.findIndex((entry) => entry.key === key);
  if (index === -1) throw new SharedError("mcp.missingEntry");
  const entry = entries[index]!;
  const next = entries[index + 1];
  const previous = entries[index - 1];
  // Keep all whitespace outside the entry; consume only its span and one comma.
  const comma = next ? content.indexOf(",", entry.end) : previous ? content.indexOf(",", previous.end) : -1;
  if (comma === -1) return content.slice(0, entry.start) + content.slice(entry.end);
  if (next) return content.slice(0, entry.start) + content.slice(entry.end, comma) + content.slice(comma + 1);
  return content.slice(0, comma) + content.slice(comma + 1, entry.start) + content.slice(entry.end);
}
