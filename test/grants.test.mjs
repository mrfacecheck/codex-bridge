import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const grants = await import("../dist/grants.js").catch(() => null);

test("grants module exposes gate + shadow-home functions", () => {
  assert.ok(grants);
  for (const f of ["normalizeGrants", "gateGrantsStatic", "gateGrantsAgainstServers", "extractServerBlocks", "listMcpServers", "resolveMcpHome", "GrantRejection"])
    assert.equal(typeof grants[f], "function", f);
});

test("normalizeGrants dedups, trims, defaults empty", () => {
  assert.deepEqual(grants.normalizeGrants(undefined), { mcp: [] });
  assert.deepEqual(grants.normalizeGrants({ mcp: [" you ", "you", "", "rea"] }), { mcp: ["you", "rea"] });
});

test("static gate rejects forbidden classes", () => {
  for (const bad of ["computer-use", "node_repl", "codex_app", "cua_repl", "dispatch", "osascript", "seat_probe", "desktop", "terminal"])
    assert.throws(() => grants.gateGrantsStatic({ mcp: [bad] }), grants.GrantRejection, bad);
  assert.throws(() => grants.gateGrantsStatic({ mcp: ["bad name!"] }), grants.GrantRejection);
  assert.doesNotThrow(() => grants.gateGrantsStatic({ mcp: ["you", "heroui-pro"] }));
});

test("extractServerBlocks pulls verbatim sections incl. env subtable", () => {
  const toml = `[plugins."x"]\nenabled = true\n\n[mcp_servers.you]\ncommand = "u"\n\n[mcp_servers.node_repl]\ncommand = "n"\n\n[mcp_servers.node_repl.env]\nA = "1"\n\n[projects."/x"]\ntrust_level = "trusted"\n`;
  const b = grants.extractServerBlocks(toml);
  assert.ok(b.get("you").includes('command = "u"'));
  assert.ok(b.get("node_repl").includes('A = "1"'), "env subtable rides along");
  assert.equal(b.has("projects"), false);
});

test("resolveMcpHome live: zero grants → empty surface; granted kept; ungranted absent", () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "cb-grants-"));
  try {
    const none = grants.resolveMcpHome(grants.normalizeGrants({ mcp: [] }), "/tmp", runDir);
    assert.equal(none.probe.length, 0, "zero-grant shadow must have zero MCP");

    const some = grants.resolveMcpHome(grants.normalizeGrants({ mcp: ["you"] }), "/tmp", runDir);
    assert.deepEqual(some.probe.map((p) => p.name), ["you"]);
    assert.equal(some.probe[0].enabled, true);
    const cfg = readFileSync(path.join(some.codexHome, "config.toml"), "utf8");
    assert.ok(cfg.includes("[mcp_servers.you]"));
    assert.ok(!cfg.includes("[mcp_servers.node_repl]"), "ungranted server must not be copied");

    assert.throws(() => grants.resolveMcpHome(grants.normalizeGrants({ mcp: ["nope-not-a-server"] }), "/tmp", runDir), grants.GrantRejection);
    assert.throws(() => grants.resolveMcpHome(grants.normalizeGrants({ mcp: ["computer-use"] }), "/tmp", runDir), grants.GrantRejection);
    // node_repl carries a credential-adjacent env table → rejected
    assert.throws(() => grants.resolveMcpHome(grants.normalizeGrants({ mcp: ["node_repl"] }), "/tmp", runDir), grants.GrantRejection);
    // cua_repl is plugin-provided, not in config.toml → rejected as unknown
    assert.throws(() => grants.resolveMcpHome(grants.normalizeGrants({ mcp: ["cua_repl"] }), "/tmp", runDir), grants.GrantRejection);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("GrantRejection details shape", () => {
  try { grants.gateGrantsStatic({ mcp: ["computer-use"] }); assert.fail("should throw"); }
  catch (e) { assert.equal(e.toDetails().code, "grant_rejected"); assert.equal(e.toDetails().rejected[0].server, "computer-use"); }
});

test("extractServerBlocks cx141 ruling §2: multi-line arrays/strings cannot fake headers", () => {
  const toml = [
    '[mcp_servers.you]',
    'command = "u"',
    'args = [',
    '  "search",',
    '  "[mcp_servers.evil]",  # a string value starting with [ must not split the block',
    ']',
    'note = """',
    '[mcp_servers.fake]',
    'command = "x"',
    '"""',
    '',
    '[mcp_servers.firecrawl]',
    'command = "f"',
  ].join("\n");
  const b = grants.extractServerBlocks(toml);
  const you = b.get("you");
  assert.ok(you.includes('"search"') && you.includes('note = """'), "multi-line values stay in the block");
  assert.ok(!b.has("evil") && !b.has("fake"), "bracketed strings are not headers");
  assert.ok(b.get("firecrawl").includes('command = "f"'), "next real section still parsed");
});

test("extractServerBlocks cx141 ruling §2: array-of-tables + name prefixes + quoted names", () => {
  const toml = [
    '[mcp_servers.foo]',
    'command = "a"',
    '',
    '[mcp_servers.foo-bar]',
    'command = "b"',
    '',
    '[mcp_servers.foo.env]',
    'K = "1"',
    '',
    '[mcp_servers."weird name"]',
    'command = "w"',
  ].join("\n");
  const b = grants.extractServerBlocks(toml);
  assert.ok(b.has("foo") && b.has("foo-bar"), "same-prefix names are distinct");
  assert.ok(b.get("foo").includes('K = "1"'), "env subtable attributed to foo not foo-bar");
  assert.ok(b.has("weird name"), "quoted server name extracted");
  assert.ok(!b.get("foo").includes('command = "b"'));
});

test("extractServerBlocks cx141 ruling §2: dotted-key servers stay invisible (fail closed)", () => {
  const toml = 'mcp_servers.foo.command = "a"\nmcp_servers.foo.args = ["x"]\n';
  const b = grants.extractServerBlocks(toml);
  assert.equal(b.has("foo"), false, "top-level dotted-key form must not synthesize a block");
});

test("extractServerBlocks cx172: multi-line string opener cannot leak `[` into depth", () => {
  for (const q of ['"""', "'''"]) {
    const toml = ["[mcp_servers.a]", `x = ${q}abc [`, "still string ]]] [", q, "", "[mcp_servers.b]", 'command = "b"'].join("\n");
    const b = grants.extractServerBlocks(toml);
    assert.ok(b.has("b"), `real header after ${q} string must not be swallowed`);
    assert.ok(!b.get("a").includes('command = "b"'), "b body not attributed to a");
  }
});

test("extractServerBlocks cx172: one-line triple-quoted, comments, and closer-then-bracket", () => {
  const toml = [
    "[mcp_servers.a]",
    'y = """q [ """',
    "z = 1 # it's \"\"\" [ not a string",
    'args = [ """x [',
    '""", "k"',
    "]",
    "[mcp_servers.b]",
    'command = "b"',
  ].join("\n");
  const b = grants.extractServerBlocks(toml);
  assert.ok(b.has("b"), "depth returns to 0 after array closed past a multi-line string");
  assert.ok(b.get("a").includes('""", "k"'), "string continuation stays in a");
});

test("extractServerBlocks cx172: fake header inside multi-line string still ignored", () => {
  const toml = ['[mcp_servers.a]', 'd = """', '[mcp_servers.evil]', 'command = "e"', '"""', '[mcp_servers.b]', 'command = "b"'].join("\n");
  const b = grants.extractServerBlocks(toml);
  assert.equal(b.has("evil"), false);
  assert.ok(b.has("b"));
});
