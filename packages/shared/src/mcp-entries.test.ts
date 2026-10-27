import { describe, expect, it } from "vitest";
import { SharedError } from "./provider-form";
import { patchMcpEntry, readMcpEntries, removeMcpEntry } from "./mcp-entries";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected a SharedError");
  } catch (error) {
    expect(error).toBeInstanceOf(SharedError);
    expect((error as SharedError).code).toBe(code);
    expect((error as SharedError).message).toBe(code);
    expect((error as SharedError).params).toBeUndefined();
  }
}

describe("MCP entry source editing", () => {
  it("reads source order, nested objects, unknown fields, and missing files", () => {
    expect(readMcpEntries("")).toEqual([]);
    expect(readMcpEntries('{"other":true}')).toEqual([]);
    expect(readMcpEntries('{"mcpServers":{"10":{"command":"tool","args":["a"],"env":{"TOKEN":"secret"},"startup_timeout_sec":42},"2":{}}}')).toEqual([
      { key: "10", value: { command: "tool", args: ["a"], env: { TOKEN: "secret" }, startup_timeout_sec: 42 } },
      { key: "2", value: {} },
    ]);
  });

  it.each([
    " ", "null", "[]", "true", '{"mcpServers":[]}', '{"mcpServers":null}',
    '{"mcpServers":{"a":false}}', '{"mcpServers":{"a":[]}}', '{"mcpServers":{"a":null}}',
    '{"mcpServers":{}} trailing', '{"mcpServers":{},}', '{/*secret*/"mcpServers":{}}',
    '{"x":1,"x":2}', '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"a":{},"a":{}}}', '{"mcpServers":{"a":{},"\\u0061":{}}}',
    '{"mcpServers":{},"\\u006dcpServers":{}}',
  ])("rejects invalid or ambiguous documents without input-bearing errors: %s", (content) => {
    expectCode(() => readMcpEntries(content), "mcp.invalidDocument");
    expectCode(() => patchMcpEntry(content, null, "new", "{}"), "mcp.invalidDocument");
    expectCode(() => removeMcpEntry(content, "a"), "mcp.invalidDocument");
  });

  it("replaces only the chosen object, preserving escaped key spelling, separators and unrelated bytes", () => {
    const prefix = '{\r\n\t"root": {"n": 9007199254740993, "escape":"\\u0041\\/"},\r\n\t"mcpServers": {\r\n\t\t"\\u0061" \t: ';
    const suffix = ',\r\n\t\t"b": {"n":1.2300e+04,"path":"C:\\\\tools","unknown":[1,true]}\r\n\t},\r\n\t"after":-0\r\n}\r\n';
    const object = '{"command":"new","env":{"TOKEN":"secret"},"startup_timeout_sec":7}';
    const result = patchMcpEntry(prefix + '{"old":true}' + suffix, "a", "a", ` \n${object}\n `);
    expect(result).toBe(prefix + object + suffix);
    expect(JSON.parse(result).mcpServers.a).toEqual(JSON.parse(object));
  });

  it("renames in place without reordering or normalizing the supplied object text", () => {
    const source = '{"mcpServers":{"first":{}, "old" \t: {"old":1}, "last":{}},"unknown":1e+20}';
    const object = '{"n":9007199254740993,"s":"\\u0041","unknown":{"enabled":true}}';
    expect(patchMcpEntry(source, "old", "new name:v1", object)).toBe(
      '{"mcpServers":{"first":{}, "new name:v1" \t: ' + object + ', "last":{}},"unknown":1e+20}',
    );
  });

  it.each(["", " ", "a  b", " a", "a ", "a/b", "a\tb", "a\nb", "é", "a".repeat(101)])("rejects invalid key %j", (key) => {
    expectCode(() => patchMcpEntry("", null, key, "{}"), "mcp.invalidKey");
  });

  it.each(["a", "A_z.0:-", "a b:c-d", "a".repeat(100)])("accepts valid key %j", (key) => {
    expect(readMcpEntries(patchMcpEntry("", null, key, "{}"))).toEqual([{ key, value: {} }]);
  });

  it.each(["", "null", "[]", '"secret"', "1", '{"secret":}', '{"x":1,}', '{/*secret*/}'])('rejects non-object or non-strict object JSON %j', (object) => {
    expectCode(() => patchMcpEntry("", null, "a", object), "mcp.invalidObject");
  });

  it("rejects duplicate additions/renames and absent edits/deletes", () => {
    const content = '{"mcpServers":{"a":{},"b":{}}}';
    expectCode(() => patchMcpEntry(content, null, "a", "{}"), "mcp.duplicateKey");
    expectCode(() => patchMcpEntry(content, "a", "b", "{}"), "mcp.duplicateKey");
    expectCode(() => patchMcpEntry(content, "missing", "c", "{}"), "mcp.missingEntry");
    expectCode(() => patchMcpEntry("", "missing", "c", "{}"), "mcp.missingEntry");
    expectCode(() => removeMcpEntry(content, "missing"), "mcp.missingEntry");
    expectCode(() => removeMcpEntry("", "missing"), "mcp.missingEntry");
    expectCode(() => removeMcpEntry('{"other":1}', "missing"), "mcp.missingEntry");
    expect(patchMcpEntry(content, "a", "a", '{"new":true}')).toBe('{"mcpServers":{"a":{"new":true},"b":{}}}');
  });

  it.each(["", "{}", '{"other":1.2300e+04}', '{"mcpServers":{}}', '{"mcpServers":{   }}'])("adds to missing files, missing maps, and empty maps: %s", (content) => {
    const result = patchMcpEntry(content, null, "new", '{"command":"tool","unknown":{"a":true}}');
    expect(JSON.parse(result).mcpServers).toEqual({ new: { command: "tool", unknown: { a: true } } });
    if (content.includes("1.2300e+04")) expect(result).toContain('"other":1.2300e+04');
  });

  it("appends after the last server without touching siblings or closing whitespace", () => {
    const source = '{\r\n\t"mcpServers": {\r\n\t\t"a": {"n":1e+04}\r\n\t},\r\n\t"unknown":"\\u0041"\r\n}\r\n';
    const result = patchMcpEntry(source, null, "b", '{"command":"tool"}');
    expect(result).toBe(source.replace('{"n":1e+04}', '{"n":1e+04},\r\n\t\t"b": {"command":"tool"}'));
    expect(Object.keys(JSON.parse(result).mcpServers)).toEqual(["a", "b"]);
  });

  it.each([
    '{\r\n\t"mcpServers": {\r\n\t}\r\n}',
    '{\r\n\t"other": 1\r\n}',
    '{\n  "mcpServers": {\n  }\n}',
  ])("keeps newline conventions when adding to multiline empty/missing maps: %j", (content) => {
    const result = patchMcpEntry(content, null, "new", "{}");
    expect(JSON.parse(result).mcpServers).toEqual({ new: {} });
    if (content.includes("\r\n")) expect(result.replaceAll("\r\n", "")).not.toContain("\n");
    expect(result.endsWith(content.slice(content.lastIndexOf("}")))).toBe(true);
  });

  it.each([
    ["a", '{"mcpServers":{  \n "b":{"n":1e+03}, \n "c":{}\n},"outside":9007199254740993}'],
    ["b", '{"mcpServers":{ "a":{}, \n  \n "c":{}\n},"outside":9007199254740993}'],
    ["c", '{"mcpServers":{ "a":{}, \n "b":{"n":1e+03} \n \n},"outside":9007199254740993}'],
  ])("removes %s from first/middle/last position, consuming only its span and one comma", (key, expected) => {
    const source = '{"mcpServers":{ "a":{}, \n "b":{"n":1e+03}, \n "c":{}\n},"outside":9007199254740993}';
    const result = removeMcpEntry(source, key);
    expect(result).toBe(expected);
    const wanted = JSON.parse(source);
    delete wanted.mcpServers[key];
    expect(JSON.parse(result)).toEqual(wanted);
  });

  it("removes the sole entry while leaving an empty map and every surrounding byte intact", () => {
    const source = '{\r\n\t"mcpServers": {\r\n\t\t"only": {"args":[",", "}"]}\r\n\t},\r\n\t"other":true\r\n}\r\n';
    const result = removeMcpEntry(source, "only");
    expect(result).toBe(source.replace('"only": {"args":[",", "}"]}', ""));
    expect(JSON.parse(result)).toEqual({ mcpServers: {}, other: true });
  });
});
