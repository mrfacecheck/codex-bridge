/**
 * Worker MCP capability grants (ppx-fleet cx137 / capability-surface §G3).
 *
 * Workers default to a ZERO MCP surface. Only servers listed in grants.mcp are
 * provisioned. Enforcement is whitelist-based via a shadow CODEX_HOME: the worker
 * runs with CODEX_HOME=<runDir>/mcp-home whose config.toml contains only the
 * granted servers' verbatim [mcp_servers.*] sections. Plugin-provided servers
 * (codex_app, cua_repl) and all ungranted config servers are absent by
 * construction — verified on codex-cli 0.166.0: empty CODEX_HOME config yields
 * an empty `mcp list`, and `-c mcp_servers.<name>.enabled=false` cannot disable
 * plugin servers (invalid transport).
 *
 * Fail closed: any gate failure throws GrantRejection before the worker spawns;
 * the post-write probe must find exactly the granted set enabled or the run is
 * rejected.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { CODEX_BINARY, buildCodexEnv } from "./evidence.js";

export interface McpServerInfo { name: string; enabled: boolean; env: Record<string, unknown>; envVars: string[]; hasHttpSecrets: boolean }
export interface Grants { mcp: string[] }

const FORBIDDEN_NAME_RE = /(computer[-_]?use|cua[-_]?repl|node[-_]?repl|codex[-_]?app|codex[-_]?(dispatch|await|bridge|exec)|dispatch|osascript|applescript|seat[-_]?probe|desktop|shell|terminal|bash)/i;
const SECRET_VAR_RE = /(key|token|secret|passw|credential|auth|cookie|session)/i;
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const REAL_CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), ".codex");

export class GrantRejection extends Error {
  constructor(public reasons: { server: string; reason: string }[]) {
    super(`grants.mcp rejected: ${reasons.map((r) => `${r.server}: ${r.reason}`).join("; ")}`);
  }
  toDetails() { return { code: "grant_rejected", rejected: this.reasons }; }
}

export function normalizeGrants(g?: { mcp?: string[] }): Grants {
  return { mcp: [...new Set((g?.mcp ?? []).map((s) => s.trim()).filter(Boolean))] };
}

export function gateGrantsStatic(grants: Grants): void {
  const bad: { server: string; reason: string }[] = [];
  for (const n of grants.mcp) {
    if (!SAFE_NAME_RE.test(n)) bad.push({ server: n, reason: "invalid server name" });
    else if (FORBIDDEN_NAME_RE.test(n)) bad.push({ server: n, reason: "forbidden class (delegation/desktop/exec/credential)" });
  }
  if (bad.length) throw new GrantRejection(bad);
}

export function listMcpServers(codexHome?: string): McpServerInfo[] {
  const env = codexHome ? { ...buildCodexEnv(), CODEX_HOME: codexHome } : buildCodexEnv();
  const r = spawnSync(CODEX_BINARY, ["mcp", "list", "--json"], { encoding: "utf8", env, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`codex mcp list failed (exit ${r.status})`);
  const t = r.stdout ?? "";
  const i = t.indexOf("[");
  if (i < 0) throw new Error("codex mcp list: no JSON array");
  return (JSON.parse(t.slice(i)) as any[]).map((s) => {
    const tr = s.transport ?? {};
    return {
      name: String(s.name), enabled: s.enabled !== false,
      env: tr.env && typeof tr.env === "object" ? tr.env : {},
      envVars: Array.isArray(tr.env_vars) ? tr.env_vars.map(String) : [],
      hasHttpSecrets: Boolean(tr.bearer_token_env_var || (tr.http_headers && Object.keys(tr.http_headers).length) || (tr.env_http_headers && Object.keys(tr.env_http_headers).length)),
    };
  });
}

export function gateGrantsAgainstServers(grants: Grants, servers: McpServerInfo[]): void {
  const bad: { server: string; reason: string }[] = [];
  const byName = new Map(servers.map((s) => [s.name, s]));
  for (const n of grants.mcp) {
    const s = byName.get(n);
    if (!s) { bad.push({ server: n, reason: "unknown server" }); continue; }
    if (Object.keys(s.env).length) bad.push({ server: n, reason: "carries env table (credential-adjacent)" });
    else if (s.envVars.some((v) => SECRET_VAR_RE.test(v))) bad.push({ server: n, reason: "forwards secret-named env vars" });
    else if (s.hasHttpSecrets) bad.push({ server: n, reason: "carries http auth material" });
  }
  if (bad.length) throw new GrantRejection(bad);
}

/** Extract verbatim [mcp_servers.<name>] sections (incl. .env subtables) from a config.toml. */
export function extractServerBlocks(configToml: string): Map<string, string> {
  const serverOfPath = (p: string): string | null => {
    if (!p.startsWith("mcp_servers.")) return null;
    const rest = p.slice("mcp_servers.".length);
    if (rest.startsWith('"')) { const e = rest.indexOf('"', 1); return e > 0 ? rest.slice(1, e) : null; }
    const e = rest.search(/[.\s]/);
    return (e < 0 ? rest : rest.slice(0, e)) || null;
  };
  // cx141 ruling §2: multi-line tracking — a `[`-leading line inside a multi-line
  // array or multi-line string is a VALUE line, not a section header.
  // cx172 (cx165 R3): strings and comments are consumed by ONE char-level lexer whose
  // state (multi-line string mode) carries across lines, BEFORE any bracket is
  // counted. The old regex pre-strip paired the first two quotes of `"""`, so
  // `x = """abc [` leaked a `[` into depth that never returned to 0 and swallowed
  // every later real header.
  let mode: "none" | "basic" | "literal" = "none"; // inside """ (basic) / ''' (literal)
  const bracketDelta = (line: string): number => {
    let d = 0;
    let i = 0;
    while (i < line.length) {
      if (mode !== "none") {
        const q = mode === "basic" ? '"' : "'";
        if (mode === "basic" && line[i] === "\\") { i += 2; continue; }
        if (line.startsWith(q + q + q, i)) {
          i += 3;
          for (let extra = 0; extra < 2 && line[i] === q; extra++) i++; // TOML allows """"" closers
          mode = "none";
          continue;
        }
        i++;
        continue;
      }
      const c = line[i];
      if (c === "#") break; // comment: rest of line ignored
      if (line.startsWith('"""', i)) { mode = "basic"; i += 3; continue; }
      if (line.startsWith("'''", i)) { mode = "literal"; i += 3; continue; }
      if (c === '"') { i++; while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1; i++; continue; }
      if (c === "'") { const e = line.indexOf("'", i + 1); i = e < 0 ? line.length : e + 1; continue; }
      if (c === "[") d++;
      else if (c === "]") d--;
      i++;
    }
    return d;
  };
  const blocks = new Map<string, string[]>();
  let cur: string | null = null;
  let depth = 0; // >0 inside a multi-line array
  for (const line of configToml.split("\n")) {
    const m = depth === 0 && mode === "none" ? line.match(/^\s*\[+\s*([^\]]+)\]+/) : null;
    if (m) {
      cur = serverOfPath(m[1].trim());
      if (cur && !blocks.has(cur)) blocks.set(cur, []);
      if (cur) blocks.get(cur)!.push(line);
      continue; // header line: balanced, nothing to track
    }
    if (cur) blocks.get(cur)!.push(line);
    depth += bracketDelta(line); // string/comment content never reaches the counter
    if (depth < 0) depth = 0;
  }
  return new Map([...blocks].map(([k, v]) => [k, v.join("\n").trimEnd()]));
}

/**
 * Build a shadow CODEX_HOME under runDir containing ONLY the granted servers.
 * Returns { codexHome, probe }. Throws GrantRejection/Error before touching the
 * filesystem when gating fails; throws when the post-write probe leaks or drops.
 */
export function resolveMcpHome(grants: Grants, runCwd: string, runDir: string): { codexHome: string; probe: { name: string; enabled: boolean }[] } {
  gateGrantsStatic(grants);
  const servers = listMcpServers();
  gateGrantsAgainstServers(grants, servers);

  const realConfig = path.join(REAL_CODEX_HOME, "config.toml");
  const blocks = existsSync(realConfig) ? extractServerBlocks(readFileSync(realConfig, "utf8")) : new Map<string, string>();
  const missing = grants.mcp.filter((n) => !blocks.has(n));
  if (missing.length) throw new GrantRejection(missing.map((n) => ({ server: n, reason: "not defined in config.toml (plugin or unknown)" })));

  const codexHome = path.join(runDir, "mcp-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const auth = path.join(REAL_CODEX_HOME, "auth.json");
  const authDest = path.join(codexHome, "auth.json");
  if (existsSync(auth) && !existsSync(authDest)) symlinkSync(auth, authDest);

  const parts = [`[projects.${JSON.stringify(runCwd)}]`, `trust_level = "trusted"`];
  for (const n of grants.mcp) parts.push("", blocks.get(n)!);
  writeFileSync(path.join(codexHome, "config.toml"), parts.join("\n") + "\n", { mode: 0o600 });

  const probe = listMcpServers(codexHome).map((s) => ({ name: s.name, enabled: s.enabled }));
  const granted = new Set(grants.mcp);
  const leaked = probe.filter((p) => !granted.has(p.name)).map((p) => p.name);
  const dropped = grants.mcp.filter((n) => !probe.some((p) => p.name === n && p.enabled));
  if (leaked.length || dropped.length) {
    const reasons = [
      ...leaked.map((n) => ({ server: n, reason: "leaked into shadow home" })),
      ...dropped.map((n) => ({ server: n, reason: "grant not effective in shadow home" })),
    ];
    throw new GrantRejection(reasons);
  }
  return { codexHome, probe };
}
