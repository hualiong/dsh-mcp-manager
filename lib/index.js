// src/index.ts
import { existsSync as existsSync2 } from "node:fs";

// src/shared.ts
var MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
var MCP_OAUTH_CLIENT_PACKAGE = "@dsh-external/dsh-oauth-mcp-client";
var MCP_CLIENT_PACKAGES = [
  MCP_CLIENT_PACKAGE,
  MCP_OAUTH_CLIENT_PACKAGE
];
var RPC_CHANNEL = "/mcp-manager";

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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
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
function ownerPackageOf(entry, fallback) {
  return typeof entry["name"] === "string" ? entry["name"] : fallback;
}
function addMcpRow(rows, id, config) {
  return [
    ...rows,
    { insert: [{ id, name: MCP_CLIENT_PACKAGE, config: rowConfigFor(MCP_CLIENT_PACKAGE, config) }] }
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
function updateMcpConfig(rows, id, config, fallbackPackage = MCP_CLIENT_PACKAGE) {
  const found = locate(rows, id);
  if (found === void 0) {
    return [
      ...rows,
      { id, name: fallbackPackage, config: rowConfigFor(fallbackPackage, config) }
    ];
  }
  const current = found.kind === "row" ? found.row : found.item;
  return rewriteLocated(rows, found, (entry) => ({
    ...entry,
    config: rowConfigFor(ownerPackageOf(entry, fallbackPackage), config, current.config)
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
    env: isRecord2(cfg["env"]) ? cfg["env"] : void 0,
    cwd: typeof cfg["cwd"] === "string" ? cfg["cwd"] : void 0,
    headers: isRecord2(cfg["headers"]) ? cfg["headers"] : void 0,
    toolCallTimeoutMs: typeof cfg["toolCallTimeoutMs"] === "number" ? cfg["toolCallTimeoutMs"] : void 0,
    failOnStartupError: typeof cfg["failOnStartupError"] === "boolean" ? cfg["failOnStartupError"] : void 0,
    reconnect: isRecord2(cfg["reconnect"]) ? cfg["reconnect"] : void 0,
    credentialRef: typeof cfg["credentialRef"] === "string" ? cfg["credentialRef"] : void 0,
    scope: typeof cfg["scope"] === "string" ? cfg["scope"] : void 0,
    callbackPort: typeof cfg["callbackPort"] === "number" ? cfg["callbackPort"] : void 0,
    authorizationTimeoutMs: typeof cfg["authorizationTimeoutMs"] === "number" ? cfg["authorizationTimeoutMs"] : void 0
  };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord2(file)) return toServerConfig(entryConfig, oauth);
  return toServerConfig({ ...isRecord2(entryConfig) ? entryConfig : {}, ...file }, oauth);
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

// src/probe.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
var PROBE_TIMEOUT_MS = 8e3;
async function probeServer(config) {
  const started = Date.now();
  const client = new Client(
    { name: "dsh-mcp-manager-probe", version: "0.1.0" },
    { capabilities: {} }
  );
  let transport;
  const finish = (result) => ({ ...result, latencyMs: Date.now() - started });
  const withTimeout = (promise) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
  try {
    if (config.transport === "stdio") {
      transport = new StdioClientTransport({
        command: config.command ?? "",
        args: config.args,
        env: { ...config.env ?? {} },
        cwd: config.cwd
      });
    } else {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url ?? ""),
        { requestInit: { headers: config.headers ?? {} } }
      );
    }
    await withTimeout(client.connect(transport));
    const tools = await withTimeout(client.listTools());
    const toolCount = Array.isArray(tools?.tools) ? tools.tools.length : 0;
    return finish({ ok: true, toolCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ ok: false, error: message });
  } finally {
    try {
      await client.close();
    } catch {
    }
  }
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
    const transport = config.transport === "stdio" ? "stdio" : "streamable-http";
    if (transport === "streamable-http") {
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
var OAUTH_PROBE_ERROR = "OAuth-protected MCP server: a bare probe cannot complete the browser authorization flow, so reachability was not tested \u2014 read the live connection status instead.";
var ENDPOINT_SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/;
function apply(ctx, rawConfig) {
  const patchFile = resolvePatchPath(rawConfig?.patchFile);
  const logger = ctx.logger("mcp-manager");
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: RPC_CHANNEL,
      handler: (req, res) => handleRequest(ctx, patchFile, req, res)
    }),
    "mcp-manager: http route"
  );
  logger.info("mcp-manager active (patch file: %s)", patchFile);
}
async function handleRequest(ctx, patchFile, req, res) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== void 0) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? "unauthorized" : "forbidden");
    return;
  }
  const endpoint = req.method === "POST" ? endpointOf(req.url) : void 0;
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
    result = await dispatch(ctx, patchFile, endpoint, payload);
  } catch (error) {
    result = fail("internal", error instanceof Error ? error.message : String(error));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}
function endpointOf(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return void 0;
  }
  if (!pathname.startsWith(`${RPC_CHANNEL}/`)) return void 0;
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
  if (!isRecord3(body) || !("payload" in body)) {
    throw new Error('request body must be a JSON object carrying a "payload" field');
  }
  return body["payload"];
}
async function dispatch(ctx, patchFile, endpoint, payload) {
  switch (endpoint) {
    case "list": {
      const servers = listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile)));
      return ok({ servers });
    }
    case "patchInfo": {
      return ok({ patch: { path: patchFile, exists: existsSync2(patchFile) } });
    }
    case "add": {
      const params = upsertParams(payload);
      if (params === void 0) return badRequest();
      const { id, config } = params;
      const errors = validateMcpConfig(id, config);
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
      const rows = editPatchList(patchFile, (current) => addMcpRow(current, id, config));
      const row = listMcpServers(ctx, readMcpPatchRows(rows)).find((server) => server.id === id);
      return ok(row === void 0 ? { added: id } : { added: id, row });
    }
    case "remove": {
      const id = readId(payload);
      if (id === void 0) return badRequest();
      editPatchList(patchFile, (rows) => removeMcpRow(rows, id));
      return ok({ removed: id });
    }
    case "setEnabled": {
      const id = readId(payload);
      const enabled = isRecord3(payload) ? payload["enabled"] : void 0;
      if (id === void 0 || typeof enabled !== "boolean") return badRequest();
      const owner = findMcpServer(ctx, id)?.ownerPackage;
      editPatchList(patchFile, (rows) => setMcpEnabled(rows, id, enabled, owner));
      return ok({ id, enabled });
    }
    case "update": {
      const params = upsertParams(payload);
      if (params === void 0) return badRequest();
      const { id, config } = params;
      const owner = findMcpServer(ctx, id)?.ownerPackage ?? MCP_CLIENT_PACKAGE;
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
      editPatchList(patchFile, (rows) => updateMcpConfig(rows, id, config, owner));
      return ok({ updated: id });
    }
    case "probe": {
      const id = readId(payload);
      if (id === void 0) return badRequest();
      const entry = findMcpServer(ctx, id);
      if (entry === void 0) {
        return fail("not-found", `No MCP server entry with id "${id}"`);
      }
      if (entry.ownerPackage === MCP_OAUTH_CLIENT_PACKAGE) {
        const skipped = {
          ok: false,
          skipped: true,
          latencyMs: 0,
          error: OAUTH_PROBE_ERROR
        };
        return ok(skipped);
      }
      const result = await probeServer(entry.config);
      return ok(result);
    }
    default: {
      const unhandled = endpoint;
      return fail("unknown-endpoint", `Unknown endpoint ${String(unhandled)}`);
    }
  }
}
function upsertParams(payload) {
  const id = readId(payload);
  const config = isRecord3(payload) ? payload["config"] : void 0;
  if (id === void 0 || !isRecord3(config)) return void 0;
  return { id, config };
}
function readId(payload) {
  const id = isRecord3(payload) ? payload["id"] : void 0;
  return typeof id === "string" && id !== "" ? id : void 0;
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export {
  apply,
  handleRequest,
  inject,
  name
};
//# sourceMappingURL=index.js.map
