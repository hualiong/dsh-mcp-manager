// src/index.ts
import { existsSync as existsSync3 } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname2, join as join3 } from "node:path";

// src/shared.ts
var MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
var MCP_OAUTH_CLIENT_PACKAGE = "@hualiong/dsh-oauth-mcp-client";
var MCP_CLIENT_PACKAGES = [
  MCP_CLIENT_PACKAGE,
  MCP_OAUTH_CLIENT_PACKAGE
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var RPC_CHANNEL = "/mcp-manager";
var EVENT_CHANNEL = `${RPC_CHANNEL}/events`;
var EVENT_CHANGED = "changed";
var EVENT_READY = "ready";

// src/detect.ts
var PROBE_TIMEOUT_MS = 5e3;
async function detectOAuth(url, headers = {}) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json, text/event-stream", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    const challenge = response.headers.get("www-authenticate") ?? "";
    const verdict = response.status === 401 && /^bearer/i.test(challenge) ? "oauth" : "plain";
    try {
      await response.body?.cancel();
    } catch {
    }
    return verdict;
  } catch {
    return "unreachable";
  }
}

// src/patch.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
function isJsExpr(value) {
  return value instanceof Object && "__jsExpr" in value;
}
function resolveDshHome(configured) {
  if (configured !== void 0 && configured.trim() !== "") return configured.trim();
  const env = process.env["DSH_HOME"];
  if (env !== void 0 && env.trim() !== "") return env.trim();
  return join(homedir(), ".dsh");
}
var JsExprType = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (data) => typeof data === "string",
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data["__jsExpr"]
});
var ENTRY_LIST_SCHEMA = yaml.JSON_SCHEMA.extend(JsExprType);
var PATCH_HEADER = `# MCP servers managed by the dsh-mcp-manager plugin.
# Format: a top-level YAML array of loader patch entries (\`!!js\` expressions
# allowed). Edit here, or use the MCP Manager panel in the web GUI.
`;
var PLUGIN_CONFIG_KEYS = {
  [MCP_CLIENT_PACKAGE]: [
    "serverName",
    "transport",
    "url",
    "command",
    "args",
    "env",
    "cwd",
    "headers",
    "toolCallTimeoutMs",
    "failOnStartupError",
    "reconnect"
  ],
  [MCP_OAUTH_CLIENT_PACKAGE]: [
    "serverName",
    "url",
    "credentialRef",
    "scope",
    "headers",
    "callbackPort",
    "authorizationTimeoutMs",
    "toolCallTimeoutMs",
    "failOnStartupError",
    "reconnect"
  ]
};
function rowConfigFor(ownerPackage, config, current) {
  const keys = PLUGIN_CONFIG_KEYS[ownerPackage] ?? PLUGIN_CONFIG_KEYS[MCP_CLIENT_PACKAGE];
  const incoming = config;
  const source = ownerPackage !== MCP_CLIENT_PACKAGE && isRecord(current) ? { ...current, ...incoming } : incoming;
  const out = {};
  for (const key of keys) {
    if (source[key] !== void 0) out[key] = source[key];
  }
  if (ownerPackage === MCP_CLIENT_PACKAGE && out["transport"] === void 0) {
    out["transport"] = "streamable-http";
  }
  return out;
}
function resolvePatchPath(configured) {
  if (configured !== void 0 && configured.trim() !== "") return configured.trim();
  return join(resolveDshHome(), "profiles", "web", "cordis.patch.yml");
}
function readPatchList(file) {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  const trimmed = content.trim();
  if (trimmed === "") return [];
  const parsed = yaml.load(content, { schema: ENTRY_LIST_SCHEMA });
  if (parsed === void 0 || parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error(`patch file ${file} must be a top-level array`);
  return parsed;
}
function writePatchList(file, rows) {
  const body = rows.length > 0 ? yaml.dump(rows, { schema: ENTRY_LIST_SCHEMA, lineWidth: 120 }) : "[]\n";
  writeFileSync(file, `${PATCH_HEADER}${body}`, "utf8");
}
function editPatchList(file, edit) {
  const next = edit(readPatchList(file));
  writePatchList(file, next);
  return next;
}
function locate(rows, id) {
  for (const row of rows) {
    if (row.id === id) return { kind: "row", row };
    if (Array.isArray(row.insert)) {
      const item = row.insert.find((entry) => entry["id"] === id);
      if (item !== void 0) return { kind: "insert", row, item };
    }
  }
  return void 0;
}
function rewriteLocated(rows, found, next) {
  if (found === void 0) return rows;
  if (found.kind === "row") {
    return rows.map((row) => row === found.row ? next(row) : row);
  }
  return rows.map(
    (row) => row === found.row ? { ...row, insert: row.insert.map((item) => item === found.item ? next(item) : item) } : row
  );
}
function addMcpRow(rows, id, config, ownerPackage = MCP_CLIENT_PACKAGE) {
  return [
    ...rows,
    { insert: [{ id, name: ownerPackage, config: rowConfigFor(ownerPackage, config) }] }
  ];
}
function removeMcpRow(rows, id) {
  const next = [];
  for (const row of rows) {
    if (row.id === id) continue;
    if (Array.isArray(row.insert)) {
      const filtered = row.insert.filter((item) => item["id"] !== id);
      if (filtered.length === 0) continue;
      next.push({ ...row, insert: filtered });
      continue;
    }
    next.push(row);
  }
  return next;
}
function setMcpEnabled(rows, id, enabled, fallbackPackage = MCP_CLIENT_PACKAGE) {
  const found = locate(rows, id);
  if (found === void 0) {
    return [...rows, { id, name: fallbackPackage, disabled: !enabled }];
  }
  return rewriteLocated(rows, found, (entry) => ({ ...entry, disabled: !enabled }));
}
function updateMcpConfig(rows, id, config, ownerPackage = MCP_CLIENT_PACKAGE) {
  const found = locate(rows, id);
  if (found === void 0) {
    return [
      ...rows,
      { id, name: ownerPackage, config: rowConfigFor(ownerPackage, config) }
    ];
  }
  const current = found.kind === "row" ? found.row : found.item;
  return rewriteLocated(rows, found, (entry) => ({
    ...entry,
    name: ownerPackage,
    config: rowConfigFor(ownerPackage, config, current.config)
  }));
}
function namesMcpBridge(entry) {
  const name2 = entry["name"];
  return name2 === void 0 || typeof name2 === "string" && MCP_CLIENT_PACKAGES.includes(name2);
}
function toMcpPatchRow(entry, id) {
  const name2 = entry["name"];
  return {
    id,
    ownerPackage: typeof name2 === "string" ? name2 : "",
    config: entry["config"],
    disabled: typeof entry["disabled"] === "boolean" ? entry["disabled"] : void 0
  };
}
function readMcpPatchRows(rows) {
  const out = [];
  for (const row of rows) {
    if (typeof row.id === "string" && namesMcpBridge(row)) out.push(toMcpPatchRow(row, row.id));
    if (!Array.isArray(row.insert)) continue;
    for (const item of row.insert) {
      const id = item["id"];
      if (typeof id === "string" && namesMcpBridge(item)) out.push(toMcpPatchRow(item, id));
    }
  }
  return out;
}

// src/status.ts
function normalizeEntryId(id) {
  return id.startsWith("include:") ? id.slice("include:".length) : id;
}
var FIBER_PHASE = [
  "pending",
  "loading",
  "active",
  "failed",
  null,
  "unloading"
];
function toServerConfig(raw, oauth) {
  const cfg = raw ?? {};
  return {
    serverName: typeof cfg["serverName"] === "string" ? cfg["serverName"] : "",
    // The OAuth bridge always speaks streamable-http and has no transport field.
    transport: oauth ? "streamable-http" : cfg["transport"] === "stdio" ? "stdio" : "streamable-http",
    url: typeof cfg["url"] === "string" ? cfg["url"] : void 0,
    command: typeof cfg["command"] === "string" ? cfg["command"] : void 0,
    args: Array.isArray(cfg["args"]) ? cfg["args"] : void 0,
    env: isRecord(cfg["env"]) ? cfg["env"] : void 0,
    cwd: typeof cfg["cwd"] === "string" ? cfg["cwd"] : void 0,
    headers: isRecord(cfg["headers"]) ? cfg["headers"] : void 0,
    toolCallTimeoutMs: typeof cfg["toolCallTimeoutMs"] === "number" ? cfg["toolCallTimeoutMs"] : void 0,
    failOnStartupError: typeof cfg["failOnStartupError"] === "boolean" ? cfg["failOnStartupError"] : void 0,
    reconnect: isRecord(cfg["reconnect"]) ? cfg["reconnect"] : void 0,
    credentialRef: typeof cfg["credentialRef"] === "string" ? cfg["credentialRef"] : void 0,
    scope: typeof cfg["scope"] === "string" ? cfg["scope"] : void 0,
    callbackPort: typeof cfg["callbackPort"] === "number" ? cfg["callbackPort"] : void 0,
    authorizationTimeoutMs: typeof cfg["authorizationTimeoutMs"] === "number" ? cfg["authorizationTimeoutMs"] : void 0
  };
}
function countServerTools(ctx, serverName) {
  if (serverName === "") return 0;
  const prefix = `mcp__${serverName}__`;
  let count = 0;
  for (const schema of ctx.tools.schemas()) {
    if (schema.name.startsWith(prefix)) count += 1;
  }
  return count;
}
function listMcpServers(ctx, fileRows = []) {
  const byId = new Map(fileRows.map((row) => [row.id, row]));
  const servers = [];
  const composed = /* @__PURE__ */ new Set();
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    const ownerPackage = entry.options.name;
    if (!MCP_CLIENT_PACKAGES.includes(ownerPackage)) continue;
    const id = normalizeEntryId(entry.id);
    const oauth = ownerPackage === MCP_OAUTH_CLIENT_PACKAGE;
    const live = toServerConfig(entry.options.config, oauth);
    const fileRow = byId.get(id);
    composed.add(id);
    servers.push({
      ...reportedConfig(entry.options.config, fileRow, oauth),
      id,
      ownerPackage,
      enabled: fileEnabled(fileRow?.disabled, !entry.disabled),
      fiberPhase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state] ?? null,
      // Tools belong to the running bridge, so count them under the name the
      // live entry still runs, not the name the file was just edited to.
      toolCount: countServerTools(ctx, live.serverName),
      userManaged: fileRow !== void 0
    });
  }
  for (const row of fileRows) {
    if (composed.has(row.id) || row.ownerPackage === "") continue;
    const oauth = row.ownerPackage === MCP_OAUTH_CLIENT_PACKAGE;
    const config = toServerConfig(row.config, oauth);
    if (config.serverName === "") continue;
    servers.push({
      ...config,
      id: row.id,
      ownerPackage: row.ownerPackage,
      // No live fiber yet, so the file row is the only source of intent.
      enabled: fileEnabled(row.disabled, true),
      fiberPhase: null,
      toolCount: 0,
      userManaged: true
    });
  }
  return servers;
}
function fileEnabled(fileDisabled, liveEnabled) {
  return fileDisabled === void 0 ? liveEnabled : !fileDisabled;
}
function reportedConfig(entryConfig, fileRow, oauth) {
  const file = fileRow?.config;
  if (!isRecord(file)) return toServerConfig(entryConfig, oauth);
  return toServerConfig({ ...isRecord(entryConfig) ? entryConfig : {}, ...file }, oauth);
}
function findMcpServer(ctx, id) {
  const wanted = normalizeEntryId(id);
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    const ownerPackage = entry.options.name;
    if (!MCP_CLIENT_PACKAGES.includes(ownerPackage)) continue;
    if (normalizeEntryId(entry.id) !== wanted) continue;
    return {
      ownerPackage,
      config: toServerConfig(entry.options.config, ownerPackage === MCP_OAUTH_CLIENT_PACKAGE)
    };
  }
  return void 0;
}
function serverNameTaken(ctx, serverName, exceptId) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    if (!MCP_CLIENT_PACKAGES.includes(entry.options.name)) continue;
    if (exceptId !== void 0 && normalizeEntryId(entry.id) === exceptId) continue;
    const raw = entry.options.config ?? {};
    if (raw["serverName"] === serverName) return true;
  }
  return false;
}
function entryIdTaken(ctx, id, exceptId) {
  for (const entry of ctx.loader.entries()) {
    if (normalizeEntryId(entry.id) === id && entry.id !== exceptId) return true;
  }
  return false;
}

// src/validate.ts
var SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
var ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isOAuthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  const scheme = url.protocol === "https:" || url.protocol === "http:" && loopback;
  return scheme && url.username === "" && url.password === "";
}
function hasAuthorizationHeader(headers) {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}
function validateMcpConfig(id, config, ownerPackage = MCP_CLIENT_PACKAGE) {
  const errors = {};
  if (!ENTRY_ID_RE.test(id)) {
    errors["id"] = "Entry id must match [A-Za-z0-9_-]{1,64}";
  }
  if (typeof config.serverName !== "string" || !SERVER_NAME_RE.test(config.serverName)) {
    errors["serverName"] = "serverName must match [A-Za-z0-9_-]{1,32}";
  }
  if (ownerPackage === MCP_OAUTH_CLIENT_PACKAGE) {
    if (config.transport === "stdio") {
      errors["transport"] = "stdio is not supported by the OAuth bridge";
    }
    if (typeof config.url !== "string" || !isOAuthUrl(config.url)) {
      errors["url"] = "An https:// URL is required (http:// only for loopback)";
    }
    if (config.credentialRef !== void 0 && (typeof config.credentialRef !== "string" || config.credentialRef.trim() === "")) {
      errors["credentialRef"] = "credentialRef must be a non-empty string";
    }
    if (config.scope !== void 0 && (typeof config.scope !== "string" || config.scope.trim() === "")) {
      errors["scope"] = "scope must not be empty";
    }
    if (config.callbackPort !== void 0 && (!Number.isInteger(config.callbackPort) || config.callbackPort < 0 || config.callbackPort > 65535)) {
      errors["callbackPort"] = "callbackPort must be an integer from 0 through 65535";
    }
    if (config.authorizationTimeoutMs !== void 0 && (typeof config.authorizationTimeoutMs !== "number" || config.authorizationTimeoutMs < 1)) {
      errors["authorizationTimeoutMs"] = "authorizationTimeoutMs must be a positive number";
    }
    if (isStringRecord(config.headers) && hasAuthorizationHeader(config.headers)) {
      errors["headers"] = "headers.Authorization is owned by OAuth and must not be set";
    }
  } else {
    const transport = config.transport;
    if (transport !== "stdio" && transport !== "streamable-http") {
      errors["transport"] = "transport must be stdio or streamable-http";
    } else if (transport === "streamable-http") {
      if (typeof config.url !== "string" || !/^https?:\/\/.+/.test(config.url)) {
        errors["url"] = "A valid http(s):// URL is required for streamable-http";
      }
    } else {
      if (typeof config.command !== "string" || config.command.trim() === "") {
        errors["command"] = "An executable command is required for stdio";
      }
      if (config.args !== void 0 && !Array.isArray(config.args)) {
        errors["args"] = "args must be an array of strings";
      }
      if (config.cwd !== void 0 && typeof config.cwd !== "string") {
        errors["cwd"] = "cwd must be a string";
      }
    }
  }
  if (config.env !== void 0 && !isStringRecord(config.env)) {
    errors["env"] = "env must be a string-to-string map";
  }
  if (config.headers !== void 0 && !isStringRecord(config.headers)) {
    errors["headers"] = "headers must be a string-to-string map";
  }
  if (config.toolCallTimeoutMs !== void 0 && (typeof config.toolCallTimeoutMs !== "number" || config.toolCallTimeoutMs < 1)) {
    errors["toolCallTimeoutMs"] = "toolCallTimeoutMs must be a positive number";
  }
  return errors;
}
function isStringRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

// src/policy.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join2 } from "node:path";
var POLICY_FILE_NAME = "mcp-manager.policy.json";
function policyPathOf(patchFile) {
  return join2(dirname(patchFile), POLICY_FILE_NAME);
}
function canonicalize(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const serverId of Object.keys(raw).sort()) {
    const cells = raw[serverId];
    if (serverId === "" || !isRecord(cells)) continue;
    const row = {};
    let any = false;
    for (const presetId of Object.keys(cells).sort()) {
      if (presetId === "" || cells[presetId] !== false) continue;
      row[presetId] = false;
      any = true;
    }
    if (any) out[serverId] = row;
  }
  return out;
}
function loadPolicy(file) {
  let raw;
  try {
    if (!existsSync2(file)) return {};
    raw = JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return {};
  }
  return canonicalize(raw);
}
function savePolicy(file, policy) {
  const canonical = canonicalize(policy);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync2(tmp, `${JSON.stringify(canonical, null, 2)}
`, "utf8");
  renameSync(tmp, file);
  return canonical;
}
function setPresetVisible(file, serverId, presetId, visible) {
  const policy = loadPolicy(file);
  if (serverId === "" || presetId === "") return policy;
  if ((policy[serverId]?.[presetId] ?? true) === visible) return policy;
  if (visible) {
    const row = policy[serverId];
    if (row !== void 0) {
      delete row[presetId];
      if (Object.keys(row).length === 0) delete policy[serverId];
    }
  } else {
    policy[serverId] = { ...policy[serverId], [presetId]: false };
  }
  return savePolicy(file, policy);
}
function dropServerFromPolicy(file, serverId) {
  const policy = loadPolicy(file);
  if (policy[serverId] === void 0) return policy;
  delete policy[serverId];
  return savePolicy(file, policy);
}

// src/visibility.ts
function readAgentPresets(ctx) {
  const svc = ctx.get("agentPresets");
  if (svc === void 0 || svc === null) return void 0;
  if (typeof svc.compositionInventory !== "function" || typeof svc.composedPreset !== "function") {
    return void 0;
  }
  return svc;
}
function hiddenServerNames(presetId, servers, policy) {
  if (presetId === void 0) return [];
  const names = /* @__PURE__ */ new Set();
  for (const server of servers) {
    if (server.serverName === "") continue;
    if (policy[server.id]?.[presetId] === false) names.add(server.serverName);
  }
  return [...names].sort();
}
function createVisibilityManager(ctx, options) {
  const logger = ctx.logger("mcp-manager");
  const entries = /* @__PURE__ */ new Map();
  const unsubscribers = [];
  let stopped = false;
  let mutating = false;
  const release = (lift) => {
    try {
      if (typeof lift === "function") lift();
      else lift.dispose();
      return true;
    } catch (error) {
      logger.warn("mcp-manager: visibility mask cleanup failed: %s", String(error));
      return false;
    }
  };
  const clear = (entry) => {
    const pending = entry.lifts.splice(0);
    const failed = [];
    for (const lift of pending) {
      if (!release(lift)) failed.push(lift);
    }
    entry.lifts.push(...failed);
  };
  const scopedNames = (agent) => {
    const tools = ctx.tools;
    return tools.schemas(agent).map((schema) => schema.name);
  };
  const expand = (hidden, names) => {
    if (hidden.length === 0) return [];
    const prefixes = hidden.map((serverName) => `mcp__${serverName}__`);
    return names.filter((name2) => prefixes.some((prefix) => name2.startsWith(prefix))).sort();
  };
  const report = (entry, message) => {
    if (entry.reported === message) return;
    entry.reported = message;
    logger.warn("mcp-manager: %s", message);
  };
  const publish = (agent, entry, hidden) => {
    clear(entry);
    const deny = expand(hidden, scopedNames(agent));
    if (deny.length === 0) {
      entry.applied = true;
      entry.reported = void 0;
      return;
    }
    const restrict = entry.ctx.tools?.restrict;
    if (typeof restrict !== "function") {
      entry.applied = false;
      report(entry, `cannot mask ${hidden.join(", ")}: this agent scope exposes no tools.restrict()`);
      return;
    }
    try {
      const lift = restrict.call(entry.ctx.tools, { deny });
      entry.applied = true;
      entry.reported = void 0;
      if (lift === void 0) {
        report(entry, "tools.restrict() returned no disposer; this mask can only be lifted by the scope teardown");
      } else {
        entry.lifts.push(lift);
      }
    } catch (error) {
      entry.applied = false;
      report(entry, `visibility mask failed: ${String(error)}`);
    }
  };
  const align = (agent, entry, presetId, servers, policy) => {
    const hidden = hiddenServerNames(presetId, servers, policy);
    const rowJson = JSON.stringify(hidden);
    if (rowJson !== entry.rowJson || !entry.applied) {
      entry.rowJson = rowJson;
      publish(agent, entry, hidden);
      return;
    }
    if (hidden.length === 0) return;
    if (expand(hidden, scopedNames(agent)).length === 0) return;
    publish(agent, entry, hidden);
  };
  const reconcile = () => {
    if (stopped || mutating || entries.size === 0) return;
    mutating = true;
    try {
      const svc = readAgentPresets(ctx);
      let servers;
      let policy;
      try {
        servers = options.listServers();
        policy = options.policy();
      } catch (error) {
        logger.warn("mcp-manager: visibility reconcile skipped, state unreadable: %s", String(error));
        return;
      }
      for (const [agent, entry] of entries) {
        let presetId;
        try {
          presetId = svc?.composedPreset(entry.ctx);
        } catch (error) {
          report(entry, `preset identity unreadable: ${String(error)}`);
          continue;
        }
        try {
          align(agent, entry, presetId, servers, policy);
        } catch (error) {
          report(entry, `visibility reconcile failed: ${String(error)}`);
        }
      }
    } finally {
      mutating = false;
    }
  };
  const attach = (agent) => {
    if (stopped || typeof agent !== "object" || agent === null || entries.has(agent)) return;
    const scope = agent.ctx;
    if (typeof scope !== "object" || scope === null) return;
    entries.set(agent, { ctx: scope, lifts: [], rowJson: "", applied: false });
  };
  const detach = (agent) => {
    if (typeof agent !== "object" || agent === null) return;
    const entry = entries.get(agent);
    if (entry === void 0) return;
    entries.delete(agent);
    const wasMutating = mutating;
    mutating = true;
    try {
      clear(entry);
    } finally {
      mutating = wasMutating;
    }
  };
  const subscribe = (event, handler) => {
    const on = ctx.on;
    const off = on(event, handler);
    if (typeof off === "function") unsubscribers.push(off);
  };
  subscribe("agent/created", ({ agent }) => {
    attach(agent);
    reconcile();
  });
  subscribe("agent/disposed", ({ agent }) => {
    detach(agent);
  });
  subscribe("tools/change", () => {
    reconcile();
  });
  ctx.effect(() => () => {
    stopped = true;
    mutating = true;
    for (const entry of entries.values()) clear(entry);
    entries.clear();
    for (const off of unsubscribers.splice(0)) {
      try {
        off();
      } catch {
      }
    }
  }, "mcp-manager: preset visibility");
  try {
    const agents = ctx.get("agents");
    for (const agent of agents?.list?.() ?? []) attach(agent);
  } catch (error) {
    logger.warn("mcp-manager: could not enumerate live agents at boot: %s", String(error));
  }
  reconcile();
  return { reconcile };
}

// src/prompt-align.ts
var MCP_SECTION_PREFIX = "mcp:";
var RESOURCE_SECTION = "mcp-resource-servers";
var RESOURCE_TEXT_HEADER = "## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ";
var RESOURCE_TOOLS = /* @__PURE__ */ new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource"
]);
var NOTHING_HIDDEN = /* @__PURE__ */ new Set();
function alignSection(section, hidden) {
  if (typeof section?.name !== "string") return section;
  if (section.name.startsWith(MCP_SECTION_PREFIX)) {
    return hidden.has(section.name.slice(MCP_SECTION_PREFIX.length)) ? void 0 : section;
  }
  if (section.name !== RESOURCE_SECTION) return section;
  const text = rewriteResourceText(section.text, hidden);
  if (text === section.text) return section;
  if (text === void 0) return void 0;
  return { ...section, text };
}
function rewriteResourceText(text, hidden) {
  if (typeof text !== "string" || !text.startsWith(RESOURCE_TEXT_HEADER) || !text.endsWith(".")) {
    return text;
  }
  let names;
  try {
    names = JSON.parse(text.slice(RESOURCE_TEXT_HEADER.length, -1));
  } catch {
    return text;
  }
  if (!Array.isArray(names) || !names.every((entry) => typeof entry === "string")) return text;
  const visible = names.filter((serverName) => !hidden.has(serverName));
  if (visible.length === names.length) return text;
  if (visible.length === 0) return void 0;
  return `${RESOURCE_TEXT_HEADER}${JSON.stringify(visible)}.`;
}
function serverArgument(exec) {
  const args = exec?.arguments;
  if (!isRecord(args)) return void 0;
  const server = args["server"];
  return typeof server === "string" && server !== "" ? server : void 0;
}
function createPromptAlignment(ctx, options) {
  const logger = ctx.logger("mcp-manager");
  const presets = () => options.presets ? options.presets() : readAgentPresets(ctx);
  let stopped = false;
  let lastWarned = "";
  const warn = (message) => {
    if (lastWarned === message) return;
    lastWarned = message;
    logger.warn("mcp-manager: %s", message);
  };
  const hiddenForScope = (identity) => {
    if (stopped || typeof identity !== "object" || identity === null) return void 0;
    const svc = presets();
    if (svc === void 0) return void 0;
    const scoped = identity.ctx ?? identity;
    let presetId;
    try {
      presetId = svc.composedPreset(scoped);
    } catch (error) {
      warn(`prompt alignment skipped, preset identity unreadable: ${String(error)}`);
      return void 0;
    }
    if (typeof presetId !== "string" || presetId === "") return void 0;
    let policy;
    try {
      policy = options.policy();
    } catch (error) {
      warn(`prompt alignment skipped, state unreadable: ${String(error)}`);
      return void 0;
    }
    let touched = false;
    for (const row of Object.values(policy)) {
      if (row[presetId] === false) {
        touched = true;
        break;
      }
    }
    if (!touched) return NOTHING_HIDDEN;
    try {
      return new Set(hiddenServerNames(presetId, options.listServers(), policy));
    } catch (error) {
      warn(`prompt alignment skipped, state unreadable: ${String(error)}`);
      return void 0;
    }
  };
  const assemble = async (assembly, context, next) => {
    const result = await next();
    const hidden = hiddenForScope(context?.scope);
    if (hidden === void 0 || hidden.size === 0) return result;
    if (!Array.isArray(result?.sections)) return result;
    let rewritten = false;
    const sections = [];
    for (const section of result.sections) {
      const aligned = alignSection(section, hidden);
      if (aligned === void 0) {
        rewritten = true;
        continue;
      }
      if (aligned !== section) rewritten = true;
      sections.push(aligned);
    }
    if (!rewritten) return result;
    return { ...result, sections };
  };
  const preExecute = async (exec, next) => {
    if (stopped || typeof exec?.name !== "string" || !RESOURCE_TOOLS.has(exec.name)) return next();
    const server = serverArgument(exec);
    if (server === void 0) return next();
    const hidden = hiddenForScope(exec.agent);
    if (hidden === void 0 || !hidden.has(server)) return next();
    return {
      kind: "deny",
      reason: `MCP server "${server}" is hidden for this agent's preset (dsh-mcp-manager visibility matrix).`,
      info: { name: "McpVisibility", code: "server-hidden-for-preset" }
    };
  };
  const on = ctx.on;
  const offs = [
    on("system-prompt/assemble", assemble),
    on("tools/pre-execute", preExecute)
  ];
  ctx.effect(() => () => {
    stopped = true;
    for (const off of offs) {
      if (typeof off !== "function") continue;
      try {
        off();
      } catch {
      }
    }
  }, "mcp-manager: prompt alignment");
}

// src/index.ts
var name = "mcp-manager";
var inject = ["connection", "loader", "tools", "webServer"];
function ok(value) {
  return { ok: true, value };
}
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}
function badRequest() {
  return fail("bad-request", "Malformed payload for this endpoint");
}
var ENDPOINT_SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/;
var EVENT_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  "connection": "keep-alive"
};
var TICK_MS = 1e3;
var PING_TICKS = 20;
var PING_FRAME = ": ping\n\n";
function frame(type) {
  return `data: ${JSON.stringify({ type })}

`;
}
function createChangeChannel(ctx, patchFile) {
  const streams = /* @__PURE__ */ new Set();
  let timer;
  let ticks = 0;
  let signature;
  const stop = () => {
    if (timer === void 0) return;
    clearInterval(timer);
    timer = void 0;
  };
  const write = (payload) => {
    for (const stream of [...streams]) {
      if (stream.destroyed || stream.writableEnded) {
        streams.delete(stream);
        continue;
      }
      try {
        stream.write(payload);
      } catch {
        streams.delete(stream);
      }
    }
    if (streams.size === 0) stop();
  };
  const readSignature = () => {
    try {
      return JSON.stringify(listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile))));
    } catch {
      return void 0;
    }
  };
  const tick = () => {
    try {
      ticks += 1;
      if (ticks % PING_TICKS === 0) write(PING_FRAME);
      const next = readSignature();
      if (next !== void 0 && next !== signature) {
        signature = next;
        write(frame(EVENT_CHANGED));
      }
    } catch (error) {
      ctx.logger.warn("mcp-manager: event stream tick failed: %s", String(error));
    }
  };
  const open = (res) => {
    res.writeHead(200, EVENT_HEADERS);
    try {
      res.write(frame(EVENT_READY));
    } catch {
      res.end();
      return;
    }
    streams.add(res);
    res.on("close", () => {
      streams.delete(res);
      if (streams.size === 0) stop();
    });
    if (streams.size === 1) signature = readSignature();
    if (timer === void 0) timer = setInterval(tick, TICK_MS);
  };
  const close = () => {
    stop();
    const held = [...streams];
    streams.clear();
    for (const stream of held) {
      try {
        stream.end();
      } catch {
      }
    }
  };
  return { open, broadcast: () => write(frame(EVENT_CHANGED)), close };
}
function apply(ctx, rawConfig) {
  const patchFile = resolvePatchPath(rawConfig?.patchFile);
  const logger = ctx.logger("mcp-manager");
  const listServers = () => listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile)));
  const visibility = createVisibilityManager(ctx, {
    listServers,
    policy: () => loadPolicy(policyPathOf(patchFile))
  });
  createPromptAlignment(ctx, {
    listServers,
    policy: () => loadPolicy(policyPathOf(patchFile))
  });
  ctx.effect(() => {
    const channel = createChangeChannel(ctx, patchFile);
    const disposeRoute = ctx.webServer.register({
      kind: "prefix",
      path: RPC_CHANNEL,
      handler: (req, res) => handleRequest(ctx, patchFile, channel, req, res, detectOAuth, visibility)
    });
    return () => {
      channel.close();
      disposeRoute();
    };
  }, "mcp-manager: http route");
  logger.info("mcp-manager active (patch file: %s)", patchFile);
}
async function handleRequest(ctx, patchFile, channel, req, res, probe = detectOAuth, visibility) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== void 0) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? "unauthorized" : "forbidden");
    return;
  }
  const pathname = pathnameOf(req.url);
  if (req.method === "GET" && pathname === EVENT_CHANNEL) {
    channel.open(res);
    return;
  }
  const endpoint = req.method === "POST" ? endpointOf(pathname) : void 0;
  if (endpoint === void 0) {
    res.writeHead(404);
    res.end();
    return;
  }
  let payload;
  try {
    payload = parseEnvelope(await readBody(req));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  let result;
  try {
    result = await dispatch(ctx, patchFile, channel, endpoint, payload, probe, visibility);
  } catch (error) {
    result = fail("internal", error instanceof Error ? error.message : String(error));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}
function pathnameOf(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return void 0;
  }
}
function endpointOf(pathname) {
  if (pathname === void 0 || !pathname.startsWith(`${RPC_CHANNEL}/`)) return void 0;
  const segment = pathname.slice(RPC_CHANNEL.length + 1);
  return ENDPOINT_SEGMENT_RE.test(segment) ? segment : void 0;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function parseEnvelope(text) {
  const body = JSON.parse(text);
  if (!isRecord(body) || !("payload" in body)) {
    throw new Error('request body must be a JSON object carrying a "payload" field');
  }
  return body["payload"];
}
async function resolveOwner(ctx, id, config, probe) {
  const headers = config.headers;
  if (config.transport === "stdio" || isRecord(headers) && hasAuthorizationHeader(headers)) {
    return { ownerPackage: MCP_CLIENT_PACKAGE, probe: "plain" };
  }
  const probeHeaders = isRecord(headers) ? headers : {};
  const verdict = await probe(config.url ?? "", probeHeaders);
  if (verdict === "oauth") return { ownerPackage: MCP_OAUTH_CLIENT_PACKAGE, probe: verdict };
  if (verdict === "unreachable") {
    return {
      ownerPackage: findMcpServer(ctx, id)?.ownerPackage ?? MCP_CLIENT_PACKAGE,
      probe: verdict
    };
  }
  return { ownerPackage: MCP_CLIENT_PACKAGE, probe: verdict };
}
function oauthBridgeInstalled(patchFile) {
  const fromProfile = createRequire(join3(dirname2(patchFile), "noop.js"));
  try {
    fromProfile.resolve(MCP_OAUTH_CLIENT_PACKAGE);
    return true;
  } catch {
    return false;
  }
}
function isBridgeMissing(patchFile, ownerPackage) {
  return ownerPackage === MCP_OAUTH_CLIENT_PACKAGE && !oauthBridgeInstalled(patchFile);
}
function oauthBridgeMarker(ctx, patchFile, ownerPackage) {
  if (!isBridgeMissing(patchFile, ownerPackage)) return {};
  ctx.logger.warn(
    "mcp-manager: %s is not installed in this profile; the row was saved disabled and can be switched on after installing it and restarting DSH",
    MCP_OAUTH_CLIENT_PACKAGE
  );
  return { oauthBridgeMissing: true };
}
async function dispatch(ctx, patchFile, channel, endpoint, payload, probe, visibility) {
  switch (endpoint) {
    case "list": {
      const servers = listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile))).map((server) => isBridgeMissing(patchFile, server.ownerPackage) ? { ...server, bridgeMissing: true } : server);
      const projection = await readPresetProjection(ctx, patchFile);
      if (projection === void 0) return ok({ servers });
      return ok({
        servers: servers.map((server) => ({
          ...server,
          presetPolicy: projectPresetRow(projection.policy, projection.roster, server.id)
        }))
      });
    }
    case "patchInfo": {
      return ok({ patch: { path: patchFile, exists: existsSync3(patchFile) } });
    }
    case "add": {
      const params = upsertParams(payload);
      if (params === void 0) return badRequest();
      const { id, config } = params;
      const { ownerPackage: owner, probe: verdict } = await resolveOwner(ctx, id, config, probe);
      const errors = validateMcpConfig(id, config, owner);
      if (Object.keys(errors).length > 0) {
        return fail("invalid-config", "Invalid MCP server configuration", { fields: errors });
      }
      if (entryIdTaken(ctx, id)) {
        return fail("duplicate-id", `Entry id "${id}" is already in use`);
      }
      if (serverNameTaken(ctx, config.serverName)) {
        return fail(
          "duplicate-server-name",
          `serverName "${config.serverName}" is already used by another MCP server`
        );
      }
      const missing = isBridgeMissing(patchFile, owner);
      editPatchList(patchFile, (rows) => {
        const next = addMcpRow(rows, id, config, owner);
        return missing ? setMcpEnabled(next, id, false, owner) : next;
      });
      channel.broadcast();
      return ok({ added: id, probe: verdict, ...oauthBridgeMarker(ctx, patchFile, owner) });
    }
    case "remove": {
      const id = readId(payload);
      if (id === void 0) return badRequest();
      editPatchList(patchFile, (rows) => removeMcpRow(rows, id));
      dropServerFromPolicy(policyPathOf(patchFile), id);
      visibility?.reconcile();
      channel.broadcast();
      return ok({ removed: id });
    }
    case "setEnabled": {
      const id = readId(payload);
      const enabled = isRecord(payload) ? payload["enabled"] : void 0;
      if (id === void 0 || typeof enabled !== "boolean") return badRequest();
      const owner = findMcpServer(ctx, id)?.ownerPackage;
      if (enabled && owner !== void 0 && isBridgeMissing(patchFile, owner)) {
        return fail(
          "bridge-missing",
          `${MCP_OAUTH_CLIENT_PACKAGE} is not installed in this profile, so this server cannot be enabled yet. Install it, restart DSH, then switch it on.`
        );
      }
      editPatchList(patchFile, (rows) => setMcpEnabled(rows, id, enabled, owner));
      channel.broadcast();
      return ok({ id, enabled });
    }
    case "update": {
      const params = upsertParams(payload);
      if (params === void 0) return badRequest();
      const { id, config } = params;
      const { ownerPackage: owner, probe: verdict } = await resolveOwner(ctx, id, config, probe);
      const errors = validateMcpConfig(id, config, owner);
      if (Object.keys(errors).length > 0) {
        return fail("invalid-config", "Invalid MCP server configuration", { fields: errors });
      }
      if (serverNameTaken(ctx, config.serverName, id)) {
        return fail(
          "duplicate-server-name",
          `serverName "${config.serverName}" is already used by another MCP server`
        );
      }
      const missing = isBridgeMissing(patchFile, owner);
      editPatchList(patchFile, (rows) => {
        const next = updateMcpConfig(rows, id, config, owner);
        return missing ? setMcpEnabled(next, id, false, owner) : next;
      });
      channel.broadcast();
      return ok({ updated: id, probe: verdict, ...oauthBridgeMarker(ctx, patchFile, owner) });
    }
    case "presets": {
      const svc = readAgentPresets(ctx);
      if (svc === void 0) return agentPresetsUnavailable();
      let roster;
      try {
        roster = await svc.compositionInventory();
      } catch (error) {
        return agentPresetsUnavailable(error);
      }
      const presets = roster.map((row) => toPresetInfo(row)).filter((preset) => preset !== void 0);
      return ok({ presets });
    }
    case "setPresetEnabled": {
      const id = readId(payload);
      const presetId = isRecord(payload) ? payload["presetId"] : void 0;
      const enabled = isRecord(payload) ? payload["enabled"] : void 0;
      if (id === void 0 || typeof presetId !== "string" || presetId === "" || typeof enabled !== "boolean") {
        return badRequest();
      }
      const svc = readAgentPresets(ctx);
      if (svc === void 0) return agentPresetsUnavailable();
      let roster;
      try {
        roster = await svc.compositionInventory();
      } catch (error) {
        return agentPresetsUnavailable(error);
      }
      const known = roster.find((preset) => toPresetId(preset) === presetId && !isBrokenPreset(preset));
      if (known === void 0) {
        return fail("preset-not-found", `Preset "${presetId}" is not a managed roster entry`);
      }
      setPresetVisible(policyPathOf(patchFile), id, presetId, enabled);
      visibility?.reconcile();
      channel.broadcast();
      return ok({ id, presetId, enabled });
    }
    default: {
      const unhandled = endpoint;
      return fail("unknown-endpoint", `Unknown endpoint ${String(unhandled)}`);
    }
  }
}
function upsertParams(payload) {
  const id = readId(payload);
  const config = isRecord(payload) ? payload["config"] : void 0;
  if (id === void 0 || !isRecord(config)) return void 0;
  return { id, config };
}
function agentPresetsUnavailable(error) {
  const detail = error === void 0 ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
  return fail("agent-presets-unavailable", `The agentPresets service is not available in this deployment${detail}`);
}
function toPresetId(row) {
  return typeof row?.id === "string" && row.id !== "" ? row.id : void 0;
}
function isBrokenPreset(row) {
  return row["broken"] !== void 0 && row["broken"] !== null;
}
function toPresetInfo(row) {
  const id = toPresetId(row);
  if (id === void 0) return void 0;
  const info = { id, isDefault: row["isDefault"] === true };
  if (typeof row["name"] === "string") info.name = row["name"];
  if (typeof row["description"] === "string") info.description = row["description"];
  if (isBrokenPreset(row)) info.broken = String(row["broken"]);
  return info;
}
async function readPresetProjection(ctx, patchFile) {
  const svc = readAgentPresets(ctx);
  if (svc === void 0) return void 0;
  let roster;
  try {
    roster = (await svc.compositionInventory()).map((row) => toPresetId(row)).filter((id) => id !== void 0);
  } catch {
    return void 0;
  }
  return { roster, policy: loadPolicy(policyPathOf(patchFile)) };
}
function projectPresetRow(policy, roster, serverId) {
  const row = {};
  for (const presetId of roster) row[presetId] = true;
  Object.assign(row, policy[serverId]);
  return row;
}
function readId(payload) {
  const id = isRecord(payload) ? payload["id"] : void 0;
  return typeof id === "string" && id !== "" ? id : void 0;
}
export {
  apply,
  createChangeChannel,
  handleRequest,
  inject,
  name
};
//# sourceMappingURL=index.js.map
