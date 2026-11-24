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
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { CODEX_BINARY, CODEX_BINARY_REALPATH, buildCodexEnv } from "./evidence.js";

export interface McpServerInfo { name: string; enabled: boolean; env: Record<string, unknown>; envVars: string[]; hasHttpSecrets: boolean }
export interface Grants { mcp: string[] }

const FORBIDDEN_NAME_RE = /(computer[-_]?use|cua[-_]?repl|node[-_]?repl|codex[-_]?app|codex[-_]?(dispatch|await|bridge|exec)|dispatch|osascript|applescript|seat[-_]?probe|desktop|shell|terminal|bash)/i;
const SECRET_VAR_RE = /(key|token|secret|passw|credential|auth|cookie|session)/i;
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const SAFE_DEFAULT_KEYS = new Set([
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
  "model_provider",
]);

function realCodexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

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

export function listMcpServers(codexHome?: string, cwd?: string): McpServerInfo[] {
  const env = codexHome ? { ...buildCodexEnv(), CODEX_HOME: codexHome } : buildCodexEnv();
  const useCwd = cwd && existsSync(cwd) ? cwd : undefined;
  const r = spawnSync(CODEX_BINARY, ["mcp", "list", "--json"], {
    encoding: "utf8",
    env,
    timeout: 30_000,
    ...(useCwd ? { cwd: useCwd } : {}),
  });
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

export interface CliCapabilityProbe {
  binary: string;
  binaryIdentity: string;
  version: string | null;
  mcpListSupported: boolean;
}

const capabilityProbeCache = new Map<string, CliCapabilityProbe>();

export function probeCodexCapabilities(): CliCapabilityProbe {
  const target = CODEX_BINARY_REALPATH || CODEX_BINARY;
  let identity = target;
  try {
    const st = statSync(target);
    identity = `${target}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {}
  const cached = capabilityProbeCache.get(identity);
  if (cached) return cached;

  const env = buildCodexEnv();
  const ver = spawnSync(CODEX_BINARY, ["--version"], { encoding: "utf8", env, timeout: 10_000 });
  const version = ver.status === 0 ? ((ver.stdout || ver.stderr || "").trim() || null) : null;
  let mcpListSupported = false;
  try {
    listMcpServers();
    mcpListSupported = true;
  } catch {}

  const probe: CliCapabilityProbe = { binary: CODEX_BINARY, binaryIdentity: identity, version, mcpListSupported };
  capabilityProbeCache.set(identity, probe);
  return probe;
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

/**
 * Char-level TOML multi-line string / array depth tracker (cx141 §2 + cx172).
 * Strings and comments are consumed in one pass so bracketed text inside
 * multi-line strings or comments never spoofs a table header or leaks `[` depth.
 */
function createTomlTracker() {
  let mode: "none" | "basic" | "literal" = "none";
  let depth = 0;
  return {
    isTopLevel(): boolean { return depth === 0 && mode === "none"; },
    advance(line: string): void {
      let i = 0;
      while (i < line.length) {
        if (mode !== "none") {
          const q = mode === "basic" ? '"' : "'";
          if (mode === "basic" && line[i] === "\\") { i += 2; continue; }
          if (line.startsWith(q + q + q, i)) {
            i += 3;
            for (let extra = 0; extra < 2 && line[i] === q; extra++) i++;
            mode = "none";
            continue;
          }
          i++;
          continue;
        }
        const c = line[i];
        if (c === "#") break;
        if (line.startsWith('"""', i)) { mode = "basic"; i += 3; continue; }
        if (line.startsWith("'''", i)) { mode = "literal"; i += 3; continue; }
        if (c === '"') { i++; while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1; i++; continue; }
        if (c === "'") { const e = line.indexOf("'", i + 1); i = e < 0 ? line.length : e + 1; continue; }
        if (c === "[") depth++;
        else if (c === "]") depth--;
        i++;
      }
      if (depth < 0) depth = 0;
    },
  };
}

function tableKeyUnder(headerPath: string, prefix: string): string | null {
  if (!headerPath.startsWith(prefix)) return null;
  const rest = headerPath.slice(prefix.length);
  if (rest.startsWith('"')) {
    const e = rest.indexOf('"', 1);
    return e > 0 ? rest.slice(1, e) : null;
  }
  if (rest.startsWith("'")) {
    const e = rest.indexOf("'", 1);
    return e > 0 ? rest.slice(1, e) : null;
  }
  const e = rest.search(/[.\s]/);
  return (e < 0 ? rest : rest.slice(0, e)) || null;
}

/** Extract verbatim [mcp_servers.<name>] sections (incl. .env subtables) from a config.toml. */
export function extractServerBlocks(configToml: string): Map<string, string> {
  const tracker = createTomlTracker();
  const blocks = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of configToml.split("\n")) {
    const m = tracker.isTopLevel() ? line.match(/^\s*\[+\s*([^\]]+)\]+/) : null;
    if (m) {
      cur = tableKeyUnder(m[1].trim(), "mcp_servers.");
      if (cur && !blocks.has(cur)) blocks.set(cur, []);
      if (cur) blocks.get(cur)!.push(line);
      continue;
    }
    if (cur) blocks.get(cur)!.push(line);
    tracker.advance(line);
  }
  return new Map([...blocks].map(([k, v]) => [k, v.join("\n").trimEnd()]));
}

/**
 * Extract ONLY safe, non-capability model execution defaults from a user's real
 * config.toml so shadow CODEX_HOME honors model/effort/service_tier/model_provider
 * without inheriting plugins, marketplaces, notify hooks, sandbox overrides, or
 * ungranted MCP servers.
 */
export function extractSafeCodexDefaults(configToml: string): {
  topLevelLines: string[];
  providerName?: string;
  providerBlock?: string;
} {
  const tracker = createTomlTracker();
  const topLevelLines: string[] = [];
  let providerName: string | undefined;
  let inTable = false;

  for (const line of configToml.split("\n")) {
    const m = tracker.isTopLevel() ? line.match(/^\s*\[+\s*([^\]]+)\]+/) : null;
    if (m) { inTable = true; break; }
    if (!inTable && tracker.isTopLevel()) {
      const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
      if (kv && SAFE_DEFAULT_KEYS.has(kv[1])) {
        const val = kv[2];
        // Fail closed on multi-line / structured values for scalar model keys
        if (!val.startsWith("[") && !val.startsWith("{") && !val.startsWith('"""') && !val.startsWith("'''")) {
          topLevelLines.push(line.trim());
          if (kv[1] === "model_provider") {
            const pm = val.match(/^"([^"]+)"|^'([^']+)'/);
            if (pm) providerName = pm[1] ?? pm[2];
          }
        }
      }
    }
    tracker.advance(line);
  }

  let providerBlock: string | undefined;
  if (providerName) {
    const pTracker = createTomlTracker();
    const collected: string[] = [];
    let capturing = false;
    for (const line of configToml.split("\n")) {
      const m = pTracker.isTopLevel() ? line.match(/^\s*\[+\s*([^\]]+)\]+/) : null;
      if (m) {
        const matched = tableKeyUnder(m[1].trim(), "model_providers.");
        capturing = matched === providerName;
        if (capturing) collected.push(line);
        continue;
      }
      if (capturing) collected.push(line);
      pTracker.advance(line);
    }
    if (collected.length) providerBlock = collected.join("\n").trimEnd();
  }

  return { topLevelLines, providerName, providerBlock };
}

/**
 * Build a shadow CODEX_HOME under runDir containing ONLY the granted servers
 * plus safe model/provider execution defaults.
 * Returns { codexHome, probe }. Throws GrantRejection/Error before touching the
 * filesystem when gating fails; throws when the post-write probe leaks or drops.
 */
export function resolveMcpHome(grants: Grants, runCwd: string, runDir: string): { codexHome: string; probe: { name: string; enabled: boolean }[] } {
  gateGrantsStatic(grants);
  const home = realCodexHome();
  const realConfig = path.join(home, "config.toml");
  const rawConfig = existsSync(realConfig) ? readFileSync(realConfig, "utf8") : "";

  let blocks = new Map<string, string>();
  if (grants.mcp.length > 0) {
    const servers = listMcpServers();
    gateGrantsAgainstServers(grants, servers);
    blocks = rawConfig ? extractServerBlocks(rawConfig) : new Map<string, string>();
    const missing = grants.mcp.filter((n) => !blocks.has(n));
    if (missing.length) throw new GrantRejection(missing.map((n) => ({ server: n, reason: "not defined in config.toml (plugin or unknown)" })));
  }

  const safeDefaults = rawConfig ? extractSafeCodexDefaults(rawConfig) : { topLevelLines: [] };

  const codexHome = path.join(runDir, "mcp-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const auth = path.join(home, "auth.json");
  const authDest = path.join(codexHome, "auth.json");
  if (existsSync(auth) && !existsSync(authDest)) symlinkSync(auth, authDest);

  const sections: string[] = [];
  if (safeDefaults.topLevelLines.length) sections.push(safeDefaults.topLevelLines.join("\n"));
  if (safeDefaults.providerBlock) sections.push(safeDefaults.providerBlock);
  sections.push(`[projects.${JSON.stringify(runCwd)}]\ntrust_level = "trusted"`);
  for (const n of grants.mcp) sections.push(blocks.get(n)!);
  writeFileSync(path.join(codexHome, "config.toml"), sections.join("\n\n") + "\n", { mode: 0o600 });

  const granted = new Set(grants.mcp);
  // Defense-in-depth: fail closed if the target repo carries a project-level .codex/config.toml
  // declaring ungranted MCP servers (could otherwise be loaded by Codex CLI when cwd is trusted).
  const projectCodexConfig = path.join(runCwd, ".codex", "config.toml");
  if (existsSync(projectCodexConfig)) {
    try {
      const projToml = readFileSync(projectCodexConfig, "utf8");
      const projServers = extractServerBlocks(projToml);
      const ungrantedProj = [...projServers.keys()].filter((n) => !granted.has(n));
      if (ungrantedProj.length > 0) {
        throw new GrantRejection(ungrantedProj.map((n) => ({ server: n, reason: "project .codex/config.toml injects ungranted MCP server" })));
      }
    } catch (e) {
      if (e instanceof GrantRejection) throw e;
    }
  }

  const probe = listMcpServers(codexHome, runCwd).map((s) => ({ name: s.name, enabled: s.enabled }));
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
